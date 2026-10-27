mod agent;
mod auth;
mod claude;
mod codehost;
mod config;
mod db;
mod domain;
mod error;
mod events;
mod inbox;
mod legacy;
mod model;
mod net;
mod notify;
mod proposals;
mod runs;
mod secrets;
mod sync;
mod tracker;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use auth::{Auth, AuthStatus, DeviceStart, OAuthApp, Scope};
use agent::{AgentService, AskOutcome, AskRequest};
use tracker::{Connection, Move};
use inbox::{CatalogPage, CodeRef, ConnectionInfo, Core, Edit, WatchState, WorkstreamView};
use error::{Error, Result};
use domain::{
    CodeChange, CodeFile, CodeHit, CommitQuery, Comment, Container, DevLink, Event, FeedPage, FeedQuery, Filter, Footprint, Identity, Intent, ItemRef, Proposal, ProposalQuery, PullRequestDetail, Run, RunEvent, RunQuery, Stray,
    TreeEntry, WatchChange, WatchMode, WorkItem, Workstream, WorkstreamEvent,
};
use model::Snapshot;
use runs::service::CloneChoice;
use sync::Trigger;

/// How often the scheduler checks whether a sync is due. Waking from sleep is noticed within one tick.
const TICK: Duration = Duration::from_secs(15);
const EVENT_LIMIT: usize = 100;

type CoreState = Arc<Core>;
type AgentState = Arc<AgentService>;
type LauncherState = Arc<dyn runs::launcher::RunLauncher>;
type RunsState = Arc<runs::service::RunService>;

/// Sends the latest snapshot to the window and updates the Dock badge. Failures only mean there is nothing to
/// show yet (e.g. signed out).
async fn publish(app: &AppHandle, core: &Core) {
    let Ok(snap) = core.snapshot().await else { return };
    if let Some(win) = app.get_webview_window("main") {
        let unread = snap.inbox_unread(&inbox::now_iso());
        let _ = win.set_badge_count((unread > 0).then_some(unread as i64));
    }
    let _ = app.emit("snapshot", snap);
}

/// Tells the page the cache changed, so views over it can re-read.
fn cache_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("cache-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page a run was created or changed.
fn runs_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("runs-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page which work items' code links changed, so it can re-read them.
fn dev_links_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("dev-links-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page what is watched changed, so it can re-read the settings along with everything they scope.
fn watch_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("watch-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page about open items assigned to the person in containers they don't watch. It never watches them.
fn assigned_elsewhere(app: &AppHandle, connection_id: &str, strays: &[Stray]) {
    let _ = app.emit("watch-assigned-elsewhere", serde_json::json!({ "connectionId": connection_id, "strays": strays }));
}

/// Tells the page the stored drafts changed, so it can re-read them.
fn proposals_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("proposals-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page a workstream was opened, closed or changed, so it can re-read them.
fn workstreams_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("workstreams-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// A wake turn's event, which no page asked for: sent as `claude` like any turn's, with the conversation it belongs to
/// and `kind: wake`, so the page can show a turn it didn't start.
fn wake_update(app: &AppHandle, conversation: &str, update: agent::Update) {
    let Ok(mut payload) = serde_json::to_value(&update) else { return };
    payload["conversation"] = conversation.into();
    payload["kind"] = "wake".into();
    let _ = app.emit("claude", payload);
}

/// Asks the page to narrow the view the person is looking at.
fn pip_view(app: &AppHandle, request_id: &str, filter: &domain::Filter, note: &str) {
    let _ = app.emit("pip-view", serde_json::json!({ "requestId": request_id, "filter": filter, "note": note }));
}

/// Shows native notifications for new events, unless the window is focused and the user can already see them.
fn announce(app: &AppHandle, events: &[events::NewEvent]) {
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if focused {
        return;
    }
    for n in notify::notices(events) {
        let _ = app.notification().builder().title(n.title).body(n.body).show();
    }
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

#[tauri::command]
async fn save_oauth_app(core: State<'_, CoreState>, client_id: String, client_secret: String) -> Result<AuthStatus> {
    core.auth.save_app(OAuthApp { client_id, client_secret })?;
    core.auth.status().await
}

#[tauri::command]
async fn sign_in(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>) -> Result<AuthStatus> {
    let status = core
        .sign_in(|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| Error::Auth(format!("couldn't open the browser: {e}")))
        })
        .await?;
    core.wake.notify_one();
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

#[tauri::command]
async fn cache_item(core: State<'_, CoreState>, item: ItemRef) -> Result<Option<WorkItem>> {
    core.cache_item(&item).await
}

#[tauri::command]
async fn cache_containers(core: State<'_, CoreState>, include_unwatched: Option<bool>) -> Result<Vec<Container>> {
    core.cache_containers(include_unwatched.unwrap_or(false)).await
}

/// Reads an item live, without storing it, flagged `unwatched` when its container isn't watched.
#[tauri::command]
async fn peek_item(core: State<'_, CoreState>, item: ItemRef) -> Result<Option<WorkItem>> {
    core.peek_item(&item).await
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

#[tauri::command]
async fn watch_set_mode(app: AppHandle, core: State<'_, CoreState>, connection_id: String, mode: WatchMode) -> Result<()> {
    core.watch_set_mode(&connection_id, mode).await?;
    watch_edited(&app, &core, &connection_id).await;
    Ok(())
}

#[tauri::command]
async fn watch_set_containers(app: AppHandle, core: State<'_, CoreState>, connection_id: String, changes: Vec<WatchChange>) -> Result<()> {
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
async fn cache_feed_unread(core: State<'_, CoreState>) -> Result<usize> {
    core.cache_feed_unread().await
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

#[tauri::command]
async fn connections_list(core: State<'_, CoreState>) -> Result<Vec<ConnectionInfo>> {
    core.connections().await
}

/// The account a pasted token belongs to is connected, and its repositories become watchable.
#[tauri::command]
async fn github_connect_token(app: AppHandle, core: State<'_, CoreState>, token: String) -> Result<ConnectionInfo> {
    let connected = core.github_connect_token(&token).await?;
    watch_changed(&app, &connected.id);
    Ok(connected)
}

/// Runs `gh auth token` now, because the person asked, and connects with what it prints.
#[tauri::command]
async fn github_import_gh_token(app: AppHandle, core: State<'_, CoreState>) -> Result<ConnectionInfo> {
    let connected = core.github_import_gh_token().await?;
    watch_changed(&app, &connected.id);
    Ok(connected)
}

/// Which ways of connecting GitHub work here: the device flow needs a client id, `gh` must be installed.
#[tauri::command]
fn github_sign_in_options(core: State<'_, CoreState>) -> auth::SignInOptions {
    core.code_sign_in_options()
}

/// Starts the device flow: show `userCode` and open `verificationUri`, then call `github_device_poll`.
#[tauri::command]
async fn github_device_start(core: State<'_, CoreState>) -> Result<DeviceStart> {
    core.github_device_start().await
}

/// Resolves when the code was authorised (or fails when it expired or was denied).
#[tauri::command]
async fn github_device_poll(app: AppHandle, core: State<'_, CoreState>) -> Result<ConnectionInfo> {
    let connected = core.github_device_poll().await?;
    watch_changed(&app, &connected.id);
    Ok(connected)
}

#[tauri::command]
async fn github_disconnect(app: AppHandle, core: State<'_, CoreState>, connection_id: String) -> Result<()> {
    core.github_disconnect(&connection_id).await?;
    watch_changed(&app, &connection_id);
    Ok(())
}

/// The pull requests, branches and commits that name a work item, from the cache. Instant; only watched repositories.
#[tauri::command]
fn dev_links(core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<DevLink>> {
    core.dev_links(&item)
}

/// Searches the watched repositories for the item's key, caches what it finds, and returns the links.
#[tauri::command]
async fn dev_links_live(app: AppHandle, core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<DevLink>> {
    let (links, changed) = core.dev_links_live(&item).await?;
    changed.iter().for_each(|id| dev_links_changed(&app, id));
    Ok(links)
}

/// Pull request and notification events of the GitHub connections, newest first, for the Activity feed.
#[tauri::command]
fn code_events(core: State<'_, CoreState>, limit: Option<usize>) -> Result<Vec<Event>> {
    core.code_events(limit.unwrap_or(EVENT_LIMIT))
}

#[tauri::command]
async fn code_pull_request(core: State<'_, CoreState>, reference: CodeRef) -> Result<PullRequestDetail> {
    core.code_pull_request(&reference).await
}

#[tauri::command]
async fn code_search(core: State<'_, CoreState>, query: String) -> Result<Vec<CodeChange>> {
    core.code_search(&query).await
}

#[tauri::command]
async fn code_file(core: State<'_, CoreState>, connection_id: String, repo: String, path: String, reference: Option<String>) -> Result<CodeFile> {
    core.code_file(&connection_id, &repo, &path, reference.as_deref()).await
}

#[tauri::command]
async fn code_tree(core: State<'_, CoreState>, connection_id: String, repo: String, path: String, reference: Option<String>) -> Result<Vec<TreeEntry>> {
    core.code_tree(&connection_id, &repo, &path, reference.as_deref()).await
}

/// Commits of a branch or ref, newest first. `since` is RFC 3339; `query` filters by message text such as a ticket key.
#[tauri::command]
async fn code_commits(
    core: State<'_, CoreState>,
    connection_id: String,
    repo: String,
    reference: Option<String>,
    since: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<CodeChange>> {
    let since = since
        .map(|s| chrono::DateTime::parse_from_rfc3339(&s).map(|d| d.with_timezone(&chrono::Utc)).map_err(|_| Error::Api { status: 400, message: format!("not a valid time: {s}") }))
        .transpose()?;
    core.code_commits(&connection_id, &CommitQuery { repo, reference, since, path: None, text: query, limit: limit.unwrap_or(0) }).await
}

/// GitHub code search, limited to watched repositories (all of them when `repos` is left out).
#[tauri::command]
async fn code_search_code(core: State<'_, CoreState>, connection_id: String, query: String, repos: Option<Vec<String>>) -> Result<Vec<CodeHit>> {
    core.code_search_code(&connection_id, &query, repos.as_deref()).await
}

#[tauri::command]
async fn proposals_list(core: State<'_, CoreState>, query: Option<ProposalQuery>) -> Result<Vec<Proposal>> {
    core.proposals(&query.unwrap_or_default()).await
}

#[tauri::command]
async fn proposals_get(core: State<'_, CoreState>, id: String) -> Result<Option<Proposal>> {
    core.proposal(&id).await
}

/// Drafts a write the person made by hand. It stays a draft until `proposals_approve`.
#[tauri::command]
async fn proposals_create(app: AppHandle, core: State<'_, CoreState>, intent: Intent, label: Option<String>) -> Result<Proposal> {
    let made = core.draft_as_user(intent, label).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

#[tauri::command]
async fn proposals_edit(app: AppHandle, core: State<'_, CoreState>, id: String, edit: Edit) -> Result<Proposal> {
    let edited = core.edit_proposal(&id, &edit).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(edited)
}

#[tauri::command]
async fn proposals_skip(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let skipped = core.skip_proposal(&id).await?;
    let connection = Connection::jira_id(&core.scope().await?);
    proposals_changed(&app, &connection);
    // A draft in a workstream is a line in its audit, which its timeline's counts read.
    if skipped.workstream().is_some() {
        workstreams_changed(&app, &connection);
    }
    Ok(skipped)
}

/// The person's Undo of a skip: a draft skipped a moment ago is pending again. Refused for a skip that old, or a draft in any other state.
#[tauri::command]
async fn proposals_unskip(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let back = core.unskip_proposal(&id).await?;
    let connection = Connection::jira_id(&core.scope().await?);
    proposals_changed(&app, &connection);
    if back.workstream().is_some() {
        workstreams_changed(&app, &connection);
    }
    Ok(back)
}

/// Applies the draft. A failed attempt still returns it, back to pending with `error` set.
#[tauri::command]
async fn proposals_approve(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let result = core.approve_proposal(&id).await;
    if let Ok(connection) = core.scope().await.map(|s| Connection::jira_id(&s)) {
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
    if let Ok(connection) = core.scope().await.map(|s| Connection::jira_id(&s)) {
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

/// The files a pull request changes, with patches long enough to show a review draft's comments in place.
#[tauri::command]
async fn code_pull_files(core: State<'_, CoreState>, connection_id: String, repo: String, number: u64) -> Result<Vec<domain::ChangedFile>> {
    core.code_pull_files(&connection_id, &repo, number).await
}

/// A pull request with the files it changes and their patches, for the in-app pull request view.
#[tauri::command]
async fn code_pull_diff(core: State<'_, CoreState>, connection_id: String, repo: String, number: u64) -> Result<codehost::PullDiff> {
    core.code_pull_diff(&connection_id, &repo, number).await
}

/// The limits on runs and the terminal to open.
#[tauri::command]
fn runs_settings(runs: State<'_, RunsState>) -> config::AgentSettings {
    runs.settings()
}

#[tauri::command]
fn runs_set_settings(runs: State<'_, RunsState>, settings: config::AgentSettings) -> Result<config::AgentSettings> {
    runs.set_settings(settings)
}

/// Removes a finished run's worktree with `claude rm`, never forcing it.
#[tauri::command]
async fn runs_cleanup(runs: State<'_, RunsState>, id: String) -> Result<runs::cleanup::Cleanup> {
    runs.cleanup(&id).await
}

/// Archives runs that are over. They leave the Agents view and Needs you but stay in the database.
#[tauri::command]
async fn runs_archive(runs: State<'_, RunsState>, ids: Vec<String>) -> Result<Vec<String>> {
    runs.archive(&ids).await
}

#[tauri::command]
async fn runs_restore(runs: State<'_, RunsState>, id: String) -> Result<()> {
    runs.restore(&id).await
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

/// Starts a run that is still queued, as after a restart.
#[tauri::command]
async fn runs_start_now(runs: State<'_, RunsState>, id: String) -> Result<Run> {
    runs.start_now(&id).await
}

/// Looks for the session of a run whose launch failed, and starts one only if there is none.
#[tauri::command]
async fn runs_retry_launch(runs: State<'_, RunsState>, id: String) -> Result<Run> {
    runs.retry_launch(&id).await
}

/// Opens a workstream on a cached ticket, or with no ticket and a title. A ticket with an open one gets that one back.
#[tauri::command]
async fn workstreams_open(app: AppHandle, core: State<'_, CoreState>, item: Option<ItemRef>, title: Option<String>) -> Result<Workstream> {
    let ws = core.open_workstream(&core.scope().await?, item, title).await?;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

#[tauri::command]
async fn workstreams_get(core: State<'_, CoreState>, id: String) -> Result<Option<WorkstreamView>> {
    core.workstream(&core.scope().await?, &id).await
}

/// The signed-in account's workstreams with their derived stages, newest first.
#[tauri::command]
async fn workstreams_list(core: State<'_, CoreState>, include_closed: Option<bool>) -> Result<Vec<WorkstreamView>> {
    core.workstreams(&core.scope().await?, include_closed.unwrap_or(false)).await
}

#[tauri::command]
async fn workstreams_close(app: AppHandle, core: State<'_, CoreState>, agent: State<'_, AgentState>, id: String) -> Result<Workstream> {
    let ws = core.close_workstream(&core.scope().await?, &id).await?;
    agent.cancel_workstream_turns(&id).await;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// The person dismisses a question Pip asked in the workstream.
#[tauri::command]
async fn workstreams_dismiss_ask(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<bool> {
    let scope = core.scope().await?;
    let cleared = core.clear_pip_ask(&scope, &id, "dismissed").await?;
    workstreams_changed(&app, &Connection::jira_id(&scope));
    Ok(cleared)
}

/// Reopens a closed workstream (the page's Undo of Close, and a closed row's Reopen).
#[tauri::command]
async fn workstreams_reopen(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Workstream> {
    let ws = core.reopen_workstream(&core.scope().await?, &id).await?;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// The person's "Bring them here": the runs and drafts on the workstream's ticket that are in no workstream move into it.
/// Returns what moved, which the page's Undo hands back to `workstreams_undo`.
#[tauri::command]
async fn workstreams_adopt(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<inbox::Adoptable> {
    let scope = core.scope().await?;
    let moved = core.adopt_into_workstream(&scope, &id).await?;
    let connection = Connection::jira_id(&scope);
    workstreams_changed(&app, &connection);
    runs_changed(&app, &connection);
    proposals_changed(&app, &connection);
    Ok(moved)
}

/// The person's change to a workstream's notes.
#[tauri::command]
async fn workstreams_set_notes(app: AppHandle, core: State<'_, CoreState>, id: String, notes: String) -> Result<Workstream> {
    let ws = core.set_workstream_notes(&core.scope().await?, &id, &notes, domain::Actor::Person).await?;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// The person pauses a workstream: nothing wakes Pip in it; its runs carry on.
#[tauri::command]
async fn workstreams_pause(app: AppHandle, core: State<'_, CoreState>, agent: State<'_, AgentState>, id: String) -> Result<Workstream> {
    let ws = core.pause_workstream(&core.scope().await?, &id, domain::workstream::PauseReason::Person, domain::Actor::Person).await?;
    agent.cancel_workstream_turns(&id).await;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
}

/// The person resumes a workstream, whatever paused it.
#[tauri::command]
async fn workstreams_resume(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Workstream> {
    let ws = core.resume_workstream(&core.scope().await?, &id).await?;
    workstreams_changed(&app, &ws.connection_id);
    Ok(ws)
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

/// The person stops a workstream: pauses it, then stops each of its runs that can be stopped.
#[tauri::command]
async fn workstreams_stop(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, agent: State<'_, AgentState>, id: String) -> Result<runs::control::StopAll> {
    let scope = core.scope().await?;
    let result = runs.stop_workstream(&scope, &id).await;
    if result.is_ok() {
        use_freed_slot(&runs);
    }
    agent.cancel_workstream_turns(&id).await;
    let connection_id = Connection::jira_id(&scope);
    workstreams_changed(&app, &connection_id);
    runs_changed(&app, &connection_id);
    result
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

/// The person's Deny for the permission prompt they read as `command`: stops the session and wakes it in place, told
/// the request was refused. Pip has no way to call this.
#[tauri::command]
async fn runs_deny_permission(app: AppHandle, runs: State<'_, RunsState>, id: String, command: String) -> Result<Run> {
    let run = runs.deny_permission(&id, &command).await?;
    runs_changed(&app, &run.connection_id);
    Ok(run)
}

/// The person's Allow once for the permission prompt they read as `command`, when Gossamr's policy offers it: records
/// the choice and opens the session in Terminal, where the person answers Claude Code's own prompt. Pip has no way to
/// call this.
#[tauri::command]
async fn runs_allow_permission_once(app: AppHandle, runs: State<'_, RunsState>, id: String, command: String) -> Result<Run> {
    let run = runs.allow_permission_once(&id, &command).await?;
    runs_changed(&app, &run.connection_id);
    Ok(run)
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

/// Opens Terminal in the run's worktree, attached to its session.
#[tauri::command]
async fn runs_attach(runs: State<'_, RunsState>, id: String) -> Result<()> {
    runs.attach(&id).await
}

/// Opens Terminal in the run's clone running `claude`, so the person can accept Claude's trust question there. Only for
/// a run that failed because the folder isn't trusted; the folder is the one stored with the run.
#[tauri::command]
async fn runs_trust_folder(runs: State<'_, RunsState>, id: String) -> Result<()> {
    runs.open_claude(&id, runs::control::Purpose::Trust).await
}

/// Opens Terminal in the run's clone running `claude`, so the person can sign in. Only for a run that failed because
/// Claude isn't signed in.
#[tauri::command]
async fn runs_sign_in(runs: State<'_, RunsState>, id: String) -> Result<()> {
    runs.open_claude(&id, runs::control::Purpose::SignIn).await
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

/// The run a recent notification was about, once, for a page that missed the `open-run` event.
#[tauri::command]
fn runs_open_pending(open: State<'_, Arc<runs::tracker::OpenOnFocus>>) -> Option<String> {
    open.take(std::time::Instant::now())
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

/// Drafts a comment from a finished run's `For Jira:` part. A draft only: the person edits and approves it.
#[tauri::command]
async fn runs_draft_comment(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let made = core.draft_run_comment(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts the whole plan of a finished Plan run as a comment on its ticket. A draft only: the person edits and approves it.
#[tauri::command]
async fn runs_draft_plan_comment(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<inbox::PlanComment> {
    let made = core.draft_run_plan_comment(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts the ticket's description with the plan of a finished Plan run added. A draft only: the person reads the diff and approves it.
#[tauri::command]
async fn runs_draft_plan_description(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let made = core.draft_run_plan_description(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts a new ticket from a finished run that has no ticket. A draft only: the person edits and approves it.
#[tauri::command]
async fn runs_draft_ticket(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let made = core.draft_run_ticket(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts a link saying the run's ticket is blocked by `blocker_key`. A draft only.
#[tauri::command]
async fn runs_draft_blocker(app: AppHandle, core: State<'_, CoreState>, id: String, blocker_key: String) -> Result<Proposal> {
    let made = core.draft_run_blocker(&id, &blocker_key).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

#[tauri::command]
async fn runs_list(core: State<'_, CoreState>, query: Option<RunQuery>) -> Result<Vec<Run>> {
    core.runs_list(&query.unwrap_or_default()).await
}

#[tauri::command]
async fn runs_get(core: State<'_, CoreState>, id: String) -> Result<Option<Run>> {
    core.run(&id).await
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
async fn create_subtasks(
    app: AppHandle,
    core: State<'_, CoreState>,
    scope: Scope,
    key: String,
    summaries: Vec<String>,
) -> Result<model::CreatedSubtasks> {
    let created = core.create_subtasks(&scope, &key, &summaries).await?;
    cache_changed(&app, &Connection::jira_id(&scope));
    publish(&app, &core).await;
    Ok(created)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessions {
    /// The session to continue for this ticket, when Pip can resume it.
    last: Option<String>,
}

#[tauri::command]
async fn claude_sessions(core: State<'_, CoreState>, key: String) -> Result<ClaudeSessions> {
    Ok(ClaudeSessions { last: core.claude_session_for(&key).await? })
}

#[tauri::command]
async fn ask_claude(app: AppHandle, agent: State<'_, AgentState>, request: AskRequest) -> Result<AskOutcome> {
    agent
        .ask(request, Arc::new(move |u| {
            let _ = app.emit("claude", u);
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
                        announce(&app, &synced.new_events);
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
                    Err(e) => core.set_sync_failure(&e),
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
                                workstreams_changed(&app, &Connection::jira_id(&scope));
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
                assigned_elsewhere(&app, &connection_id, &strays);
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
                }
                if let Some(runs) = app.try_state::<RunsState>() {
                    runs.focus.notify_one();
                }
                if let Some(run_id) = app.try_state::<Arc<runs::tracker::OpenOnFocus>>().and_then(|open| open.take(std::time::Instant::now())) {
                    let _ = app.emit("open-run", serde_json::json!({ "runId": run_id }));
                }
            }
        })
        .setup(|app| {
            add_reload_menu(app)?;
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
            app.manage(core.clone());

            let config = config::AppConfig::load(&core.data_dir());
            let runs_handle = app.handle().clone();
            let drafted_handle = app.handle().clone();
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
                .with_drafted(Arc::new(move |connection_id| proposals_changed(&drafted_handle, connection_id)))
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
            auth_status,
            save_oauth_app,
            sign_in,
            sign_out,
            snapshot,
            cache_search,
            cache_item,
            cache_containers,
            peek_item,
            watch_get,
            watch_set_mode,
            watch_set_containers,
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
            dev_links,
            dev_links_live,
            code_events,
            code_pull_request,
            code_search,
            code_file,
            code_tree,
            code_commits,
            code_search_code,
            code_review_access,
            code_pull_files,
            code_pull_diff,
            github_connect_token,
            github_import_gh_token,
            github_sign_in_options,
            github_device_start,
            github_device_poll,
            github_disconnect,
            proposals_list,
            proposals_get,
            proposals_create,
            proposals_edit,
            proposals_skip,
            proposals_unskip,
            proposals_approve,
            proposals_post_review,
            runs_settings,
            runs_set_settings,
            runs_cleanup,
            runs_archive,
            runs_restore,
            runs_clear_preview,
            runs_clear,
            runs_worktree_info,
            runs_delete,
            runs_start_now,
            runs_retry_launch,
            runs_clones,
            runs_clone_fresh,
            runs_pick_clone,
            runs_stop,
            runs_answer,
            runs_deny_permission,
            runs_allow_permission_once,
            runs_adopt_session,
            runs_stop_all,
            runs_attach,
            runs_trust_folder,
            runs_sign_in,
            runs_disk,
            runs_events,
            runs_open_pending,
            runs_keep_running,
            runs_list,
            runs_outcome,
            runs_draft_comment,
            runs_draft_blocker,
            runs_draft_plan_comment,
            runs_draft_plan_description,
            runs_draft_ticket,
            runs_get,
            workstreams_open,
            workstreams_get,
            workstreams_list,
            workstreams_close,
            workstreams_reopen,
            workstreams_dismiss_ask,
            workstreams_adopt,
            workstreams_set_notes,
            workstreams_events,
            workstreams_pause,
            workstreams_resume,
            workstreams_undo,
            workstreams_stop,
            sync_now,
            set_unread,
            mentionable,
            create_subtasks,
            claude_sessions,
            ask_claude,
            cancel_claude,
            pip_turns
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
