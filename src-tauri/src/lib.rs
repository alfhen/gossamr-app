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
use agent::{AgentService, AskRequest};
use claude::ClaudeCodeProvider;
use tracker::{Connection, Move};
use inbox::{CatalogPage, CodeRef, ConnectionInfo, Core, Edit, WatchState};
use error::{Error, Result};
use domain::{
    CodeChange, CodeFile, CodeHit, CommitQuery, Comment, Container, ContainerRef, DevLink, Event, FeedPage, FeedQuery, Filter, Footprint, Identity, Intent, ItemRef, Proposal, ProposalQuery, PullRequestDetail, Run, RunEvent, RunQuery, RunReview, RunSpec, Stray,
    TreeEntry, WatchChange, WatchMode, WorkItem, Workflow,
};
use model::{Snapshot, Transition};
use runs::preflight::Preflight;
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

/// A needs-state, a finished run or a failed one, as a system notification unless the window is already in front.
/// Focusing the window soon after opens the run (`open-run`), since the notification has no click handler.
fn announce_run(app: &AppHandle, open: &runs::tracker::OpenOnFocus, run: &Run, why: runs::tracker::Attention) {
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if focused {
        return;
    }
    let notice = runs::tracker::notice_text(run, why);
    if app.notification().builder().title(notice.title).body(notice.body).show().is_ok() {
        open.record(&run.id, std::time::Instant::now());
    }
}

struct RunNotices {
    app: AppHandle,
    open: Arc<runs::tracker::OpenOnFocus>,
}

impl runs::tracker::RunNotifier for RunNotices {
    fn notify(&self, run: &Run, why: runs::tracker::Attention) {
        announce_run(&self.app, &self.open, run, why);
    }
}

/// Looks at `claude agents` every few seconds while a run is under way and the window is in front, and every half
/// minute otherwise; the window gaining focus brings the next look forward. It runs for the life of the app and does
/// nothing while Agents are off, so turning them on needs no restart.
fn spawn_run_tracker(app: AppHandle, service: RunsState) {
    tauri::async_runtime::spawn(async move {
        loop {
            let polled = service.poll().await;
            let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            let wait = if polled.busy && focused { runs::tracker::POLL_BUSY } else { runs::tracker::POLL_IDLE };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = service.focus.notified() => {}
            }
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
async fn cache_workflow(core: State<'_, CoreState>, container: ContainerRef) -> Result<Option<Workflow>> {
    core.cache_workflow(&container).await
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
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(skipped)
}

/// Applies the draft. A failed attempt still returns it, back to pending with `error` set.
#[tauri::command]
async fn proposals_approve(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let result = core.approve_proposal(&id).await;
    if let Ok(connection) = core.scope().await.map(|s| Connection::jira_id(&s)) {
        proposals_changed(&app, &connection);
        cache_changed(&app, &connection);
        if result.as_ref().is_ok_and(|p| matches!((&p.origin, &p.intent), (domain::Origin::Run { .. }, domain::Intent::Create { .. }))) {
            runs_changed(&app, &connection);
        }
    }
    publish(&app, &core).await;
    result
}

/// The prompt a run draft would send and the digest to approve it with.
#[tauri::command]
async fn runs_review(core: State<'_, CoreState>, proposal_id: String) -> Result<RunReview> {
    core.runs_review(&proposal_id).await
}

/// Whether Agents are on. This is the only place the answer lives.
#[tauri::command]
fn runs_enabled(runs: State<'_, RunsState>) -> bool {
    runs.is_enabled()
}

/// Turns Agents on or off and saves the choice. Turning on reads the shell environment first and fails, leaving
/// Agents off, if it can't; turning off stops nothing that is running.
#[tauri::command]
async fn runs_set_enabled(runs: State<'_, RunsState>, enabled: bool) -> Result<runs::enable::EnabledChange> {
    let change = runs.set_enabled(enabled).await?;
    if change.enabled {
        let runs = runs.inner().clone();
        tauri::async_runtime::spawn(async move { runs.recover().await });
    }
    Ok(change)
}

/// Drafts a run by hand. It stays a draft until `runs_approve`.
#[tauri::command]
async fn runs_draft(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, spec: RunSpec, item: Option<ItemRef>) -> Result<Proposal> {
    runs.ensure_enabled()?;
    let made = core.draft_run(spec, item).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// The limits on runs and the terminal to open. Readable and writable while Agents are off.
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

/// Approves a run draft the person has read (`digest` is from `runs_review`) and hands the queued run to the launcher.
#[tauri::command]
async fn runs_approve(
    app: AppHandle,
    core: State<'_, CoreState>,
    launcher: State<'_, LauncherState>,
    runs: State<'_, RunsState>,
    proposal_id: String,
    digest: String,
) -> Result<Run> {
    runs.ensure_enabled()?;
    let run = core.runs_approve(&proposal_id, &digest).await?;
    proposals_changed(&app, &run.connection_id);
    runs_changed(&app, &run.connection_id);
    let (launcher, run_id) = (launcher.inner().clone(), run.id.clone());
    tauri::async_runtime::spawn(async move {
        // A failed launch is recorded on the run itself; an error here means it couldn't be recorded.
        if let Err(e) = launcher.launch(&run_id).await {
            eprintln!("couldn't start run {run_id}: {e}");
        }
    });
    Ok(run)
}

/// What a run would need and run as, or with no spec only the environment and capacity.
#[tauri::command]
async fn runs_preflight(runs: State<'_, RunsState>, spec: Option<RunSpec>) -> Result<Preflight> {
    runs.preflight(spec).await
}

/// Starts a run that is still queued, as after a restart.
#[tauri::command]
async fn runs_start_now(runs: State<'_, RunsState>, id: String) -> Result<Run> {
    runs.ensure_enabled()?;
    runs.start_now(&id).await
}

/// Looks for the session of a run whose launch failed, and starts one only if there is none.
#[tauri::command]
async fn runs_retry_launch(runs: State<'_, RunsState>, id: String) -> Result<Run> {
    runs.ensure_enabled()?;
    runs.retry_launch(&id).await
}

/// Every watched GitHub repository as owner/name.
#[tauri::command]
async fn runs_repos(runs: State<'_, RunsState>) -> Result<Vec<String>> {
    runs.repos()
}

/// Local clones of a watched repository.
#[tauri::command]
async fn runs_clones(runs: State<'_, RunsState>, repo: String) -> Result<CloneChoice> {
    runs.ensure_enabled()?;
    runs.clones(&repo).await
}

/// Clones a watched repository into `~/Gossamr/agents/<owner>/<repo>`. Only for the person's own button press, after the
/// setup sheet showed the folder and the command.
#[tauri::command]
async fn runs_clone_fresh(runs: State<'_, RunsState>, repo: String) -> Result<runs::repo::LocalClone> {
    runs.clone_fresh(&repo).await
}

#[tauri::command]
async fn runs_pick_clone(runs: State<'_, RunsState>, repo: String, path: std::path::PathBuf) -> Result<()> {
    runs.ensure_enabled()?;
    runs.pick_clone(&repo, &path).await
}

/// A worktree name for a new run in `clone_path` that nothing there uses yet.
#[tauri::command]
async fn runs_suggest_name(runs: State<'_, RunsState>, clone_path: std::path::PathBuf, key: String, title: String) -> Result<String> {
    runs.suggest_name(&clone_path, &key, &title).await
}

/// Stops a run that is working or waiting on the person. Its conversation and worktree are kept.
#[tauri::command]
async fn runs_stop(runs: State<'_, RunsState>, id: String) -> Result<Run> {
    runs.stop(&id).await
}

/// Sends the person's answer to an agent that asked a question: stops its session and wakes it with the answer.
#[tauri::command]
async fn runs_answer(runs: State<'_, RunsState>, id: String, text: String) -> Result<Run> {
    runs.answer(&id, &text).await
}

/// Approves a follow-up the person has read (`message` is what they saw; a draft that changed since is refused): sends the finished agent back for another pass with its message.
#[tauri::command]
async fn runs_send_follow_up(app: AppHandle, runs: State<'_, RunsState>, proposal_id: String, message: String) -> Result<Run> {
    let result = runs.send_follow_up(&proposal_id, &message).await;
    if let Ok(run) = &result {
        proposals_changed(&app, &run.connection_id);
        runs_changed(&app, &run.connection_id);
    }
    result
}

/// Takes a listed session over as the continuation of a stopped or finished run, when it still passes every check.
#[tauri::command]
async fn runs_adopt_session(runs: State<'_, RunsState>, id: String, session: String) -> Result<Run> {
    runs.adopt_session(&id, &session).await
}

/// Stops every run Gossamr started, in any account, and nothing else.
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

/// Opens Terminal in a clone running `claude`, before any run, so the person can accept Claude's trust question. Only
/// for a folder in a place Gossamr looks for clones.
#[tauri::command]
async fn runs_trust_path(runs: State<'_, RunsState>, path: std::path::PathBuf) -> Result<()> {
    runs.trust_folder(&path).await
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
async fn runs_draft_comment(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<Proposal> {
    runs.ensure_enabled()?;
    let made = core.draft_run_comment(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts the whole plan of a finished Plan run as a comment on its ticket. A draft only: the person edits and approves it.
#[tauri::command]
async fn runs_draft_plan_comment(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<inbox::PlanComment> {
    runs.ensure_enabled()?;
    let made = core.draft_run_plan_comment(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts the ticket's description with the plan of a finished Plan run added. A draft only: the person reads the diff and approves it.
#[tauri::command]
async fn runs_draft_plan_description(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<Proposal> {
    runs.ensure_enabled()?;
    let made = core.draft_run_plan_description(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Reads a build draft's plan again from the plan run it came from, replacing the person's edits to it.
#[tauri::command]
async fn runs_refresh_plan(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<Proposal> {
    runs.ensure_enabled()?;
    let made = core.runs_refresh_plan(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Reads a review draft's builder account again from the build run it came from, replacing the person's edits to it.
#[tauri::command]
async fn runs_refresh_build_account(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<Proposal> {
    runs.ensure_enabled()?;
    let made = core.runs_refresh_build_account(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// Drafts a new ticket from a finished run that has no ticket. A draft only: the person edits and approves it.
#[tauri::command]
async fn runs_draft_ticket(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String) -> Result<Proposal> {
    runs.ensure_enabled()?;
    let made = core.draft_run_ticket(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

/// The project a new ticket from `repo` would most likely belong in, from the tickets its pull requests carry out.
#[tauri::command]
async fn runs_repo_project(core: State<'_, CoreState>, repo: String) -> Result<Option<domain::ContainerRef>> {
    core.repo_project(&repo).await
}

/// Drafts a link saying the run's ticket is blocked by `blocker_key`. A draft only.
#[tauri::command]
async fn runs_draft_blocker(app: AppHandle, core: State<'_, CoreState>, runs: State<'_, RunsState>, id: String, blocker_key: String) -> Result<Proposal> {
    runs.ensure_enabled()?;
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
async fn mark_seen(app: AppHandle, core: State<'_, CoreState>, key: String) -> Result<()> {
    core.mark_seen(&key).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn set_unread(app: AppHandle, core: State<'_, CoreState>, id: String, unread: bool) -> Result<()> {
    core.set_unread(&id, unread).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn set_done(app: AppHandle, core: State<'_, CoreState>, id: String, done: bool) -> Result<()> {
    core.set_done(&id, done).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn snooze(app: AppHandle, core: State<'_, CoreState>, id: String, until: Option<String>) -> Result<()> {
    core.snooze(&id, until.as_deref()).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn transitions(core: State<'_, CoreState>, key: String) -> Result<Vec<Transition>> {
    core.transitions(&core.scope().await?, &key).await
}

#[tauri::command]
async fn transition(app: AppHandle, core: State<'_, CoreState>, scope: Scope, key: String, transition_id: String) -> Result<()> {
    core.transition(&scope, &key, &transition_id).await?;
    cache_changed(&app, &Connection::jira_id(&scope));
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn comment(
    app: AppHandle,
    core: State<'_, CoreState>,
    scope: Scope,
    key: String,
    body: String,
    mentions: Option<Vec<model::MentionRef>>,
    files: Option<Vec<model::Uploaded>>,
) -> Result<()> {
    core.comment(&scope, &key, &body, &mentions.unwrap_or_default(), &files.unwrap_or_default()).await?;
    cache_changed(&app, &Connection::jira_id(&scope));
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn mentionable(core: State<'_, CoreState>, key: String, query: String) -> Result<Vec<model::Person>> {
    core.mentionable(&core.scope().await?, &key, &query).await
}

/// Uploads a file sent as the raw request body; its metadata comes URL-encoded in the `x-file` header, since header
/// values must be ASCII and file names often aren't.
#[tauri::command]
async fn attach(core: State<'_, CoreState>, request: tauri::ipc::Request<'_>) -> Result<model::Uploaded> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Api { status: 400, message: "expected the file as raw bytes".into() });
    };
    let meta: std::collections::HashMap<String, String> = request
        .headers()
        .get("x-file")
        .and_then(|v| v.to_str().ok())
        .map(|v| url::form_urlencoded::parse(v.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let field = |k: &str| meta.get(k).cloned().ok_or_else(|| Error::Api { status: 400, message: format!("missing {k}") });
    let scope = Scope { cloud_id: field("cloudId")?, account_id: field("accountId")? };
    core.attach(&scope, &field("key")?, &field("name")?, &field("type")?, bytes.clone()).await
}

#[tauri::command]
async fn ticket_media(core: State<'_, CoreState>, scope: Scope, key: String) -> Result<std::collections::HashMap<String, String>> {
    core.ticket_media(&scope, &key).await
}

#[tauri::command]
async fn attachment_limit(core: State<'_, CoreState>, scope: Scope) -> Result<Option<u64>> {
    core.attachment_limit(&scope).await
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
async fn ask_claude(app: AppHandle, agent: State<'_, AgentState>, request: AskRequest) -> Result<()> {
    agent
        .ask(request, Arc::new(move |u| {
            let _ = app.emit("claude", u);
        }))
        .await
}

#[tauri::command]
fn cancel_claude(agent: State<'_, AgentState>, request_id: String) {
    agent.cancel(&request_id);
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
                    Err(e) => core.set_error(Some(e.to_string())),
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
        // `attachment://localhost/{id}` serves a Jira attachment to the page, so images load straight into <img>.
        .register_asynchronous_uri_scheme_protocol("attachment", |ctx, request, responder| {
            let core = ctx.app_handle().try_state::<CoreState>().map(|s| s.inner().clone());
            let id = request.uri().path().trim_start_matches('/').to_string();
            tauri::async_runtime::spawn(async move {
                let result = match core {
                    Some(core) => core.attachment(&id).await,
                    None => Err(Error::NotSignedIn),
                };
                let response = match result {
                    Ok((mime, bytes)) => tauri::http::Response::builder()
                        .header(tauri::http::header::CONTENT_TYPE, mime)
                        // Not cached: after a sign-out, another account must not be served this account's files.
                        .header(tauri::http::header::CACHE_CONTROL, "no-store")
                        .body(bytes),
                    Err(e) => tauri::http::Response::builder().status(502).body(e.to_string().into_bytes()),
                };
                responder.respond(response.expect("static response parts"));
            });
        })
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
            let report = match tauri::async_runtime::block_on(runs::report::ReportServer::start(core.clone(), runs::report::config_dir(&core.data_dir()))) {
                Ok(server) => Some(server.channel),
                Err(e) => {
                    eprintln!("the run-report server couldn't start, so runs go without the report tool: {e}");
                    None
                }
            };
            let mut service = runs::service::RunService::new(
                    core.clone(),
                    Arc::new(runs::toolchain::SystemToolchain::default()),
                    runs::index::RunIndex::load(&core.data_dir()),
                    runs::service::RunService::default_roots(),
                    Arc::new(move |connection_id| runs_changed(&runs_handle, connection_id)),
                )
                .with_notifier(Arc::new(RunNotices { app: app.handle().clone(), open: open_on_focus }))
                .with_drafted(Arc::new(move |connection_id| proposals_changed(&drafted_handle, connection_id)))
                .with_settings(config.agents)
                .enabled(config.agents_enabled);
            if let Some(channel) = report {
                service = service.with_report(channel);
            }
            let service = Arc::new(service);
            let handle = app.handle().clone();
            let view_handle = handle.clone();
            let mcp = tauri::async_runtime::block_on(agent::mcp::McpServer::start(
                core.clone(),
                service.clone(),
                Arc::new(move |connection_id| proposals_changed(&handle, connection_id)),
                Arc::new(move |request_id, filter, note| pip_view(&view_handle, request_id, filter, note)),
            ))?;
            app.manage::<LauncherState>(service.clone());
            app.manage::<RunsState>(service.clone());
            spawn_run_tracker(app.handle().clone(), service.clone());
            if config.agents_enabled {
                service.clean_attach_files();
                tauri::async_runtime::spawn(async move {
                    service.warm().await;
                    service.recover().await;
                });
            }
            app.manage::<AgentState>(Arc::new(AgentService::new(core.clone(), mcp, vec![Arc::new(ClaudeCodeProvider::new())], config)));

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
            cache_workflow,
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
            proposals_approve,
            runs_enabled,
            runs_set_enabled,
            runs_settings,
            runs_set_settings,
            runs_cleanup,
            runs_review,
            runs_draft,
            runs_approve,
            runs_preflight,
            runs_start_now,
            runs_retry_launch,
            runs_repos,
            runs_clones,
            runs_clone_fresh,
            runs_pick_clone,
            runs_suggest_name,
            runs_stop,
            runs_answer,
            runs_send_follow_up,
            runs_adopt_session,
            runs_stop_all,
            runs_attach,
            runs_trust_folder,
            runs_trust_path,
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
            runs_refresh_plan,
            runs_refresh_build_account,
            runs_draft_ticket,
            runs_repo_project,
            runs_get,
            sync_now,
            mark_seen,
            set_unread,
            set_done,
            snooze,
            transitions,
            transition,
            comment,
            attach,
            attachment_limit,
            ticket_media,
            mentionable,
            create_subtasks,
            claude_sessions,
            ask_claude,
            cancel_claude
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
