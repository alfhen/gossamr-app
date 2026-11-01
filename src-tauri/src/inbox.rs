use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{Duration, SecondsFormat, Utc};
use tokio::sync::Notify;

use crate::connections::Binding;
use crate::auth::{Account, Auth, AuthStatus, Scope, Site, TokenSignIn};
use crate::db::{stamp, Db};
use crate::error::{Error, Result};
use crate::events::{changes_since, derive, my_actions, NewEvent};
use crate::domain::{
    Comment, Container, ContainerRef, Event, FeedPage, FeedQuery, Filter, FilterContext, Identity, ItemRef, PersonRef, Visible, WorkItem, Workflow,
};
use crate::model::{CachedTicket, Person, Snapshot, Status, Ticket, Transition};
use crate::proposals;
use crate::runs::ask::Asks;
use crate::sync::{self, Schedule, Trigger, CLOCK_SKEW_MINUTES};
use crate::tracker::{self, Connection, Move, Registry, WorkTracker};

pub(crate) mod code;
mod drafts;
mod instances;
mod probes;
mod run_outcome;
mod pip_runs;
mod pip_turns;
mod report;
mod rewrites;
mod ticket_context;
mod workstreams;
pub use pip_runs::{PipRunAsk, PipStart};
#[cfg(test)]
pub(crate) use workstreams::{basis_of, drifted};
pub use ticket_context::TicketRead;
pub use workstreams::{Adoptable, WorkstreamUndo, WorkstreamView, NOTES_CLOSE, NOTES_LIMIT, NOTES_OPEN};
pub use rewrites::TextSeen;
mod watch;

pub use code::{CodeRef, CodeService};
pub use drafts::Edit;
pub use run_outcome::{RunOutcome, SUMMARY_ONLY};
pub use probes::Probe;
pub use watch::{CatalogPage, WatchState};

/// Events this old drop out of the inbox unless they are still unread.
const EVENT_WINDOW_DAYS: i64 = 30;
/// How far back My work can reach.
const ACTIVITY_DAYS: i64 = 30;
/// Before a ticket has been opened in the app, "since you last looked" covers this many days.
const DEFAULT_SEEN_DAYS: i64 = 3;

const LAST_SYNC: &str = "last_sync_at";
const CACHE_BACKFILLED: &str = "cache_backfilled";
const EVENTS_BACKFILLED: &str = "events_backfilled";
const PIP_SESSIONS: &str = "pip_sessions";
pub(crate) const OWN_SESSIONS_KEPT: usize = 50;
const ANNOUNCED_NEEDS: &str = "announced_needs";

/// Events after this are new since the previous sync (or, before the first sync, from the last 24 hours).
fn unread_cutoff(last_sync: Option<&str>) -> String {
    match last_sync.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(at) => (at.with_timezone(&Utc) - Duration::minutes(i64::from(CLOCK_SKEW_MINUTES))).to_rfc3339_opts(SecondsFormat::Secs, true),
        None => ago(Duration::hours(24)),
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// `now_iso` to the millisecond, for rows that are ordered by when they were written.
fn now_millis() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn ago(d: Duration) -> String {
    (Utc::now() - d).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Drafts, runs, workstreams and Pip's conversations, shared by every connection.
const APP_DB: &str = "app.sqlite";

/// Separate cache files per site and account, so two people signing in on one Mac never see each other's tickets. Drafts
/// and runs share `APP_DB`; `Db::for_connection` keeps each account's out of the other's view.
fn db_file(connection: &Connection) -> String {
    let safe = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect::<String>();
    format!("inbox-{}-{}.sqlite", safe(&connection.workspace), safe(&connection.account))
}

/// The ticket a tracker left in `extra` for the inbox.
fn ticket_of(item: &WorkItem) -> Result<CachedTicket> {
    Ok(serde_json::from_value(item.extra.clone())?)
}

pub(crate) fn tickets_of(items: &[WorkItem]) -> Result<Vec<CachedTicket>> {
    items.iter().map(ticket_of).collect()
}

fn identity_of(connection_id: &str, me: &Account) -> Identity {
    Identity {
        display_name: me.name.clone(),
        accounts: vec![PersonRef { connection_id: connection_id.into(), account_id: me.account_id.clone() }],
    }
}

fn without_extra(mut item: WorkItem) -> WorkItem {
    item.extra = serde_json::Value::Null;
    item
}

/// Fills the cache from tickets stored before it existed, once, keeping when each was last refreshed. The old table
/// is left as it was.
fn backfill_cache(db: &Db, connection: &Connection) -> Result<()> {
    if db.meta(CACHE_BACKFILLED)?.is_none() {
        for (ticket, synced_at) in db.legacy_tickets()? {
            if let Some(item) = tracker::item_from_ticket(connection, &ticket) {
                db.upsert_items(&[item], &synced_at)?;
            }
        }
        db.set_meta(CACHE_BACKFILLED, &now_iso())?;
    }
    if db.meta(EVENTS_BACKFILLED)?.is_none() {
        let stored: Vec<Event> = db
            .events("")?
            .into_iter()
            .filter(|e| e.kind != crate::model::EventKind::Field)
            .filter_map(|e| {
                let e = NewEvent { id: e.id, kind: e.kind, ticket_key: e.ticket_key, actor: e.actor, at: e.at, text: e.text, field: None };
                sync::domain_event(&connection.id, &e)
            })
            .collect();
        db.insert_cache_events(&stored)?;
        db.set_meta(EVENTS_BACKFILLED, &now_iso())?;
    }
    Ok(())
}

/// A signed-in connection as Settings shows it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    /// The row in Settings this connection belongs to.
    pub instance_id: String,
    pub display_name: String,
    pub enabled: bool,
    pub kind: tracker::ConnectionKind,
    /// The site or organisation.
    pub workspace: String,
    pub url: String,
    /// The person's name on it.
    pub account: String,
    pub last_sync_at: Option<String>,
    pub syncing: bool,
    pub error: Option<String>,
    /// The error is a network failure that the next sync tries again, so it isn't worth interrupting anyone with.
    pub transient: bool,
    /// Jira turned down the API token, so a new one is the only way to sync.
    pub reauth: bool,
    /// What the last probe of the instance found, once there is one.
    pub status: Option<crate::probe::Snapshot>,
    /// It was turned back on and its first sync hasn't finished, so its waiting drafts are still being checked.
    pub rechecking: bool,
}

#[derive(Default)]
struct Open {
    /// `app.sqlite` alone, opened on first use and kept for the life of the app.
    app: Option<Db>,
    /// One cache per connection, opened for whichever is signed in. A connection is a site and an account, so two
    /// people signing in to the same site on one Mac never see each other's tickets or inbox.
    cache: Option<(String, Db)>,
}

pub struct Core {
    pub auth: Arc<Auth>,
    registry: Registry,
    code: CodeService,
    data_dir: PathBuf,
    /// Clones a run may use have to be under this folder.
    home: Option<PathBuf>,
    /// The databases, behind one lock so the app database is never written from two handles at once.
    db: Mutex<Open>,
    last_error: Mutex<Option<String>>,
    reauth_needed: AtomicBool,
    probes: probes::Probes,
    syncing: AtomicBool,
    schedules: Mutex<HashMap<String, Schedule>>,
    /// When each connection was last checked for work assigned outside what it watches.
    radar: Mutex<HashMap<String, chrono::DateTime<Utc>>>,
    /// The questions agents are waiting on, which the MCP server fills and the run service answers.
    asks: Asks,
    /// Ask for a sync now, whatever the schedule says.
    pub wake: Notify,
    /// Held across a whole connect or sign-out, so a slow connect can't land after a sign-out or beside another connect.
    sign_in: tokio::sync::Mutex<()>,
    /// Held while a draft is claimed for posting and while a connection is turned off, so a draft can't be claimed after the check that said its connection was on.
    draft_gate: tokio::sync::Mutex<()>,
    /// The window gained focus: sync if it has been a while and no failure is being waited out.
    pub focus: Notify,
}

/// What a sync left behind.
pub struct Synced {
    pub connection_id: String,
    /// Whether any cached item was added or changed.
    pub changed: bool,
    /// Whether reconciling the drafts against the fresh cache revised or retired any.
    pub proposals_changed: bool,
    /// Whether the watch settings changed, as when a small catalog was watched whole.
    pub watch_changed: bool,
}

impl Core {
    pub fn new(auth: Arc<Auth>, registry: Registry, data_dir: PathBuf) -> Self {
        Self {
            auth,
            registry,
            code: CodeService::new(crate::net::client()),
            data_dir,
            home: dirs::home_dir().and_then(|h| h.canonicalize().ok()),
            db: Mutex::new(Open::default()),
            last_error: Mutex::new(None),
            reauth_needed: AtomicBool::new(false),
            probes: probes::Probes::default(),
            syncing: AtomicBool::new(false),
            schedules: Mutex::new(HashMap::new()),
            radar: Mutex::new(HashMap::new()),
            asks: Asks::default(),
            wake: Notify::new(),
            sign_in: tokio::sync::Mutex::new(()),
            draft_gate: tokio::sync::Mutex::new(()),
            focus: Notify::new(),
        }
    }

    pub fn asks(&self) -> &Asks {
        &self.asks
    }

    #[cfg(test)]
    pub fn with_home(mut self, home: PathBuf) -> Self {
        self.home = home.canonicalize().ok();
        self
    }

    /// Replaces the GitHub service, for an app that shares one HTTP client, or a test that scripts GitHub.
    pub fn with_code(mut self, code: CodeService) -> Self {
        self.code = code;
        self
    }

    /// The registered connection for `scope`. Callers still hold a `Scope`, so this is the adapter between the two;
    /// a scope that isn't registered is one the person has since signed out of or replaced.
    fn connection(&self, scope: &Scope) -> Result<Connection> {
        self.registry.connection(&scope.connection_id).ok_or(Error::SiteChanged)
    }

    fn tracker(&self, scope: &Scope) -> Result<Arc<dyn WorkTracker>> {
        Ok(self.registry.tracker(&self.connection(scope)?))
    }

    fn item(scope: &Scope, key: &str) -> ItemRef {
        ItemRef { connection_id: scope.connection_id.clone(), external_id: key.into(), key: key.into() }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    /// Signs in with an API token and registers the resulting connection.
    pub async fn connect_jira(&self, input: &TokenSignIn) -> Result<AuthStatus> {
        let _alone = self.sign_in.lock().await;
        let previous = self.auth.connection().await;
        let connection = self.auth.connect(input).await?;
        if let Some((_, site, _)) = self.auth.identity().await {
            self.bind_instance(Binding::jira(&connection.id, &site.name, &site.url).with_email(input.email.trim()));
        }
        self.replace_connection(previous, connection);
        self.auth.status().await
    }

    /// Registers `connection`, and drops `previous` if it was another account: a registered connection is the proof
    /// `with_app_db_for` relies on that its scope is still signed in.
    fn replace_connection(&self, previous: Option<Connection>, connection: Connection) {
        if let Some(previous) = previous.filter(|p| p.id != connection.id) {
            self.registry.remove(&previous.id);
        }
        self.registry.register(connection);
    }

    /// Registers the connection restored from the Keychain, if any.
    pub async fn restore(&self) {
        if let Some(connection) = self.auth.connection().await {
            self.registry.register(connection);
        }
        self.restore_code().await;
    }

    pub async fn sign_out(&self) -> Result<()> {
        let _alone = self.sign_in.lock().await;
        if let Some(c) = self.auth.connection().await {
            self.auth.disconnect(&c.id).await?;
            self.registry.remove(&c.id);
        }
        self.close_db();
        self.settle_pip_turns(crate::db::SIGNED_OUT).await;
        Ok(())
    }

    /// Late writes for a connection that has left the registry are refused, so the turns it was running would stay
    /// open until the next launch.
    /// Bookkeeping only: a failure is logged and never blocks signing out or removing a connection.
    async fn settle_pip_turns(&self, reason: &str) {
        if let Err(e) = self.with_app_db(|db| db.fail_open_pip_turns(reason).map(drop)).await {
            eprintln!("couldn't fail the Pip turns that were still open: {e}");
        }
    }

    async fn identity(&self) -> Result<(Scope, Site, Account)> {
        self.auth.identity().await.ok_or(Error::NotSignedIn)
    }

    async fn with_db<T>(&self, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let (scope, _, _) = self.identity().await?;
        self.with_db_for(&scope, f).await
    }

    /// Runs `f` against `scope`'s database, but only if that site and account are still the signed-in ones. Work
    /// that fetched data before someone signed in elsewhere must not land in the new session's database.
    async fn with_db_for<T>(&self, scope: &Scope, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let (current, _, _) = self.identity().await?;
        if &current != scope {
            return Err(Error::SiteChanged);
        }
        let connection = self.connection(scope)?;
        let mut open = self.db.lock().expect("db lock poisoned");
        self.open_app(&mut open)?;
        if open.cache.as_ref().map(|(id, _)| *id != connection.id).unwrap_or(true) {
            let db = Db::open_with_app(&self.data_dir.join(db_file(&connection)), &self.data_dir.join(APP_DB))?.for_connection(&connection.id);
            backfill_cache(&db, &connection)?;
            open.cache = Some((connection.id.clone(), db));
        }
        f(&open.cache.as_ref().expect("opened above").1)
    }

    /// The app database, opened on first use, which is also when what a closed app left half done is settled. That must
    /// stay once per launch: a draft this launch is posting would otherwise be reset to pending.
    fn open_app<'a>(&self, open: &'a mut Open) -> Result<&'a mut Db> {
        if open.app.is_none() {
            let db = Db::open_app(&self.data_dir.join(APP_DB))?;
            db.release_interrupted(Utc::now())?;
            db.fail_interrupted_pip_turns()?;
            open.app = Some(db);
        }
        Ok(open.app.as_mut().expect("opened above"))
    }

    /// Runs `f` against the app database, for work that touches only app tables and needs no one signed in. Drafts and
    /// runs of every connection are visible; `with_app_db_for` limits them to one.
    async fn with_app_db<T>(&self, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let mut open = self.db.lock().expect("db lock poisoned");
        f(self.open_app(&mut open)?)
    }

    /// `with_app_db` limited to `scope`'s drafts and runs, and only while its connection is still registered.
    async fn with_app_db_for<T>(&self, scope: &Scope, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        self.connection(scope)?;
        let mut open = self.db.lock().expect("db lock poisoned");
        self.open_app(&mut open)?.homed(&scope.connection_id, f)
    }

    async fn with_app_db_atomically_for<T>(&self, scope: &Scope, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        self.with_app_db_for(scope, |db| db.atomically(f)).await
    }

    /// `with_db_for` as one transaction: everything `f` writes (a change and its audit line) lands together, or nothing does.
    async fn with_db_atomically_for<T>(&self, scope: &Scope, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        self.with_db_for(scope, |db| db.atomically(f)).await
    }

    /// Lets go of the signed-in connection's cache. The app database stays open: recovery runs once per launch.
    pub fn close_db(&self) {
        self.db.lock().expect("db lock poisoned").cache = None;
    }

    /// What quitting and opening the app does to the databases.
    #[cfg(test)]
    pub fn restart(&self) {
        *self.db.lock().expect("db lock poisoned") = Open::default();
    }

    pub fn set_error(&self, e: Option<String>) {
        self.reauth_needed.store(false, Ordering::SeqCst);
        *self.last_error.lock().expect("error lock poisoned") = e;
    }

    /// Records a failed sync, remembering whether only a new sign-in can fix it.
    pub fn set_sync_failure(&self, e: &Error) {
        self.set_error(Some(e.to_string()));
        self.reauth_needed.store(e.needs_reauth(), Ordering::SeqCst);
    }

    /// Runs a sync if `trigger` says this connection is due one, and records how it went for the backoff.
    pub async fn sync_if_due(&self, trigger: Trigger) -> Option<Result<Synced>> {
        let (scope, _, _) = self.auth.identity().await?;
        let id = scope.connection_id;
        if self.off_name(&id).is_some() {
            return None;
        }
        let due = self.schedules.lock().expect("schedule lock poisoned").entry(id.clone()).or_default().due(Utc::now(), trigger);
        if !due {
            return None;
        }
        self.syncing.store(true, Ordering::SeqCst);
        let result = self.sync().await;
        self.syncing.store(false, Ordering::SeqCst);
        let mut schedules = self.schedules.lock().expect("schedule lock poisoned");
        let schedule = schedules.entry(id).or_default();
        schedule.finished(Utc::now(), result.is_ok());
        if let Err(Error::RateLimited { retry_after_secs, .. }) = &result {
            schedule.defer(Utc::now() + Duration::seconds(i64::try_from(*retry_after_secs).unwrap_or(i64::MAX / 1000)));
        }
        drop(schedules);
        Some(result)
    }

    /// Fetches what changed since the last sync (or everything, when due) and stores it in the cache.
    pub async fn sync(&self) -> Result<Synced> {
        let (scope, _, me) = self.identity().await?;
        let connection_id = scope.connection_id.clone();
        let started = Utc::now();
        let (previous, state, known_epics, watch) = self
            .with_db_for(&scope, |db| {
                let last = db.meta(LAST_SYNC)?;
                let epics = db.epic_ids_synced_since(&connection_id, &stamp(started - Duration::days(1)))?;
                Ok((last, db.sync_state(&connection_id)?, epics, db.watch_set(&connection_id)?))
            })
            .await?;
        let unread_after = unread_cutoff(previous.as_deref());
        let tracker = self.tracker(&scope)?;
        let (watch, watch_changed) = self.settle_watch_mode(&scope, tracker.as_ref(), watch).await?;
        let plan = sync::plan(&state, started);
        let pulled = sync::pull(tracker.as_ref(), &connection_id, plan, &state, &known_epics, &unread_after, started, &watch).await?;

        self.with_db_for(&scope, |db| {
            let stored = sync::store(db, &connection_id, &me.account_id, &pulled, plan, started, &unread_after)?;
            db.set_meta(LAST_SYNC, &stamp(started))?;
            let containers_changed = pulled.containers.is_some();
            // A draft that can't be re-judged must not stop the items from syncing, but it keeps the connection's drafts held.
            let revised = match proposals::reconcile_pending(db, &identity_of(&connection_id, &me), Utc::now()) {
                Ok(revised) => {
                    self.finish_recheck(&connection_id, started);
                    revised
                }
                Err(e) => {
                    eprintln!("couldn't re-judge the waiting drafts of {connection_id}: {e}");
                    0
                }
            };
            Ok(Synced {
                connection_id: connection_id.clone(),
                changed: stored.upserted.any() || containers_changed,
                proposals_changed: revised > 0,
                watch_changed,
            })
        })
        .await
    }

    /// Re-reads one issue after a write so the UI shows the result without waiting for the next sync.
    async fn refresh(&self, scope: &Scope, key: &str) -> Result<()> {
        let last_sync = self.with_db_for(scope, |db| db.meta(LAST_SYNC)).await?;
        let since = unread_cutoff(last_sync.as_deref());
        let target = Self::item(scope, key);
        let item = match self.tracker(scope)?.item(&target, &since).await {
            Err(e @ Error::Api { status: 404, .. }) => {
                self.with_db_for(scope, |db| db.forget_item(&target)).await?;
                return Err(e);
            }
            other => other?,
        };
        let t = ticket_of(&item)?;
        let connection_id = scope.connection_id.clone();
        self.with_db_for(scope, |db| {
            // An item the person was handed in a container they don't watch isn't kept.
            if !db.watch_set(&item.item.connection_id)?.is_watched(&item.container.external_id) {
                return Ok(());
            }
            db.upsert_items(&[item], &now_iso())?;
            let events = derive(&t, &scope.account_id);
            db.insert_events(&events, &since)?;
            db.insert_cache_events(&events.iter().filter_map(|e| sync::domain_event(&connection_id, e)).collect::<Vec<_>>())?;
            db.insert_activity(&my_actions(&t, &scope.account_id))?;
            Ok(())
        })
        .await
    }

    pub async fn snapshot(&self) -> Result<Snapshot> {
        let (scope, site, me) = self.identity().await?;
        let sync_error = self.last_error.lock().expect("error lock poisoned").clone();
        // The identity above labels the snapshot, so the data must come from that same account's database.
        self.with_db_for(&scope.clone(), |db| {
            let last_sync = db.meta(LAST_SYNC)?;
            // Tickets refreshed within a day of the last sync; older ones have dropped out of every query.
            let cutoff = last_sync
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| (d.with_timezone(&Utc) - Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true))
                .unwrap_or_default();
            let connection_id = scope.connection_id.clone();
            let off = self.off_name(&connection_id).is_some();
            let visible = db.watch_set(&connection_id)?.visible();
            let cached = if off { Vec::new() } else { tickets_of(&db.items_synced_since(&connection_id, &cutoff, &visible)?)? };
            let keys = db.visible_keys(&connection_id, &visible)?;
            let shown = |key: &str| !off && keys.as_ref().is_none_or(|k| k.contains(key));
            let seen = db.seen()?;
            let default_since = ago(Duration::days(DEFAULT_SEEN_DAYS));

            let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for t in &cached {
                if let Some(p) = &t.parent {
                    children.entry(p.key.clone()).or_default().push(t.key.clone());
                }
            }
            let watching = cached.iter().filter(|t| t.watching).map(|t| t.key.clone()).collect();
            let tickets = cached
                .into_iter()
                .map(|t| {
                    let since = seen.get(&t.key).cloned().unwrap_or_else(|| default_since.clone());
                    let ticket = Ticket {
                        changes: changes_since(&t, &me.account_id, &since),
                        children: if t.is_epic { children.remove(&t.key).unwrap_or_default() } else { Vec::new() },
                        url: format!("{}/browse/{}", site.url.trim_end_matches('/'), t.key),
                        key: t.key,
                        summary: t.summary,
                        issue_type: t.issue_type,
                        status: t.status,
                        priority: t.priority,
                        assignee: t.assignee,
                        reporter: t.reporter,
                        parent: t.parent,
                        description: t.description,
                        description_doc: t.description_doc,
                        comments: t.comments,
                        attachments: t.attachments,
                        subtasks: t.subtasks,
                        due_date: t.due_date,
                        sprint: None,
                        updated: t.updated,
                        resolved: t.resolved,
                    };
                    (ticket.key.clone(), ticket)
                })
                .collect();

            Ok(Snapshot {
                me: Person { account_id: me.account_id.clone(), name: me.name.clone(), avatar_url: me.avatar_url.clone() },
                site: site.name.clone(),
                tickets,
                events: db.events(&ago(Duration::days(EVENT_WINDOW_DAYS)))?.into_iter().filter(|e| shown(&e.ticket_key)).collect(),
                watching,
                last_sync_at: last_sync,
                sync_error,
                activity: db.activity(&ago(Duration::days(ACTIVITY_DAYS)))?.into_iter().filter(|a| shown(&a.ticket_key)).collect(),
            })
        })
        .await
    }

    pub async fn set_unread(&self, id: &str, unread: bool) -> Result<()> {
        self.with_db(|db| db.set_unread(id, unread)).await
    }

    /// The signed-in scope, for work that starts now.
    pub async fn scope(&self) -> Result<Scope> {
        let (scope, _, _) = self.identity().await?;
        Ok(scope)
    }

    /// The moves open to a ticket. A move's id is its target status.
    pub async fn transitions(&self, scope: &Scope, key: &str) -> Result<Vec<Transition>> {
        self.refuse_hidden(&scope.connection_id)?;
        let moves = self.tracker(scope)?.transitions(&Self::item(scope, key)).await?;
        Ok(moves.into_iter().map(|m| Transition { id: m.to.id.clone(), name: m.name, to: Status::from(&m.to) }).collect())
    }

    pub async fn mentionable(&self, scope: &Scope, key: &str, query: &str) -> Result<Vec<Person>> {
        let people = self.tracker(scope)?.people(&Self::item(scope, key), query).await?;
        Ok(people
            .into_iter()
            .map(|p| Person { account_id: p.person_ref.account_id, name: p.display_name, avatar_url: p.avatar_url })
            .collect())
    }

    /// Re-reads a ticket after a successful write. A failure here must not be reported as a failed write, or a retry
    /// would post the comment twice; the next sync picks the change up instead.
    async fn after_write(&self, scope: &Scope, key: &str) {
        if let Err(e) = self.refresh(scope, key).await {
            self.set_error(Some(format!("Saved, but couldn't refresh {key}: {e}")));
            self.wake.notify_one();
        }
    }

    /// The cached item, or a fresh read from Jira when it isn't cached.
    pub async fn work_item(&self, scope: &Scope, key: &str) -> Result<WorkItem> {
        self.refuse_hidden(&scope.connection_id)?;
        let item = Self::item(scope, key);
        let (cached, last_sync) = self.with_db_for(scope, |db| Ok((db.item(&item)?, db.meta(LAST_SYNC)?))).await?;
        match cached {
            Some(item) => Ok(item),
            None => self.tracker(scope)?.item(&item, &unread_cutoff(last_sync.as_deref())).await,
        }
    }

    /// The cached items that match `filter`. The raw tracker payload is left out; it is for Core, not for the page.
    pub async fn cache_search(&self, filter: &Filter, include_unwatched: bool) -> Result<Vec<WorkItem>> {
        let scope = self.scope().await?;
        Ok(self.search_cached_with(&scope, filter, include_unwatched).await?.into_iter().map(without_extra).collect())
    }

    /// Like `cache_search`, for `scope` only, and with each item's tracker payload kept. Only watched containers.
    pub async fn search_cached(&self, scope: &Scope, filter: &Filter) -> Result<Vec<WorkItem>> {
        self.search_cached_with(scope, filter, false).await
    }

    async fn search_cached_with(&self, scope: &Scope, filter: &Filter, include_unwatched: bool) -> Result<Vec<WorkItem>> {
        let (current, _, me) = self.identity().await?;
        if &current != scope {
            return Err(Error::SiteChanged);
        }
        let connection_id = scope.connection_id.clone();
        if self.off_name(&connection_id).is_some() {
            return Ok(Vec::new());
        }
        let now = Utc::now();
        self.with_db_for(scope, |db| {
            let visible = if include_unwatched { Visible::All } else { db.watch_set(&connection_id)?.visible() };
            let needs_me = db
                .needs_me_keys(&connection_id, &me.account_id, &stamp(now), &visible)?
                .into_iter()
                .map(|key| ItemRef { connection_id: connection_id.clone(), external_id: key.clone(), key })
                .collect();
            let me = identity_of(&connection_id, &me);
            db.search(&connection_id, filter, &FilterContext { me, now, needs_me }, &visible)
        })
        .await
    }

    pub async fn cache_containers(&self, include_unwatched: bool) -> Result<Vec<Container>> {
        let scope = self.scope().await?;
        self.containers_with(&scope, include_unwatched).await
    }

    /// The watched containers of `scope`'s connection.
    pub async fn containers_in(&self, scope: &Scope) -> Result<Vec<Container>> {
        self.containers_with(scope, false).await
    }

    async fn containers_with(&self, scope: &Scope, include_unwatched: bool) -> Result<Vec<Container>> {
        let id = scope.connection_id.clone();
        if self.off_name(&id).is_some() {
            return Ok(Vec::new());
        }
        self.with_db_for(scope, |db| {
            let visible = if include_unwatched { Visible::All } else { db.watch_set(&id)?.visible() };
            Ok(db.containers(&id)?.into_iter().filter(|c| visible.allows(&c.container_ref.external_id)).collect())
        })
        .await
    }

    pub async fn workflow_in(&self, scope: &Scope, container: &ContainerRef) -> Result<Option<Workflow>> {
        self.with_db_for(scope, |db| db.workflow(container)).await
    }

    /// The signed-in person, across connections.
    pub async fn cache_me(&self) -> Result<Identity> {
        let (scope, _, me) = self.identity().await?;
        Ok(identity_of(&scope.connection_id, &me))
    }

    /// People named on cached tickets, so views can show a name for an account id.
    pub async fn cache_people(&self) -> Result<Vec<Person>> {
        let scope = self.scope().await?;
        let mut seen: HashMap<String, Person> = HashMap::new();
        for item in self.search_cached(&scope, &Filter::And { filters: vec![] }).await? {
            let t = ticket_of(&item)?;
            for p in people_on(&t) {
                seen.entry(p.account_id.clone()).or_insert_with(|| p.clone());
            }
        }
        Ok(seen.into_values().collect())
    }

    /// An item's comments, oldest first. From the cache unless `refresh`, which reads them from the tracker and
    /// falls back to the cached ones when it can't be reached.
    pub async fn cache_comments(&self, item: &ItemRef, refresh: bool) -> Result<Vec<Comment>> {
        let scope = self.scope().await?;
        let connection = self.connection(&scope)?;
        if item.connection_id != connection.id {
            return Err(Error::SiteChanged);
        }
        if self.off_name(&connection.id).is_some() {
            return Ok(Vec::new());
        }
        if refresh {
            if let Ok(live) = self.tracker(&scope)?.comments(item).await {
                return Ok(live);
            }
        }
        match self.with_db_for(&scope, |db| db.item(item)).await? {
            Some(cached) => Ok(tracker::comments_from_ticket(&connection, &ticket_of(&cached)?)),
            None => Ok(Vec::new()),
        }
    }

    /// The moves open to an item right now; Jira reveals them per item.
    pub async fn cache_transitions(&self, item: &ItemRef) -> Result<Vec<Move>> {
        let scope = self.scope().await?;
        if item.connection_id != scope.connection_id {
            return Err(Error::SiteChanged);
        }
        if self.off_name(&scope.connection_id).is_some() {
            return Ok(Vec::new());
        }
        self.tracker(&scope)?.transitions(item).await
    }

    /// The signed-in connection with how its sync is going.
    pub async fn connections(&self) -> Result<Vec<ConnectionInfo>> {
        let mut out = Vec::new();
        if let Some((scope, site, me)) = self.auth.identity().await {
            let connection = self.connection(&scope)?;
            let last_sync_at = self.with_db_for(&scope, |db| db.meta(LAST_SYNC)).await?;
            out.push(ConnectionInfo {
                instance_id: connection.id.clone(),
                display_name: site.name.clone(),
                enabled: true,
                id: connection.id,
                kind: connection.kind,
                workspace: site.name,
                url: site.url,
                account: me.name,
                last_sync_at,
                syncing: self.syncing.load(Ordering::SeqCst),
                error: self.last_error.lock().expect("error lock poisoned").clone(),
                transient: false,
                reauth: self.reauth_needed.load(Ordering::SeqCst),
                status: None,
                rechecking: false,
            });
        }
        out.extend(self.code_connections());
        self.name_instances(&mut out);
        Ok(out)
    }

    pub async fn cache_events(&self, item: &ItemRef, limit: usize) -> Result<Vec<Event>> {
        let scope = self.scope().await?;
        if self.off_name(&scope.connection_id).is_some() {
            return Ok(Vec::new());
        }
        self.with_db_for(&scope, |db| db.events_for_item(item, limit)).await
    }

    pub async fn cache_feed(&self, query: &FeedQuery) -> Result<FeedPage> {
        let scope = self.scope().await?;
        let id = self.connection(&scope)?.id;
        if self.off_name(&id).is_some() {
            return Ok(FeedPage { entries: Vec::new(), next: None });
        }
        self.with_db_for(&scope, |db| {
            let visible = if query.include_unwatched { Visible::All } else { db.watch_set(&id)?.visible() };
            db.feed(&id, query, &visible)
        })
        .await
    }

    /// How many feed entries are unread, of `kinds` (every kind when empty).
    pub async fn cache_feed_unread(&self, kinds: &[crate::domain::EventKind]) -> Result<usize> {
        let scope = self.scope().await?;
        let id = self.connection(&scope)?.id;
        if self.off_name(&id).is_some() {
            return Ok(0);
        }
        self.with_db_for(&scope, |db| db.feed_unread(&id, kinds, &db.watch_set(&id)?.visible())).await
    }

    /// The Needs you items already announced by a system notice, kept between launches; `None` before any were recorded.
    pub async fn announced_needs(&self, scope: &Scope) -> Result<Option<std::collections::BTreeSet<String>>> {
        self.with_db_for(scope, |db| Ok(db.meta(ANNOUNCED_NEEDS)?.and_then(|s| serde_json::from_str(&s).ok()))).await
    }

    pub async fn remember_announced_needs(&self, scope: &Scope, keys: &std::collections::BTreeSet<String>) -> Result<()> {
        self.with_db_for(scope, |db| db.set_meta(ANNOUNCED_NEEDS, &serde_json::to_string(keys)?)).await
    }

    /// Records a session started in Pip's sandbox folder, and as the one to continue for `key` when there is one.
    /// Sessions recorded by earlier versions, which ran in a user-chosen folder, never enter this list.
    pub async fn remember_claude_session(&self, scope: &Scope, key: Option<&str>, session_id: &str) -> Result<()> {
        self.with_app_db_for(scope, |db| {
            if let Some(key) = key {
                db.set_app_meta(&format!("claude:{key}"), &serde_json::json!({ "id": session_id }).to_string())?;
            }
            let mut own: Vec<String> =
                db.app_meta(PIP_SESSIONS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            own.retain(|s| s != session_id);
            own.insert(0, session_id.to_string());
            own.truncate(OWN_SESSIONS_KEPT);
            db.set_app_meta(PIP_SESSIONS, &serde_json::to_string(&own)?)
        })
        .await
    }

    /// Whether Pip started `session_id` in its sandbox folder, which is the only place it can be resumed from: one of the
    /// last sessions it started, or the session of an open workstream, which stays resumable however long it runs.
    pub async fn is_pip_session(&self, session_id: &str) -> Result<bool> {
        self.with_app_db(|db| {
            let own: Vec<String> = db.app_meta(PIP_SESSIONS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            Ok(own.iter().any(|s| s == session_id) || db.is_open_workstream_session(session_id)?)
        })
        .await
    }
}

/// Everyone a ticket names, including those who only appear in its history.
fn people_on(t: &crate::model::CachedTicket) -> impl Iterator<Item = &Person> {
    let comment_authors = t.comments.iter().map(|c| &c.author);
    let editors = t.history.iter().map(|h| &h.author);
    t.assignee.iter().chain(t.reporter.iter()).chain(t.creator.iter()).chain(comment_authors).chain(editors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Doc;

    #[test]
    fn people_include_those_who_only_appear_in_history() {
        let mut t = crate::tracker::testing::sample_ticket();
        t.comments.clear();
        t.history[0].author = Person { account_id: "557058:f58".into(), name: "Leigh".into(), avatar_url: None };
        assert!(people_on(&t).any(|p| p.account_id == "557058:f58" && p.name == "Leigh"));
    }

    #[tokio::test]
    async fn only_sessions_started_in_the_sandbox_can_be_resumed() {
        let fx = super::testing::fixture().await;
        fx.core
            .with_db(|db| db.set_app_meta("claude:CA-1", r#"{"id":"old-1","cwd":"/Users/me/code/app"}"#))
            .await
            .unwrap();
        assert!(!fx.core.is_pip_session("old-1").await.unwrap());

        fx.core.remember_claude_session(&fx.scope, Some("CA-1"), "new-1").await.unwrap();
        fx.core.remember_claude_session(&fx.scope, None, "ws-1").await.unwrap();
        assert!(fx.core.is_pip_session("new-1").await.unwrap() && fx.core.is_pip_session("ws-1").await.unwrap());
        assert!(!fx.core.is_pip_session("old-1").await.unwrap());
    }

    #[tokio::test]
    async fn a_workstream_s_session_stays_resumable_however_many_others_are_remembered() {
        let fx = super::testing::fixture().await;
        let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
        fx.core.remember_claude_session(&fx.scope, None, "ws-session").await.unwrap();
        fx.core.remember_claude_session(&fx.scope, None, "loose-session").await.unwrap();
        fx.core.set_workstream_session(&fx.scope, &ws.id, "ws-session").await.unwrap();
        for n in 0..60 {
            fx.core.remember_claude_session(&fx.scope, None, &format!("other-{n}")).await.unwrap();
        }
        assert!(fx.core.is_pip_session("ws-session").await.unwrap(), "pinned by its workstream");
        assert!(!fx.core.is_pip_session("loose-session").await.unwrap(), "the list itself still keeps only the last 50");
        assert!(fx.core.is_pip_session("other-59").await.unwrap() && !fx.core.is_pip_session("other-0").await.unwrap());

        fx.core.close_workstream(&fx.scope, &ws.id).await.unwrap();
        assert!(!fx.core.is_pip_session("ws-session").await.unwrap(), "closing the workstream lets it go");
    }

    #[tokio::test]
    async fn the_app_database_opens_with_no_one_signed_in_and_touches_no_cache() {
        let dir = std::env::temp_dir().join(format!("gossamr-app-only-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let core = Core::new(Arc::new(Auth::signed_out(reqwest::Client::new())), Registry::new(|_| unreachable!("no tracker is asked")), dir.clone());

        core.with_app_db(|db| db.set_app_meta("claude:CA-1", r#"{"id":"s-1"}"#)).await.unwrap();
        core.with_app_db(|db| db.set_app_meta(PIP_SESSIONS, r#"["s-1"]"#)).await.unwrap();
        assert!(core.is_pip_session("s-1").await.unwrap());
        assert!(core.pip_turns("general").await.unwrap().is_empty());
        assert!(core.with_db(|_| Ok(())).await.is_err(), "a cache still needs the sign-in");

        let files: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| !n.starts_with("app.sqlite")).collect();
        assert!(files.is_empty(), "{files:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn changing_the_signed_in_connection_does_not_run_recovery_again() {
        let fx = super::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Hi", &crate::agent::TurnMeta::default(), "running").await.unwrap();
        fx.core.close_db();
        fx.core.with_db_for(&fx.scope, |_| Ok(())).await.unwrap();
        assert_eq!(fx.core.pip_turns("general").await.unwrap()[0].status, "running", "the app is still open, so nothing was cut off");

        fx.core.restart();
        assert_eq!(fx.core.pip_turns("general").await.unwrap()[0].status, "failed");
    }

    #[tokio::test]
    async fn signing_in_as_another_account_refuses_the_replaced_accounts_writes_to_the_app_database() {
        use crate::auth::Credentials;

        let fx = super::testing::fixture().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Hi", &crate::agent::TurnMeta::default(), "running").await.unwrap();
        let site = Site { cloud_id: "site".into(), name: "Acme".into(), url: "https://acme.example".into() };
        let other = Account { account_id: "someone-else".into(), name: "Else".into(), avatar_url: None };
        let creds = Credentials { email: "me@example.com".into(), token: "t".into(), expires_on: "2999-01-01".into(), site, me: other };
        let previous = fx.core.auth.connection().await;
        fx.core.replace_connection(previous, creds.connection());

        let finished = fx.core.pip_turn_finish(&fx.scope, "q1", "A's answer", true, None, None, None).await;
        assert!(matches!(finished, Err(Error::SiteChanged)), "{finished:?}");
        let begun = fx.core.pip_turn_begin(&creds.scope(), "general", "q2", "Hi", &crate::agent::TurnMeta::default(), "running").await;
        assert!(begun.is_ok(), "{begun:?}");
        assert_eq!(fx.core.pip_turns("general").await.unwrap()[0].text, "");
    }

    /// Connects as whoever `email` names; a connect with the token `slow` waits until `release` after saying it has begun.
    struct Gated {
        begun: Notify,
        release: Notify,
    }

    #[async_trait::async_trait]
    impl crate::auth::Authenticator for Gated {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, input: &TokenSignIn) -> Result<crate::auth::Credentials> {
            if input.token == "slow" {
                self.begun.notify_one();
                self.release.notified().await;
            }
            let cloud_id = if input.site == "acme" { "site".to_string() } else { input.site.clone() };
            let site = Site { cloud_id, name: "Acme".into(), url: format!("https://{}.example", input.site) };
            let me = Account { account_id: input.email.clone(), name: input.email.clone(), avatar_url: None };
            Ok(crate::auth::Credentials { email: input.email.clone(), token: input.token.clone(), expires_on: "2999-01-01".into(), site, me })
        }
        async fn whoami(&self, _: &crate::auth::AccessToken) -> Result<Account> {
            unimplemented!()
        }
    }

    fn token_for(email: &str, token: &str) -> TokenSignIn {
        token_for_site("acme", email, token)
    }

    fn token_for_site(site: &str, email: &str, token: &str) -> TokenSignIn {
        TokenSignIn { site: site.into(), cloud_id: None, email: email.into(), token: token.into(), expires_on: "2999-01-01".into() }
    }

    #[tokio::test]
    async fn a_connect_still_waiting_on_jira_cannot_undo_a_sign_out_pressed_meanwhile() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let gated = Arc::new(Gated { begun: Notify::new(), release: Notify::new() });
        let fx = super::testing::fixture_with_authenticator(None, Some(gated.clone())).await;

        let core = fx.core.clone();
        let connecting = tokio::spawn(async move { core.connect_jira(&token_for("b", "slow")).await });
        gated.begun.notified().await;
        let core = fx.core.clone();
        let signing_out = tokio::spawn(async move { core.sign_out().await });
        tokio::task::yield_now().await;
        gated.release.notify_one();
        connecting.await.unwrap().unwrap();
        signing_out.await.unwrap().unwrap();

        assert!(fx.core.auth.identity().await.is_none());
        assert!(fx.core.connection(&Scope { connection_id: "jira:site:b".into(), account_id: "b".into() }).is_err());
        assert!(crate::secrets::keys_with_prefix("jira-token:").unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_second_account_through_connect_jira_still_leaves_exactly_one_session() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let gated = Arc::new(Gated { begun: Notify::new(), release: Notify::new() });
        let fx = super::testing::fixture_with_authenticator(None, Some(gated)).await;

        fx.core.connect_jira(&token_for("a", "fast")).await.unwrap();
        fx.core.connect_jira(&token_for("b", "fast")).await.unwrap();

        assert_eq!(crate::secrets::keys_with_prefix("jira-token:").unwrap(), ["jira-token:jira:site:b"]);
        assert_eq!(fx.core.auth.connection().await.unwrap().id, "jira:site:b");
        assert!(fx.core.connection(&Scope { connection_id: "jira:site:a".into(), account_id: "a".into() }).is_err());
    }

    #[tokio::test]
    async fn pips_conversations_are_still_there_after_signing_in_to_another_jira_site() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let gated = Arc::new(Gated { begun: Notify::new(), release: Notify::new() });
        let fx = super::testing::fixture_with_authenticator(None, Some(gated)).await;
        let meta = crate::agent::TurnMeta::default();
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "In the first site", &meta, "done").await.unwrap();
        fx.core.pip_turn_begin(&fx.scope, "ws:w1", "q2", "In a workstream", &meta, "done").await.unwrap();

        fx.core.sign_out().await.unwrap();
        assert_eq!(fx.core.pip_turns("general").await.unwrap().len(), 1, "readable while signed out");

        fx.core.connect_jira(&token_for_site("beta", "b", "fast")).await.unwrap();
        let (scope, _, _) = fx.core.auth.identity().await.unwrap();
        assert_eq!(scope.connection_id, "jira:beta:b");
        assert_eq!(fx.core.pip_turns("general").await.unwrap().len(), 1);
        assert_eq!(fx.core.pip_turns("ws:w1").await.unwrap().len(), 1);
        fx.core.pip_turn_begin(&scope, "general", "q3", "In the second site", &meta, "done").await.unwrap();
        assert_eq!(fx.core.pip_turns("general").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn two_connects_end_as_the_one_that_began_last_with_the_other_gone_from_the_registry() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let gated = Arc::new(Gated { begun: Notify::new(), release: Notify::new() });
        let fx = super::testing::fixture_with_authenticator(None, Some(gated.clone())).await;

        let core = fx.core.clone();
        let first = tokio::spawn(async move { core.connect_jira(&token_for("a", "slow")).await });
        gated.begun.notified().await;
        let core = fx.core.clone();
        let second = tokio::spawn(async move { core.connect_jira(&token_for("b", "fast")).await });
        tokio::task::yield_now().await;
        gated.release.notify_one();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();

        let (scope, _, _) = fx.core.auth.identity().await.unwrap();
        assert_eq!(scope.account_id, "b");
        assert!(fx.core.connection(&scope).is_ok());
        assert!(fx.core.connection(&Scope { connection_id: "jira:site:a".into(), account_id: "a".into() }).is_err());
        assert!(fx.core.connection(&fx.scope).is_err());
    }

    #[tokio::test]
    async fn the_app_database_shows_a_scope_only_its_own_drafts_and_resets_afterwards() {
        use crate::domain::{ItemRef, Intent, ProposalQuery};
        use crate::proposals::Draft;

        let fx = super::testing::fixture().await;
        let comment = |connection: &str| Draft::from_pip("q", None, Intent::Comment { item: ItemRef { connection_id: connection.into(), external_id: "1".into(), key: "CA-1".into() }, body: Doc::paragraph("hi") }, None);
        let mine = fx.core.propose(&fx.scope, comment(&fx.scope.connection_id)).await.unwrap();
        let theirs = fx.core.with_app_db(|db| proposals::create(db, comment("jira:site:other"), Utc::now())).await.unwrap();

        let seen_by = |ps: Vec<crate::domain::Proposal>| ps.into_iter().map(|p| p.id).collect::<Vec<_>>();
        let own = seen_by(fx.core.proposals_in(&fx.scope, &ProposalQuery::default()).await.unwrap());
        assert!(own.len() == 1 && own[0] == mine.id, "{own:?}");
        assert!(fx.core.proposal_in(&fx.scope, &theirs.id).await.unwrap().is_none());
        let all = seen_by(fx.core.with_app_db(|db| db.proposals(&ProposalQuery::default())).await.unwrap());
        assert!(all.contains(&mine.id) && all.contains(&theirs.id), "the filter is the call's, not the handle's");
    }

    #[tokio::test]
    async fn the_signed_in_person_is_known_without_the_legacy_snapshot() {
        let fx = super::testing::fixture().await;
        let me = fx.core.cache_me().await.unwrap();
        assert_eq!(me.display_name, "Me");
        assert_eq!(me.accounts, vec![PersonRef { connection_id: "jira:site:me".into(), account_id: "me".into() }]);
    }

    #[tokio::test]
    async fn people_come_from_the_cached_tickets() {
        let fx = super::testing::fixture().await;
        let names: Vec<String> = fx.core.cache_people().await.unwrap().into_iter().map(|p| p.name).collect();
        assert!(names.contains(&"Me Myself".to_string()) && names.contains(&"Sam".to_string()), "{names:?}");
    }

    #[tokio::test]
    async fn comments_come_from_the_tracker_and_fall_back_to_the_cache_when_it_is_unreachable() {
        let fx = super::testing::fixture().await;
        let item = fx.item("CA-1");
        let cached = fx.core.cache_comments(&item, false).await.unwrap();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].author.account_id, "sam");

        let live = crate::domain::Comment {
            id: "77".into(),
            author: PersonRef { connection_id: item.connection_id.clone(), account_id: "kim".into() },
            body: Doc::paragraph("fresh"),
            created: chrono::Utc::now(),
            mentions: vec![],
        };
        *fx.tracker.comments.lock().unwrap() = Some(vec![live.clone()]);
        assert_eq!(fx.core.cache_comments(&item, true).await.unwrap(), vec![live]);
        assert_eq!(fx.core.cache_comments(&item, false).await.unwrap().len(), 1, "without refresh the cache answers");

        *fx.tracker.comments.lock().unwrap() = None;
        assert_eq!(fx.core.cache_comments(&item, true).await.unwrap(), cached);
    }

    #[tokio::test]
    async fn another_connections_items_are_refused() {
        let fx = super::testing::fixture().await;
        let mut foreign = fx.item("CA-1");
        foreign.connection_id = "jira:other:me".into();
        assert!(fx.core.cache_comments(&foreign, true).await.is_err());
        assert!(fx.core.cache_transitions(&foreign).await.is_err());
    }

    #[tokio::test]
    async fn the_connection_row_names_the_site_and_the_last_sync() {
        let fx = super::testing::fixture().await;
        let rows = fx.core.connections().await.unwrap();
        assert_eq!((rows[0].workspace.as_str(), rows[0].account.as_str(), rows[0].syncing), ("Acme", "Me", false));
        assert_eq!(rows[0].last_sync_at, None);
    }

    #[tokio::test]
    async fn the_jira_sign_in_becomes_the_jira_instance_and_the_row_lists_under_it() {
        let fx = super::testing::fixture().await;
        fx.core.adopt_instances().await;
        let config = crate::config::AppConfig::load(&fx.core.data_dir());
        let [jira] = config.connections.as_slice() else { panic!("{:?}", config.connections) };
        assert_eq!((jira.id.as_str(), jira.display_name.as_str(), jira.bound_to.as_deref(), jira.config.site.as_deref()), ("jira", "Acme", Some("jira:site:me"), Some("acme.example")));
        let rows = fx.core.connections().await.unwrap();
        assert_eq!((rows[0].instance_id.as_str(), rows[0].display_name.as_str(), rows[0].enabled), ("jira", "Acme", true));
    }

    #[tokio::test]
    async fn only_a_dead_sign_in_marks_the_connection_for_reauth_and_a_good_sync_clears_it() {
        let fx = super::testing::fixture().await;
        fx.core.set_sync_failure(&Error::Api { status: 503, message: "down".into() });
        assert!(!fx.core.connections().await.unwrap()[0].reauth);
        fx.core.set_sync_failure(&Error::ReauthRequired);
        assert!(fx.core.connections().await.unwrap()[0].reauth);
        fx.core.set_error(None);
        assert!(!fx.core.connections().await.unwrap()[0].reauth);
    }

    #[test]
    fn unread_cutoff_allows_for_clock_skew_and_defaults_to_a_day() {
        assert_eq!(unread_cutoff(Some("2026-09-28T12:00:00Z")), "2026-09-28T11:50:00Z");
        let fallback = unread_cutoff(None);
        assert!(fallback < now_iso() && fallback > ago(Duration::hours(25)));
    }

    #[test]
    fn each_site_and_account_gets_its_own_database_file() {
        let of = |cloud: &str, account: &str| crate::auth::SiteScope { cloud_id: cloud.into(), account_id: account.into() }.connection("Site");
        let a = of("c1", "712020:ab-cd");
        let b = of("c1", "someone-else");
        assert_eq!(db_file(&a), "inbox-c1-712020_ab-cd.sqlite");
        assert_ne!(db_file(&a), db_file(&b));
        assert!(!db_file(&of("../x", "y")).contains('/'));
    }

    #[test]
    fn a_ticket_comes_back_out_of_its_work_item() {
        let ticket = crate::tracker::testing::sample_ticket();
        let item = WorkItem { extra: serde_json::to_value(&ticket).unwrap(), ..crate::domain::fixtures::work_item("1", "todo") };
        assert_eq!(ticket_of(&item).unwrap().key, ticket.key);
        assert!(ticket_of(&crate::domain::fixtures::work_item("1", "todo")).is_err(), "no payload, no ticket");
    }

    #[test]
    fn a_database_from_before_the_cache_is_migrated_in_place_and_backfilled_once() {
        let dir = std::env::temp_dir().join(format!("gossamr-backfill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("inbox-site-me.sqlite");
        let ticket = crate::tracker::testing::sample_ticket();
        let mut stored = serde_json::to_value(&ticket).unwrap();
        stored.as_object_mut().unwrap().retain(|k, _| k != "labels" && k != "links");
        {
            let old = rusqlite::Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE tickets (key TEXT PRIMARY KEY, data TEXT NOT NULL, synced_at TEXT NOT NULL);
                 CREATE TABLE events (id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
                   at TEXT NOT NULL, text TEXT NOT NULL, unread INTEGER NOT NULL, done_at TEXT, snoozed_until TEXT);
                 CREATE TABLE activity (id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, text TEXT NOT NULL);
                 CREATE TABLE seen (ticket_key TEXT PRIMARY KEY, at TEXT NOT NULL);
                 CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
                 INSERT INTO seen VALUES ('CA-1', '2026-09-01T00:00:00Z');
                 INSERT INTO meta VALUES ('last_sync_at', '2026-09-28T10:00:00Z');",
            )
            .unwrap();
            old.execute(
                "INSERT INTO tickets VALUES (?1, ?2, '2026-09-28T10:00:00Z')",
                rusqlite::params![ticket.key, stored.to_string()],
            )
            .unwrap();
        }
        let connection = crate::auth::SiteScope { cloud_id: "site".into(), account_id: "me".into() }.connection("Site");

        let db = Db::open(&path).unwrap();
        backfill_cache(&db, &connection).unwrap();
        backfill_cache(&db, &connection).unwrap();

        let item = db.item(&connection.item("CA-1")).unwrap().expect("backfilled");
        assert_eq!(item.title, "Do the thing");
        assert_eq!(ticket_of(&item).unwrap().key, "CA-1");
        assert_eq!(db.items_synced_since(&connection.id, "2026-09-28T10:00:00Z", &Visible::All).unwrap().len(), 1);
        assert_eq!(db.seen().unwrap().len(), 1, "inbox state survives");
        assert_eq!(db.meta(LAST_SYNC).unwrap().as_deref(), Some("2026-09-28T10:00:00Z"));
        assert_eq!(db.sync_state(&connection.id).unwrap().full_at, None, "the first sync is a full one, which fills in labels and links");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// A signed-in Core over a temporary database and a recording tracker, for tests that need the whole path.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::auth::Credentials;
    use crate::domain::{Category, StatusDef, Transitions};
    use crate::tracker::testing::{sample_ticket, Recorder};

    pub struct Fixture {
        pub core: Arc<Core>,
        pub scope: Scope,
        pub tracker: Arc<Recorder>,
        pub dir: PathBuf,
        /// Where clones for runs may live.
        pub home: PathBuf,
        /// What the scripted GitHub was asked, when there is one.
        pub github: Option<Arc<std::sync::Mutex<Vec<crate::codehost::github::testserver::Seen>>>>,
        /// What the scripted GitHub answers from, when there is one.
        pub github_routes: Option<crate::codehost::github::testserver::Routes>,
    }

    impl Fixture {
        /// The method and target of every request the scripted GitHub received, in order.
        /// Has the scripted GitHub answer `target` with `replies` from now on.
        pub fn github_route(&self, target: &str, replies: Vec<crate::codehost::github::testserver::Reply>) {
            crate::codehost::github::testserver::add_route(self.github_routes.as_ref().expect("a fixture with GitHub"), target, replies);
        }

        pub fn github_seen(&self) -> Vec<(String, String)> {
            let seen = self.github.as_ref().expect("a fixture with GitHub");
            seen.lock().unwrap().iter().map(|s| (s.method.clone(), s.target.clone())).collect()
        }

        pub fn item(&self, key: &str) -> ItemRef {
            Core::item(&self.scope, key)
        }

        /// Replaces the cached containers.
        pub async fn set_containers(&self, containers: &[Container]) {
            let id = self.scope.connection_id.clone();
            self.core.with_db_for(&self.scope, |db| db.replace_containers(&id, containers, "2026-09-29T12:00:00Z")).await.unwrap();
        }

        /// Adds an item with `key` in `container` (a copy of the sample ticket) to the cache.
        pub async fn add_in(&self, key: &str, container: &str) {
            let connection = self.core.connection(&self.scope).unwrap();
            let mut ticket = sample_ticket();
            ticket.key = key.into();
            let mut item = tracker::item_from_ticket(&connection, &ticket).unwrap();
            item.container.external_id = container.into();
            item.title = format!("Ticket {key}");
            self.core.with_db_for(&self.scope, |db| db.upsert_items(&[item], "2026-09-29T12:00:00Z").map(|_| ())).await.unwrap();
        }

        /// The item `key` as the tracker gives it (a copy of the sample ticket), payload and all.
        pub fn tracker_item(&self, key: &str) -> WorkItem {
            let connection = self.core.connection(&self.scope).unwrap();
            let mut item = tracker::item_from_ticket(&connection, &sample_ticket()).unwrap();
            item.item = connection.item(key);
            item
        }

        /// Changes the cached item `key`, as a sync of an edited ticket would.
        pub async fn edit_item(&self, key: &str, f: impl FnOnce(&mut WorkItem)) {
            let at = self.item(key);
            let mut item = self.core.with_db_for(&self.scope, |db| db.item(&at)).await.unwrap().unwrap();
            f(&mut item);
            self.core.with_db_for(&self.scope, |db| db.upsert_items(&[item], "2026-09-29T13:00:00Z").map(|_| ())).await.unwrap();
        }

        /// Adds `CA-<n>` (a copy of the sample ticket) to the cache.
        pub async fn add_item(&self, n: u32) {
            let connection = self.core.connection(&self.scope).unwrap();
            let mut item = tracker::item_from_ticket(&connection, &sample_ticket()).unwrap();
            let key = format!("CA-{n}");
            item.item = connection.item(&key);
            item.title = format!("Ticket {n}");
            self.core.with_db_for(&self.scope, |db| db.upsert_items(&[item], "2026-09-29T12:00:00Z").map(|_| ())).await.unwrap();
        }

        /// Stores `run` as it is, without a draft or an approval.
        pub async fn insert_run(&self, run: &crate::domain::Run) {
            self.core.with_db_for(&self.scope, |db| db.insert_run(run)).await.unwrap();
        }

        /// Stores `ws` as it is, whatever its connection.
        pub async fn insert_workstream(&self, ws: &crate::domain::Workstream) {
            self.core.with_db_for(&self.scope, |db| db.insert_workstream(ws)).await.unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub async fn fixture() -> Fixture {
        fixture_with(None).await
    }

    /// The fixture with a GitHub connection that watches `repos` (`owner/name`), for what only watched repositories may do.
    pub async fn fixture_watching(repos: &[&str]) -> Fixture {
        fixture_watching_with(repos, Vec::new()).await
    }

    /// `fixture_watching` with more GitHub routes scripted: replies come in order and the last repeats.
    pub async fn fixture_watching_with(repos: &[&str], extra: Vec<(&str, Vec<crate::codehost::github::testserver::Reply>)>) -> Fixture {
        use crate::auth::GithubAuth;
        use crate::codehost::github::testserver::{serve, Reply};
        use crate::codehost::github::GithubHost;

        let rows: Vec<String> = repos
            .iter()
            .map(|r| {
                let (owner, name) = r.split_once('/').expect("owner/name");
                format!("{{\"id\":1,\"name\":\"{name}\",\"full_name\":\"{r}\",\"private\":true,\"owner\":{{\"login\":\"{owner}\"}},\"fork\":false,\"archived\":false,\"default_branch\":\"main\",\"pushed_at\":\"2026-09-29T10:00:00Z\",\"permissions\":{{\"push\":true,\"pull\":true}}}}")
            })
            .collect();
        let mut routes = vec![
            ("/user", vec![Reply::ok(include_str!("codehost/github/fixtures/user.json"))]),
            ("/user/repos", vec![Reply::ok(&format!("[{}]", rows.join(",")))]),
        ];
        routes.extend(extra);
        let server = serve(routes).await;
        let http = reqwest::Client::new();
        let (base, factory_http) = (server.base.clone(), http.clone());
        let auth = GithubAuth::for_test(http, &server.base, crate::auth::fake_gh("ghp_x"));
        let code = CodeService::with_factory(
            auth,
            Box::new(move |s, credentials, db| Arc::new(GithubHost::new(factory_http.clone(), &base, credentials, &Connection::github_id(&s.login), &s.login, db))),
        );
        let mut fx = fixture_with(Some(code)).await;
        fx.github = Some(server.seen.clone());
        fx.github_routes = Some(server.routes.clone());
        fx.core.github_connect(None).await.unwrap();
        fx
    }

    /// The fixture with a scripted GitHub service in place of the real one.
    pub async fn fixture_with(code: Option<CodeService>) -> Fixture {
        fixture_with_authenticator(code, None).await
    }

    /// `fixture_with`, signed in to Jira through `authenticator` instead of Atlassian.
    pub async fn fixture_with_authenticator(code: Option<CodeService>, authenticator: Option<Arc<dyn crate::auth::Authenticator>>) -> Fixture {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("gossamr-core-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let site = Site { cloud_id: "site".into(), name: "Acme".into(), url: "https://acme.example".into() };
        let me = Account { account_id: "me".into(), name: "Me".into(), avatar_url: None };
        let creds = Credentials { email: "me@example.com".into(), token: "t".into(), expires_on: "2999-01-01".into(), site, me };
        let scope = creds.scope();
        let http = reqwest::Client::new();
        let tracker = Arc::new(Recorder::default());
        let shared = tracker.clone();
        let registry = Registry::new(move |_| shared.clone());
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let mut core = Core::new(Arc::new(authenticator.map_or_else(|| Auth::signed_in(http, creds.clone()), |a| Auth::with_authenticator(a, creds.clone()))), registry, dir.clone()).with_home(home.clone());
        if let Some(code) = code {
            core = core.with_code(code);
        }
        let core = Arc::new(core);
        core.registry.register(creds.connection());

        let fx = Fixture { core, scope, tracker, dir, home, github: None, github_routes: None };
        fx.add_item(1).await;
        let connection = fx.core.connection(&fx.scope).unwrap();
        let item = fx.core.cache_item(&connection.item("CA-1")).await.unwrap().unwrap();
        let done = StatusDef { id: "10001".into(), name: "Done".into(), category: Category::Done };
        let workflow = Workflow { statuses: vec![item.status.clone(), done], transitions: Transitions::Any };
        let container = Container { container_ref: item.container, key: "CA".into(), name: "Cats".into(), workflow };
        fx.core.with_db_for(&fx.scope, |db| db.replace_containers(&connection.id, &[container], "2026-09-29T12:00:00Z")).await.unwrap();
        fx
    }
}
