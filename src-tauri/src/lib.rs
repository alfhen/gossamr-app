mod agent;
mod auth;
mod claude;
mod codehost;
mod config;
mod connections;
mod db;
mod display;
mod domain;
mod error;
mod events;
mod inbox;
mod legacy;
mod model;
mod net;
mod notify;
mod probe;
mod proposals;
mod runs;
mod secrets;
mod sync;
mod tracker;
mod wire;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

use auth::{Auth, AuthStatus, DeviceStart, TokenSignIn};
use agent::{AgentService, AskOutcome, AskRequest};
use tracker::Move;
use inbox::{CatalogPage, CodeRef, ConnectionInfo, Core, Edit, Probe, WatchState, WorkstreamView};
use error::Result;
use domain::{
    Comment, Container, DevLink, Event, FeedPage, FeedQuery, Filter, Footprint, Identity, Intent, ItemRef, Proposal, ProposalQuery, PullRequestDetail, Run, RunEvent, RunQuery, Stray,
    WatchChange, WorkItem, Workstream, WorkstreamEvent,
};
use model::Snapshot;
use runs::service::CloneChoice;
use sync::Trigger;
use wire::Topic;

/// How often the scheduler checks whether a sync is due. Waking from sleep is noticed within one tick.
const TICK: Duration = Duration::from_secs(15);
const EVENT_LIMIT: usize = 100;

type CoreState = Arc<Core>;
type AgentState = Arc<AgentService>;
type LauncherState = Arc<dyn runs::launcher::RunLauncher>;
type RunsState = Arc<runs::service::RunService>;

/// Sends the latest snapshot to the window. Failures only mean there is nothing to show yet (e.g. signed out).
async fn publish(app: &AppHandle, core: &Core) {
    let Ok(snap) = core.snapshot().await else { return };
    wire::snapshot(app, snap);
}

#[tauri::command]
fn reduce_transparency() -> bool {
    display::reduce_transparency()
}

#[tauri::command]
fn set_needs_badge(app: AppHandle, count: usize) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_badge_count((count > 0).then_some(count as i64));
    }
}

/// Tells the page the cache changed, so views over it can re-read.
fn cache_changed(app: &AppHandle, connection_id: &str) {
    wire::changed(app, Topic::Cache, connection_id);
}

/// Tells the page a run was created or changed.
fn runs_changed(app: &AppHandle, connection_id: &str) {
    wire::changed(app, Topic::Runs, connection_id);
}

/// Tells the page which work items' code links changed, so it can re-read them.
fn dev_links_changed(app: &AppHandle, connection_id: &str) {
    wire::changed(app, Topic::DevLinks, connection_id);
}

/// Tells the page what is watched changed, so it can re-read the settings along with everything they scope.
fn watch_changed(app: &AppHandle, connection_id: &str) {
    wire::changed(app, Topic::Watch, connection_id);
}

/// Tells the page the stored drafts changed, so it can re-read them.
fn proposals_changed(app: &AppHandle, connection_id: &str) {
    wire::changed(app, Topic::Proposals, connection_id);
}

/// Tells the page a workstream was opened, closed or changed, so it can re-read them.
fn workstreams_changed(app: &AppHandle, connection_id: &str) {
    wire::changed(app, Topic::Workstreams, connection_id);
}

/// A wake turn's event, which no page asked for: sent as `pip` like any turn's, with the conversation it belongs to
/// and `kind: wake`, so the page can show a turn it didn't start.
fn wake_update(app: &AppHandle, conversation: &str, update: agent::Update) {
    let Ok(mut payload) = serde_json::to_value(&update) else { return };
    payload["conversation"] = conversation.into();
    payload["kind"] = "wake".into();
    wire::pip(app, payload);
}

/// Asks the page to narrow the view the person is looking at. It is an event of the turn that asked, with its request id.
fn pip_view(app: &AppHandle, request_id: &str, filter: &domain::Filter, note: &str) {
    wire::pip(app, serde_json::json!({ "requestId": request_id, "type": "view", "filter": filter, "note": note }));
}

/// A system notification chosen by `runs::notices`. Focusing the window soon after opens the run it points at
/// (`open-run`): the top need of the workstream, or the newest run that finished in it, since the notification has no
/// click handler.
/// Whether it was shown.
fn announce_run(app: &AppHandle, open: &runs::tracker::OpenOnFocus, out: &runs::notices::Outgoing) -> bool {
    let shown = app.notification().builder().title(out.notice.title.clone()).body(out.notice.body.clone()).show().is_ok();
    if shown {
        if let Some(run_id) = &out.open_run {
            open.record(run_id, std::time::Instant::now());
        }
    }
    shown
}

struct RunNotices {
    app: AppHandle,
    open: Arc<runs::tracker::OpenOnFocus>,
}

impl runs::tracker::RunNotifier for RunNotices {
    /// Notices aren't made per event; the run service sends them through `announce`.
    fn notify(&self, _run: &Run, _why: runs::tracker::Attention) {}

    fn announce(&self, notice: &runs::notices::Outgoing) -> bool {
        announce_run(&self.app, &self.open, notice)
    }

    fn watching(&self) -> bool {
        self.app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false)
    }
}

/// Looks at `claude agents` every few seconds while a run is under way and the window is in front, and every half
/// minute otherwise; the window gaining focus brings the next look forward. It runs for the life of the app.
fn spawn_run_tracker(app: AppHandle, service: RunsState) {
    tauri::async_runtime::spawn(async move {
        loop {
            let polled = service.poll().await;
            // The poll has let go of the launch lock by now, which each start takes again.
            if let Err(e) = service.launch_waiting().await {
                eprintln!("couldn't start the runs waiting for a slot: {e}");
            }
            let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            let wait = if polled.busy && focused { runs::tracker::POLL_BUSY } else { runs::tracker::POLL_IDLE };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = service.focus.notified() => {}
                _ = service.question_asked() => {}
            }
        }
    });
}

/// After a stop has freed a slot, starts what waits for one on its own task: the stop has let go of the launch lock by
/// now, and each start takes it again.
fn use_freed_slot(service: &RunsState) {
    let service = service.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = service.launch_waiting().await {
            eprintln!("couldn't start the runs waiting for a slot: {e}");
        }
    });
}

#[tauri::command]
async fn auth_status(core: State<'_, CoreState>) -> Result<AuthStatus> {
    core.auth.status().await
}

/// The cloud id a Jira site reports about itself, or `None` when the sheet has to ask for it.
#[tauri::command]
async fn jira_cloud_id(core: State<'_, CoreState>, site: String) -> Result<Option<String>> {
    core.auth.find_cloud_id(&site).await
}

#[tauri::command]
async fn jira_connect(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, input: TokenSignIn) -> Result<AuthStatus> {
    let status = core.connect_jira(&input).await?;
    core.wake.notify_one();
    probe_in_background(&app, &core, Probe::Refresh);
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn(async move { runs.recover().await });
    Ok(status)
}

#[tauri::command]
async fn sign_out(app: AppHandle, core: State<'_, CoreState>) -> Result<()> {
    core.sign_out().await?;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_badge_count(None);
    }
    Ok(())
}

#[tauri::command]
async fn snapshot(core: State<'_, CoreState>) -> Result<Snapshot> {
    core.snapshot().await
}

#[tauri::command]
async fn cache_search(core: State<'_, CoreState>, filter: Filter, include_unwatched: Option<bool>) -> Result<Vec<WorkItem>> {
    core.cache_search(&filter, include_unwatched.unwrap_or(false)).await
}

/// A watched item from the cache. With `live`, any item, read from the tracker without storing it and flagged `unwatched` when its container isn't watched.
#[tauri::command]
async fn cache_item(core: State<'_, CoreState>, item: ItemRef, live: bool) -> Result<Option<WorkItem>> {
    if live {
        core.peek_item(&item).await
    } else {
        core.cache_item(&item).await
    }
}

#[tauri::command]
async fn cache_containers(core: State<'_, CoreState>, include_unwatched: Option<bool>) -> Result<Vec<Container>> {
    core.cache_containers(include_unwatched.unwrap_or(false)).await
}

#[tauri::command]
async fn watch_get(core: State<'_, CoreState>) -> Result<Vec<WatchState>> {
    core.watch_state().await
}

/// Everything the page shows and Pip sees depends on what is watched, so a change tells the page to re-read.
async fn watch_edited(app: &AppHandle, core: &Core, connection_id: &str) {
    watch_changed(app, connection_id);
    cache_changed(app, connection_id);
    publish(app, core).await;
}

/// Adds containers to what a connection watches, removes them, or pins them.
#[tauri::command]
async fn watch_set(app: AppHandle, core: State<'_, CoreState>, connection_id: String, changes: Vec<WatchChange>) -> Result<()> {
    core.watch_set_containers(&connection_id, &changes).await?;
    watch_edited(&app, &core, &connection_id).await;
    Ok(())
}

#[tauri::command]
async fn watch_catalog(core: State<'_, CoreState>, connection_id: String, query: String, cursor: Option<String>) -> Result<CatalogPage> {
    core.watch_catalog(&connection_id, &query, cursor).await
}

#[tauri::command]
async fn watch_suggestions(core: State<'_, CoreState>, connection_id: String, refresh: Option<bool>) -> Result<Vec<Footprint>> {
    core.watch_suggestions(&connection_id, refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn watch_unwatched_assigned(core: State<'_, CoreState>, connection_id: String, refresh: Option<bool>) -> Result<Vec<Stray>> {
    core.watch_unwatched_assigned(&connection_id, refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn watch_dismiss_assigned(core: State<'_, CoreState>, connection_id: String, container_id: String) -> Result<()> {
    core.watch_dismiss_assigned(&connection_id, &container_id).await
}

#[tauri::command]
async fn cache_events(core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<Event>> {
    core.cache_events(&item, EVENT_LIMIT).await
}

#[tauri::command]
async fn cache_feed(core: State<'_, CoreState>, query: FeedQuery) -> Result<FeedPage> {
    core.cache_feed(&query).await
}

#[tauri::command]
async fn cache_feed_unread(core: State<'_, CoreState>, kinds: Option<Vec<domain::EventKind>>) -> Result<usize> {
    core.cache_feed_unread(&kinds.unwrap_or_default()).await
}

#[tauri::command]
async fn cache_me(core: State<'_, CoreState>) -> Result<Identity> {
    core.cache_me().await
}

#[tauri::command]
async fn cache_people(core: State<'_, CoreState>) -> Result<Vec<model::Person>> {
    core.cache_people().await
}

#[tauri::command]
async fn cache_comments(core: State<'_, CoreState>, item: ItemRef, refresh: bool) -> Result<Vec<Comment>> {
    core.cache_comments(&item, refresh).await
}

#[tauri::command]
async fn cache_transitions(core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<Move>> {
    core.cache_transitions(&item).await
}

/// Probes every instance first when `refresh` is set, which is what the refresh button asks for.
#[tauri::command]
async fn connections_list(app: AppHandle, core: State<'_, CoreState>, refresh: bool) -> Result<Vec<ConnectionInfo>> {
    if refresh {
        probe_connections(&app, &core, Probe::Refresh).await;
    }
    core.connections().await
}

/// Asks each instance how it stands, and tells the page about the ones that answered differently.
async fn probe_connections(app: &AppHandle, core: &Core, why: Probe) {
    for connection_id in core.probe_connections(why).await {
        wire::changed(app, wire::Topic::Connections, &connection_id);
    }
}

/// Opens Terminal on the fix the instance's last probe found. The command comes from that snapshot, never from the page.
#[tauri::command(async)]
fn connection_open_terminal(core: State<'_, CoreState>, runs: State<'_, RunsState>, instance_id: String) -> Result<()> {
    runs.open_fix(&core.fix_command(&instance_id)?)
}

/// What `gh` says about itself before any connection exists: the first-run screen's GitHub line.
#[tauri::command]
async fn first_run_github(core: State<'_, CoreState>) -> Result<probe::Snapshot> {
    Ok(core.first_run_github().await)
}

/// Opens Terminal on the fix the first-run screen shows, asked of `gh` again. The command comes from the probe, never from the page.
#[tauri::command]
async fn first_run_open_terminal(core: State<'_, CoreState>, runs: State<'_, RunsState>) -> Result<()> {
    let fix = core.first_run_github().await.fix.ok_or_else(|| error::Error::Input("There's nothing to run. Check again.".into()))?;
    runs.open_fix(&fix)
}

/// Saves the name Settings shows for an instance.
#[tauri::command]
fn connection_rename(app: AppHandle, core: State<'_, CoreState>, instance_id: String, display_name: String) -> Result<()> {
    let connection_id = core.rename_instance(&instance_id, &display_name)?;
    wire::changed(&app, wire::Topic::Connections, &connection_id);
    Ok(())
}

/// Turns an instance on or off, then asks it how it stands: Off for one just turned off, a real answer for one turned on.
#[tauri::command]
async fn connection_set_enabled(app: AppHandle, core: State<'_, CoreState>, instance_id: String, enabled: bool) -> Result<()> {
    let connection_id = core.set_instance_enabled(&instance_id, enabled).await?;
    core.probe_instance_now(&instance_id).await;
    wire::changed(&app, wire::Topic::Connections, &connection_id);
    Ok(())
}

/// Removes a connection instance: its token, cache and open drafts go, and its id is never used again.
#[tauri::command]
async fn connection_remove(app: AppHandle, core: State<'_, CoreState>, instance_id: String) -> Result<()> {
    let removed = core.remove_instance(&instance_id).await?;
    let connection_id = removed.connection_id;
    if let Some(win) = app.get_webview_window("main").filter(|_| removed.kind == tracker::ConnectionKind::Jira) {
        let _ = win.set_badge_count(None);
    }
    wire::changed(&app, wire::Topic::Connections, &connection_id);
    wire::changed(&app, wire::Topic::Cache, &connection_id);
    watch_changed(&app, &connection_id);
    proposals_changed(&app, &connection_id);
    if removed.workstreams {
        workstreams_changed(&app, &connection_id);
    }
    Ok(())
}

fn probe_in_background(app: &AppHandle, core: &CoreState, why: Probe) {
    let (app, core) = (app.clone(), core.clone());
    tauri::async_runtime::spawn(async move { probe_connections(&app, &core, why).await });
}

/// How a GitHub account is connected: a pasted token, the token `gh auth token` prints (run now, because the person
/// asked), or the code `github_device_start` showed once it was authorised in the browser.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "via")]
enum GithubSource {
    Token { token: String },
    GhCli,
    Device,
}

/// Connects the account `source` names, and its repositories become watchable. Device resolves when the code was
/// authorised, or fails when it expired or was denied.
#[tauri::command]
async fn github_connect(app: AppHandle, core: State<'_, CoreState>, source: GithubSource) -> Result<ConnectionInfo> {
    let connected = match source {
        GithubSource::Token { token } => core.github_connect_token(&token).await?,
        GithubSource::GhCli => core.github_import_gh_token().await?,
        GithubSource::Device => core.github_device_poll().await?,
    };
    watch_changed(&app, &connected.id);
    Ok(connected)
}

/// Which ways of connecting GitHub work here: the device flow needs a client id, `gh` must be installed.
#[tauri::command]
fn github_sign_in_options(core: State<'_, CoreState>) -> auth::SignInOptions {
    core.code_sign_in_options()
}

/// Starts the device flow: show `userCode` and open `verificationUri`, then call `github_connect` with `via: device`.
#[tauri::command]
async fn github_device_start(core: State<'_, CoreState>) -> Result<DeviceStart> {
    core.github_device_start().await
}

/// The pull requests, branches and commits that name a work item, from the cache: instant, and only watched repositories.
/// With `live`, searches the watched repositories for the item's key first and caches what it finds.
#[tauri::command]
async fn dev_links(app: AppHandle, core: State<'_, CoreState>, item: ItemRef, live: bool) -> Result<Vec<DevLink>> {
    if !live {
        return core.dev_links(&item);
    }
    let (links, changed) = core.dev_links_live(&item).await?;
    changed.iter().for_each(|id| dev_links_changed(&app, id));
    Ok(links)
}

#[tauri::command]
async fn code_pull_request(core: State<'_, CoreState>, reference: CodeRef) -> Result<PullRequestDetail> {
    core.code_pull_request(&reference).await
}

#[tauri::command]
async fn proposals_list(core: State<'_, CoreState>, query: Option<ProposalQuery>) -> Result<Vec<Proposal>> {
    core.proposals(&query.unwrap_or_default()).await
}

/// Drafts a write the person made by hand. It stays a draft until `proposals_approve`.
#[tauri::command]
async fn proposals_create(app: AppHandle, core: State<'_, CoreState>, intent: Intent, label: Option<String>) -> Result<Proposal> {
    let made = core.draft_as_user(intent, label).await?;
    proposals_changed(&app, &core.scope().await?.connection_id);
    Ok(made)
}

#[tauri::command]
async fn proposals_edit(app: AppHandle, core: State<'_, CoreState>, id: String, edit: Edit) -> Result<Proposal> {
    let edited = core.edit_proposal(&id, &edit).await?;
    proposals_changed(&app, &core.scope().await?.connection_id);
    Ok(edited)
}

/// Skips a draft. With `undo`, the person's Undo of a skip: a draft skipped a moment ago is pending again. Refused for a
/// skip that old, or a draft in any other state.
#[tauri::command]
async fn proposals_skip(app: AppHandle, core: State<'_, CoreState>, id: String, undo: bool) -> Result<Proposal> {
    let done = if undo { core.unskip_proposal(&id).await? } else { core.skip_proposal(&id).await? };
    let connection = core.scope().await?.connection_id;
    proposals_changed(&app, &connection);
    // A draft in a workstream is a line in its audit, which its timeline's counts read.
    if done.workstream().is_some() {
        workstreams_changed(&app, &connection);
    }
    Ok(done)
}

/// Applies the draft. A failed attempt still returns it, back to pending with `error` set.
#[tauri::command]
async fn proposals_approve(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let result = core.approve_proposal(&id).await;
    if let Ok(connection) = core.scope().await.map(|s| s.connection_id) {
        proposals_changed(&app, &connection);
        cache_changed(&app, &connection);
        // Approving a draft in a workstream is a line in its audit, which its timeline's counts read.
        if result.as_ref().is_ok_and(|p| p.workstream().is_some()) {
            workstreams_changed(&app, &connection);
        }
        if result.as_ref().is_ok_and(|p| matches!((&p.origin, &p.intent), (domain::Origin::Run { .. }, domain::Intent::Create { .. }))) {
            runs_changed(&app, &connection);
        }
    }
    publish(&app, &core).await;
    result
}

/// Posts a GitHub review draft as one comment review: the only command that writes to GitHub, and only the person's
/// approval calls it. `revisions` is how many revisions the draft had as the person saw it; one changed since is
/// refused. A refused attempt still returns the draft, back to pending with `error` set. `post_anyway` is the person's
/// choice to send a review that may be on GitHub already, which Gossamr looked for and didn't find.
#[tauri::command]
async fn proposals_post_review(app: AppHandle, core: State<'_, CoreState>, id: String, revisions: usize, post_anyway: Option<bool>) -> Result<Proposal> {
    let result = core.post_review_draft(&id, revisions, post_anyway.unwrap_or(false)).await;
    if let Ok(connection) = core.scope().await.map(|s| s.connection_id) {
        proposals_changed(&app, &connection);
    }
    publish(&app, &core).await;
    result
}

/// Whether the token may post a review on a watched repository, and why not when it can't.
#[tauri::command]
async fn code_review_access(core: State<'_, CoreState>, connection_id: String, repo: String) -> Result<codehost::ReviewAccess> {
    core.code_review_access(&connection_id, &repo).await
}

/// A pull request with the files it changes and their patches, for review drafts.
#[tauri::command]
async fn code_pull_diff(core: State<'_, CoreState>, connection_id: String, repo: String, number: u64) -> Result<codehost::PullDiff> {
    core.code_pull_diff(&connection_id, &repo, number).await
}

/// How many agents run at once, the terminal to open and the notices. With `settings`, saves them first, clamped.
#[tauri::command]
fn agent_settings(runs: State<'_, RunsState>, settings: Option<config::AgentSettings>) -> Result<config::AgentSettings> {
    match settings {
        Some(settings) => runs.set_settings(settings),
        None => Ok(runs.settings()),
    }
}

/// Removes a finished run's worktree with `claude rm`, never forcing it.
#[tauri::command]
async fn runs_cleanup(runs: State<'_, RunsState>, id: String) -> Result<runs::cleanup::Cleanup> {
    runs.cleanup(&id).await
}

/// Archives runs that are over: they leave the Agents view and Needs you but stay in the database. With `restore`, brings
/// them back. Returns the ids it archived, or with `restore` the ids it was given.
#[tauri::command]
async fn runs_archive(runs: State<'_, RunsState>, ids: Vec<String>, restore: bool) -> Result<Vec<String>> {
    if !restore {
        return runs.archive(&ids).await;
    }
    for id in &ids {
        runs.restore(id).await?;
    }
    Ok(ids)
}

/// Which runs "Clear finished" would archive for `filter`, and how many it leaves out and why.
#[tauri::command]
async fn runs_clear_preview(runs: State<'_, RunsState>, filter: runs::archive::ClearFilter) -> Result<runs::archive::ClearPreview> {
    runs.clear_preview(&filter).await
}

/// Archives the runs `runs_clear_preview` shows for `filter`, as they are now.
#[tauri::command]
async fn runs_clear(runs: State<'_, RunsState>, filter: runs::archive::ClearFilter) -> Result<Vec<String>> {
    runs.clear(&filter).await
}

/// The worktree folder deleting an archived run could remove, and its size. Only a folder inside `~/Gossamr/agents` is removable.
#[tauri::command]
async fn runs_worktree_info(runs: State<'_, RunsState>, id: String) -> Result<runs::archive::WorktreeInfo> {
    runs.worktree_info(&id).await
}

/// Deletes an archived run's records, and its worktree in `~/Gossamr/agents` when `remove_worktree`.
#[tauri::command]
async fn runs_delete(runs: State<'_, RunsState>, id: String, remove_worktree: bool) -> Result<runs::archive::Deleted> {
    runs.delete(&id, remove_worktree).await
}

/// Starts a run that is still queued, as after a restart. With `retry`, launches one whose launch failed, looking for its
/// session first and starting one only if there is none.
#[tauri::command]
async fn runs_start(runs: State<'_, RunsState>, id: String, retry: bool) -> Result<Run> {
    if retry {
        runs.retry_launch(&id).await
    } else {
        runs.start_now(&id).await
    }
}

/// Opens a workstream on a cached ticket, or with no ticket and a title. A ticket with an open one gets that one back.
#[tauri::command]
async fn workstreams_open(app: AppHandle, core: State<'_, CoreState>, item: Option<ItemRef>, title: Option<String>) -> Result<Workstream> {
    let ws = core.open_workstream(&core.scope().await?, item, title).await?;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// The signed-in account's workstreams with their derived stages, newest first.
#[tauri::command]
async fn workstreams_list(core: State<'_, CoreState>, include_closed: Option<bool>) -> Result<Vec<WorkstreamView>> {
    core.workstreams(&core.scope().await?, include_closed.unwrap_or(false)).await
}

/// What the person does to a workstream's state: close it, reopen a closed one (the page's Undo of Close, and a closed
/// row's Reopen), pause it (nothing wakes Pip in it; its runs carry on), or resume it, whatever paused it.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum WorkstreamState {
    Close,
    Reopen,
    Pause,
    Resume,
}

#[tauri::command]
async fn workstreams_set_state(app: AppHandle, core: State<'_, CoreState>, agent: State<'_, AgentState>, id: String, state: WorkstreamState) -> Result<Workstream> {
    let scope = core.scope().await?;
    let ws = match state {
        WorkstreamState::Close => core.close_workstream(&scope, &id).await?,
        WorkstreamState::Reopen => core.reopen_workstream(&scope, &id).await?,
        WorkstreamState::Pause => core.pause_workstream(&scope, &id, domain::workstream::PauseReason::Person, domain::Actor::Person).await?,
        WorkstreamState::Resume => core.resume_workstream(&scope, &id).await?,
    };
    if matches!(state, WorkstreamState::Close | WorkstreamState::Pause) {
        agent.cancel_workstream_turns(&id).await;
    }
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// The person dismisses a question Pip asked in the workstream.
#[tauri::command]
async fn workstreams_dismiss_ask(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<bool> {
    let scope = core.scope().await?;
    let cleared = core.clear_pip_ask(&scope, &id, "dismissed").await?;
    workstreams_changed(&app, &scope.connection_id);
    Ok(cleared)
}

/// The person's "Bring them here": the runs and drafts on the workstream's ticket that are in no workstream move into it.
/// Returns what moved, which the page's Undo hands back to `workstreams_undo`.
#[tauri::command]
async fn workstreams_adopt(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<inbox::Adoptable> {
    let scope = core.scope().await?;
    let moved = core.adopt_into_workstream(&scope, &id).await?;
    let connection = scope.connection_id.clone();
    workstreams_changed(&app, &connection);
    runs_changed(&app, &connection);
    proposals_changed(&app, &connection);
    Ok(moved)
}

/// The person's Undo of "Bring them here", a moment after it. Refused once anything else happened in it, or after a minute.
#[tauri::command]
async fn workstreams_undo(app: AppHandle, core: State<'_, CoreState>, id: String, undo: inbox::WorkstreamUndo) -> Result<Workstream> {
    let ws = core.undo_workstream(&core.scope().await?, &id, &undo).await?;
    workstreams_changed(&app, &ws.connection_id);
    // Taking back "Bring them here" moves runs and drafts, which the page reads too.
    runs_changed(&app, &ws.connection_id);
    proposals_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// A workstream's audit, oldest first.
#[tauri::command]
async fn workstreams_events(core: State<'_, CoreState>, id: String) -> Result<Vec<WorkstreamEvent>> {
    core.workstream_events(&core.scope().await?, &id).await
}

/// Local clones of a watched repository.
#[tauri::command]
async fn runs_clones(runs: State<'_, RunsState>, repo: String) -> Result<CloneChoice> {
    runs.clones(&repo).await
}

/// Clones a watched repository into `~/Gossamr/agents/<owner>/<repo>`. Only for the person's own button press, after the
/// folder and the command were shown.
#[tauri::command]
async fn runs_clone_fresh(runs: State<'_, RunsState>, repo: String) -> Result<runs::repo::LocalClone> {
    runs.clone_fresh(&repo).await
}

#[tauri::command]
async fn runs_pick_clone(runs: State<'_, RunsState>, repo: String, path: std::path::PathBuf) -> Result<()> {
    runs.pick_clone(&repo, &path).await
}

/// Stops a run that is working or waiting on the person. Its conversation and worktree are kept.
#[tauri::command]
async fn runs_stop(runs: State<'_, RunsState>, id: String) -> Result<Run> {
    let stopped = runs.stop(&id).await?;
    use_freed_slot(&runs);
    Ok(stopped)
}

/// Sends the person's answer to an agent that asked a question: stops its session and wakes it with the answer.
#[tauri::command]
async fn runs_answer(runs: State<'_, RunsState>, id: String, text: String) -> Result<Run> {
    runs.answer(&id, &text).await
}

/// Takes a listed session over as the continuation of a stopped or finished run, when it still passes every check.
#[tauri::command]
async fn runs_adopt_session(runs: State<'_, RunsState>, id: String, session: String) -> Result<Run> {
    runs.adopt_session(&id, &session).await
}

/// Stops every run Gossamr started, in any account, and the runs waiting for a slot, and nothing else. Nothing is
/// started in the slots it frees.
#[tauri::command]
async fn runs_stop_all(runs: State<'_, RunsState>) -> Result<runs::control::StopAll> {
    runs.stop_all().await
}

/// The person stops a workstream: pauses it, then stops each of its runs that can be stopped.
#[tauri::command]
async fn workstreams_stop(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, agent: State<'_, AgentState>, id: String) -> Result<runs::control::StopAll> {
    let scope = core.scope().await?;
    let result = runs.stop_workstream(&scope, &id).await;
    if result.is_ok() {
        use_freed_slot(&runs);
    }
    agent.cancel_workstream_turns(&id).await;
    let connection_id = scope.connection_id.clone();
    workstreams_changed(&app, &connection_id);
    runs_changed(&app, &connection_id);
    result
}

/// What Terminal is opened for.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum TerminalFor {
    /// The run's worktree, attached to its session.
    Session,
    /// The run's clone running `claude`, so the person can accept Claude's trust question there. Only for a run that
    /// failed because the folder isn't trusted; the folder is the one stored with the run.
    Trust,
    /// The run's clone running `claude`, so the person can sign in. Only for a run that failed because Claude isn't signed in.
    SignIn,
    /// The run's clone running `claude` in the permission mode `--bg` refused, so the person can accept it once. Only for
    /// a run that failed because of that mode.
    Mode { mode: domain::RefusedMode },
}

/// Opens Terminal for a run.
#[tauri::command]
async fn runs_open_terminal(runs: State<'_, RunsState>, id: String, purpose: TerminalFor) -> Result<()> {
    match purpose {
        TerminalFor::Session => runs.attach(&id).await,
        TerminalFor::Trust => runs.open_claude(&id, runs::control::Purpose::Trust).await,
        TerminalFor::SignIn => runs.open_claude(&id, runs::control::Purpose::SignIn).await,
        TerminalFor::Mode { mode } => runs.open_claude(&id, runs::control::Purpose::Mode(mode)).await,
    }
}

/// Bytes the run's session folder uses; a lower bound if counting took too long.
#[tauri::command]
async fn runs_disk(runs: State<'_, RunsState>, id: String) -> Result<u64> {
    runs.disk(&id).await
}

#[tauri::command]
async fn runs_events(runs: State<'_, RunsState>, id: String) -> Result<Vec<RunEvent>> {
    runs.events(&id).await
}

/// How many agents are still running in any account, for the sign-out and quit messages.
#[tauri::command]
fn runs_keep_running(runs: State<'_, RunsState>) -> usize {
    runs.keep_running()
}

/// What a run's result holds for the tracker, the tickets it names and the change it produced.
#[tauri::command]
async fn runs_outcome(core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<inbox::RunOutcome> {
    runs.refresh_result(&id).await;
    core.run_outcome(&id).await
}



#[tauri::command]
async fn runs_list(core: State<'_, CoreState>, query: Option<RunQuery>) -> Result<Vec<Run>> {
    core.runs_list(&query.unwrap_or_default()).await
}

#[tauri::command]
fn sync_now(core: State<'_, CoreState>) {
    core.wake.notify_one();
}

#[tauri::command]
async fn set_unread(app: AppHandle, core: State<'_, CoreState>, id: String, unread: bool) -> Result<()> {
    core.set_unread(&id, unread).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn mentionable(core: State<'_, CoreState>, key: String, query: String) -> Result<Vec<model::Person>> {
    core.mentionable(&core.scope().await?, &key, &query).await
}

#[tauri::command]
async fn ask_claude(app: AppHandle, agent: State<'_, AgentState>, request: AskRequest) -> Result<AskOutcome> {
    agent
        .ask(request, Arc::new(move |u| {
            wire::pip(&app, u);
        }))
        .await
}

/// Pip's conversation `conversation` as stored, with what a turn still running has said so far.
#[tauri::command]
async fn pip_turns(agent: State<'_, AgentState>, conversation: String) -> Result<Vec<db::PipTurn>> {
    agent.turns(&conversation).await
}

/// Stops the turn `request_id`: the running one, or one still waiting, which then never starts.
#[tauri::command]
async fn cancel_claude(agent: State<'_, AgentState>, request_id: String) -> Result<()> {
    agent.cancel(&request_id).await;
    Ok(())
}

fn spawn_sync_loop(app: AppHandle, core: CoreState) {
    tauri::async_runtime::spawn(async move {
        // Launch catches up straight away, from the cursor the last run left in the cache.
        let mut trigger = Trigger::Now;
        loop {
            if let Some(result) = core.sync_if_due(trigger).await {
                match result {
                    Ok(synced) => {
                        core.set_error(None);
                        if synced.changed {
                            cache_changed(&app, &synced.connection_id);
                        }
                        if synced.proposals_changed {
                            proposals_changed(&app, &synced.connection_id);
                        }
                        if synced.watch_changed {
                            watch_changed(&app, &synced.connection_id);
                        }
                    }
                    Err(e) => {
                        core.set_sync_failure(&e);
                        if e.is_unauthorized() {
                            probe_in_background(&app, &core, Probe::Unauthorized);
                        }
                    }
                }
                publish(&app, &core).await;
            }
            for (connection_id, result) in core.sync_code_if_due(trigger).await {
                // A failure shows on the connection's own row. It can follow repositories that were stored, so what
                // the page reads from the cache is refreshed either way.
                match result {
                    Ok(synced) => {
                        if synced.changed {
                            cache_changed(&app, &connection_id);
                        }
                        if synced.links_changed {
                            dev_links_changed(&app, &connection_id);
                        }
                        // A pull request found here can end a workstream's wait for its build's one.
                        if synced.changed || synced.links_changed {
                            if let Ok(scope) = core.scope().await {
                                workstreams_changed(&app, &scope.connection_id);
                            }
                        }
                    }
                    Err(_) => {
                        cache_changed(&app, &connection_id);
                        dev_links_changed(&app, &connection_id);
                    }
                }
                publish(&app, &core).await;
            }
            // A failed check is tried again at the next interval; nothing depends on it.
            if let Ok(Some((connection_id, strays))) = core.radar_if_due().await {
                wire::assigned_elsewhere(&app, &connection_id, &strays);
            }
            trigger = tokio::select! {
                _ = tokio::time::sleep(TICK) => Trigger::Timer,
                _ = core.wake.notified() => Trigger::Now,
                _ = core.focus.notified() => Trigger::Focus,
            };
        }
    });
}

const RELOAD_MENU_ID: &str = "reload-page";

/// The default menu with View > Reload (⌘R) added: the webview has no reload shortcut of its own. It reloads the page
/// only; nothing in the core restarts.
fn add_reload_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app.handle())?;
    let reload = MenuItem::with_id(app, RELOAD_MENU_ID, "Reload", true, Some("CmdOrCtrl+R"))?;
    let view = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(sub) if sub.text().is_ok_and(|t| t == "View") => Some(sub),
        _ => None,
    });
    match view {
        Some(view) => view.insert(&reload, 0)?,
        None => menu.append(&reload)?,
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == RELOAD_MENU_ID {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("location.reload()");
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                let app = window.app_handle();
                if let Some(core) = app.try_state::<CoreState>() {
                    core.focus.notify_one();
                    probe_in_background(app, &core, Probe::Focus);
                }
                if let Some(runs) = app.try_state::<RunsState>() {
                    runs.focus.notify_one();
                }
                if let Some(run_id) = app.try_state::<Arc<runs::tracker::OpenOnFocus>>().and_then(|open| open.take(std::time::Instant::now())) {
                    wire::open_run(app, &run_id);
                }
            }
        })
        .setup(|app| {
            add_reload_menu(app)?;
            display::watch(app.handle().clone());
            let http = net::client();
            let auth = Arc::new(Auth::load(http.clone()));
            let registry = tracker::Registry::jira(http.clone(), auth.clone());
            let data_dir = app.path().app_data_dir()?;
            if let Err(e) = legacy::adopt_legacy_data(&data_dir) {
                eprintln!("couldn't move data from the previous app name, starting fresh: {e}");
            }
            let code = inbox::CodeService::new(http.clone(), inbox::CodeService::default_store());
            let core: CoreState = Arc::new(Core::new(auth, registry, data_dir).with_code(code));
            tauri::async_runtime::block_on(core.restore());
            tauri::async_runtime::block_on(core.adopt_instances());
            app.manage(core.clone());
            probe_in_background(app.handle(), &core, Probe::Launch);

            let config = config::AppConfig::load(&core.data_dir());
            let runs_handle = app.handle().clone();
            let open_on_focus = Arc::new(runs::tracker::OpenOnFocus::default());
            app.manage(open_on_focus.clone());
            let bound = tauri::async_runtime::block_on(agent::mcp::bind(runs::agent_config::config_dir(&core.data_dir())))?;
            // The supervisor hears about runs from the run service and wakes Pip through the agent service, which is
            // built after both; until it is bound it does nothing.
            let (emit_handle, changed_handle) = (app.handle().clone(), app.handle().clone());
            let supervisor = agent::supervisor::Supervisor::new(
                core.clone(),
                Arc::new(move |conversation, update| wake_update(&emit_handle, conversation, update)),
                Arc::new(move |connection_id| workstreams_changed(&changed_handle, connection_id)),
            );
            let notices: Arc<dyn runs::tracker::RunNotifier> = Arc::new(RunNotices { app: app.handle().clone(), open: open_on_focus });
            let service = runs::service::RunService::new(
                    core.clone(),
                    Arc::new(runs::toolchain::SystemToolchain::default()),
                    runs::index::RunIndex::load(&core.data_dir()),
                    runs::service::RunService::default_roots(),
                    Arc::new(move |connection_id| runs_changed(&runs_handle, connection_id)),
                )
                .with_notifier(Arc::new(agent::supervisor::FanoutNotifier(vec![notices, supervisor.clone()])))
                .with_settings(config.agents)
                .with_agent_channel(bound.channel());
            let service = Arc::new(service);
            let handle = app.handle().clone();
            let (view_handle, ws_handle) = (handle.clone(), handle.clone());
            let mcp = agent::mcp::McpServer::start_on(
                bound,
                core.clone(),
                service.clone(),
                Arc::new(move |connection_id| proposals_changed(&handle, connection_id)),
                Arc::new(move |connection_id| workstreams_changed(&ws_handle, connection_id)),
                Arc::new(move |request_id, filter, note| pip_view(&view_handle, request_id, filter, note)),
            )?;
            app.manage::<LauncherState>(service.clone());
            app.manage::<RunsState>(service.clone());
            spawn_run_tracker(app.handle().clone(), service.clone());
            service.clean_attach_files();
            tauri::async_runtime::spawn(async move {
                service.warm().await;
                service.recover().await;
            });
            let agent = Arc::new(AgentService::new(core.clone(), mcp));
            supervisor.bind(&agent);
            tauri::async_runtime::spawn(supervisor.clone().run_sweeps());
            app.manage::<AgentState>(agent);

            spawn_sync_loop(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_needs_badge,
            reduce_transparency,
            auth_status,
            jira_cloud_id,
            jira_connect,
            sign_out,
            snapshot,
            cache_search,
            cache_item,
            cache_containers,
            watch_get,
            watch_set,
            watch_catalog,
            watch_suggestions,
            watch_unwatched_assigned,
            watch_dismiss_assigned,
            cache_events,
            cache_feed,
            cache_feed_unread,
            cache_me,
            cache_people,
            cache_comments,
            cache_transitions,
            connections_list,
            connection_open_terminal,
            first_run_github,
            first_run_open_terminal,
            connection_rename,
            connection_set_enabled,
            connection_remove,
            dev_links,
            code_pull_request,
            code_review_access,
            code_pull_diff,
            github_connect,
            github_sign_in_options,
            github_device_start,
            proposals_list,
            proposals_create,
            proposals_edit,
            proposals_skip,
            proposals_approve,
            proposals_post_review,
            agent_settings,
            runs_cleanup,
            runs_archive,
            runs_clear_preview,
            runs_clear,
            runs_worktree_info,
            runs_delete,
            runs_start,
            runs_clones,
            runs_clone_fresh,
            runs_pick_clone,
            runs_stop,
            runs_answer,
            runs_adopt_session,
            runs_stop_all,
            workstreams_stop,
            runs_open_terminal,
            runs_disk,
            runs_events,
            runs_keep_running,
            runs_list,
            runs_outcome,
            workstreams_open,
            workstreams_list,
            workstreams_set_state,
            workstreams_dismiss_ask,
            workstreams_adopt,
            workstreams_events,
            workstreams_undo,
            sync_now,
            set_unread,
            mentionable,
            ask_claude,
            cancel_claude,
            pip_turns
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
