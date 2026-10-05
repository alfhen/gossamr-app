use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{Duration, SecondsFormat, Utc};
use tokio::sync::Notify;

use crate::auth::{Account, Auth, AuthStatus, Scope, Site};
use crate::db::{stamp, Db};
use crate::error::{Error, Result};
use crate::events::{changes_since, derive, my_actions, NewEvent};
use crate::domain::{
    Comment, Container, ContainerRef, Event, FeedPage, FeedQuery, Filter, FilterContext, Identity, Intent, ItemRef, PersonRef, Visible, WorkItem, Workflow,
};
use crate::model::{Attachment, CachedTicket, CreatedSubtasks, MentionRef, Person, Snapshot, Status, Ticket, Transition, Uploaded};
use crate::proposals;
use crate::sync::{self, Schedule, Trigger, CLOCK_SKEW_MINUTES};
use crate::tracker::{self, Connection, Move, Registry, WorkTracker};

pub(crate) mod code;
mod drafts;
mod run_results;
mod pip_runs;
mod plan_description;
mod report;
mod rewrites;
mod ticket_context;
pub use pip_runs::PipRunAsk;
pub use rewrites::TextSeen;
mod watch;

pub use code::{CodeRef, CodeService};
pub use drafts::Edit;
pub use plan_description::PlanDescription;
pub use run_results::{PlanComment, RunOutcome, SUMMARY_ONLY};
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
const OWN_SESSIONS_KEPT: usize = 50;

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

fn ago(d: Duration) -> String {
    (Utc::now() - d).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Separate files per site and account, so two people signing in on one Mac never see each other's inbox.
fn media_key(attachment_id: &str) -> String {
    format!("media:{attachment_id}")
}

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
            db.upsert_items(&[tracker::item_from_ticket(connection, &ticket)], &synced_at)?;
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
}

pub struct Core {
    pub auth: Arc<Auth>,
    registry: Registry,
    code: CodeService,
    data_dir: PathBuf,
    /// Clones a run may use have to be under this folder.
    home: Option<PathBuf>,
    /// One database per connection, opened for whichever is signed in. A connection is a site and an account, so two
    /// people signing in to the same site on one Mac never see each other's tickets or inbox.
    db: Mutex<Option<(String, Db)>>,
    last_error: Mutex<Option<String>>,
    syncing: AtomicBool,
    schedules: Mutex<HashMap<String, Schedule>>,
    /// When each connection was last checked for work assigned outside what it watches.
    radar: Mutex<HashMap<String, chrono::DateTime<Utc>>>,
    /// Whether a run may be asked to report through the run-report tool; the Agents setting, kept here so a draft can
    /// be refused without a round trip to the service.
    report_enabled: AtomicBool,
    /// Ask for a sync now, whatever the schedule says.
    pub wake: Notify,
    /// The window gained focus: sync if it has been a while and no failure is being waited out.
    pub focus: Notify,
}

/// What a sync left behind.
pub struct Synced {
    pub connection_id: String,
    pub new_events: Vec<NewEvent>,
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
            code: CodeService::new(crate::net::client(), CodeService::default_store()),
            data_dir,
            home: dirs::home_dir().and_then(|h| h.canonicalize().ok()),
            db: Mutex::new(None),
            last_error: Mutex::new(None),
            syncing: AtomicBool::new(false),
            schedules: Mutex::new(HashMap::new()),
            radar: Mutex::new(HashMap::new()),
            report_enabled: AtomicBool::new(false),
            wake: Notify::new(),
            focus: Notify::new(),
        }
    }

    pub fn set_report_enabled(&self, on: bool) {
        self.report_enabled.store(on, Ordering::SeqCst);
    }

    pub fn report_enabled(&self) -> bool {
        self.report_enabled.load(Ordering::SeqCst)
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
        self.registry.connection(&Connection::jira_id(scope)).ok_or(Error::SiteChanged)
    }

    fn tracker(&self, scope: &Scope) -> Result<Arc<dyn WorkTracker>> {
        Ok(self.registry.tracker(&self.connection(scope)?))
    }

    fn item(scope: &Scope, key: &str) -> ItemRef {
        ItemRef { connection_id: Connection::jira_id(scope), external_id: key.into(), key: key.into() }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    /// Signs in and registers the resulting connection.
    pub async fn sign_in(&self, open_browser: impl FnOnce(&str) -> Result<()>) -> Result<AuthStatus> {
        let connection = self.auth.sign_in(open_browser).await?;
        self.registry.register(connection);
        self.auth.status().await
    }

    /// Registers the connection restored from the Keychain, if any.
    pub async fn restore(&self) {
        if let Some(connection) = self.auth.connection().await {
            self.registry.register(connection);
        }
        self.restore_code().await;
    }

    pub async fn sign_out(&self) -> Result<()> {
        let connection = self.auth.connection().await;
        self.auth.sign_out().await?;
        if let Some(c) = connection {
            self.registry.remove(&c.id);
        }
        self.close_db();
        Ok(())
    }

    async fn identity(&self) -> Result<(Site, Account)> {
        self.auth.identity().await.ok_or(Error::NotSignedIn)
    }

    async fn with_db<T>(&self, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let (site, me) = self.identity().await?;
        self.with_db_for(&Scope::of(&site, &me), f).await
    }

    /// Runs `f` against `scope`'s database, but only if that site and account are still the signed-in ones. Work
    /// that fetched data before someone signed in elsewhere must not land in the new session's database.
    async fn with_db_for<T>(&self, scope: &Scope, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let (site, me) = self.identity().await?;
        if &Scope::of(&site, &me) != scope {
            return Err(Error::SiteChanged);
        }
        let mut guard = self.db.lock().expect("db lock poisoned");
        let connection = self.connection(scope)?;
        if guard.as_ref().map(|(open, _)| *open != connection.id).unwrap_or(true) {
            let db = Db::open(&self.data_dir.join(db_file(&connection)))?;
            backfill_cache(&db, &connection)?;
            db.release_interrupted(Utc::now())?;
            *guard = Some((connection.id.clone(), db));
        }
        f(&guard.as_ref().expect("opened above").1)
    }

    pub fn close_db(&self) {
        *self.db.lock().expect("db lock poisoned") = None;
    }

    pub fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().expect("error lock poisoned") = e;
    }

    /// Runs a sync if `trigger` says this connection is due one, and records how it went for the backoff.
    pub async fn sync_if_due(&self, trigger: Trigger) -> Option<Result<Synced>> {
        let (site, me) = self.auth.identity().await?;
        let id = Connection::jira_id(&Scope::of(&site, &me));
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

    /// Fetches what changed since the last sync (or everything, when due), stores it in the cache, and returns the
    /// events that are new and unread.
    pub async fn sync(&self) -> Result<Synced> {
        let (site, me) = self.identity().await?;
        let scope = Scope::of(&site, &me);
        let connection_id = Connection::jira_id(&scope);
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
            let stored = sync::store(db, &connection_id, &me.account_id, &pulled, plan, started, &unread_after, previous.is_some())?;
            db.set_meta(LAST_SYNC, &stamp(started))?;
            let containers_changed = pulled.containers.is_some();
            // A draft that can't be re-judged must not stop the items from syncing.
            let revised = proposals::reconcile_pending(db, &identity_of(&connection_id, &me), Utc::now()).unwrap_or_default();
            Ok(Synced {
                connection_id: connection_id.clone(),
                new_events: stored.new_events,
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
        let connection_id = Connection::jira_id(scope);
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
        let (site, me) = self.identity().await?;
        let sync_error = self.last_error.lock().expect("error lock poisoned").clone();
        // The identity above labels the snapshot, so the data must come from that same account's database.
        let scope = Scope::of(&site, &me);
        self.with_db_for(&scope.clone(), |db| {
            let last_sync = db.meta(LAST_SYNC)?;
            // Tickets refreshed within a day of the last sync; older ones have dropped out of every query.
            let cutoff = last_sync
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| (d.with_timezone(&Utc) - Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true))
                .unwrap_or_default();
            let connection_id = Connection::jira_id(&scope);
            let visible = db.watch_set(&connection_id)?.visible();
            let cached = tickets_of(&db.items_synced_since(&connection_id, &cutoff, &visible)?)?;
            let keys = db.visible_keys(&connection_id, &visible)?;
            let shown = |key: &str| keys.as_ref().is_none_or(|k| k.contains(key));
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

    pub async fn mark_seen(&self, key: &str) -> Result<()> {
        self.with_db(|db| db.mark_seen(key, &now_iso())).await
    }

    pub async fn set_unread(&self, id: &str, unread: bool) -> Result<()> {
        self.with_db(|db| db.set_unread(id, unread)).await
    }

    pub async fn set_done(&self, id: &str, done: bool) -> Result<()> {
        let at = done.then(now_iso);
        self.with_db(|db| db.set_done(id, at.as_deref())).await
    }

    pub async fn snooze(&self, id: &str, until: Option<&str>) -> Result<()> {
        // Stored in the same format as every other timestamp so string comparisons order correctly.
        let until = until
            .map(|u| {
                chrono::DateTime::parse_from_rfc3339(u)
                    .map(|d| d.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true))
                    .map_err(|_| Error::Api { status: 400, message: format!("not a valid time: {u}") })
            })
            .transpose()?;
        self.with_db(|db| db.snooze(id, until.as_deref())).await
    }

    /// The signed-in scope, for work that starts now.
    pub async fn scope(&self) -> Result<Scope> {
        let (site, me) = self.identity().await?;
        Ok(Scope::of(&site, &me))
    }

    pub async fn mentionable(&self, scope: &Scope, key: &str, query: &str) -> Result<Vec<Person>> {
        let people = self.tracker(scope)?.people(&Self::item(scope, key), query).await?;
        Ok(people
            .into_iter()
            .map(|p| Person { account_id: p.person_ref.account_id, name: p.display_name, avatar_url: p.avatar_url })
            .collect())
    }

    /// The moves open to a ticket. A move's id is its target status, which `transition` takes back.
    pub async fn transitions(&self, scope: &Scope, key: &str) -> Result<Vec<Transition>> {
        let moves = self.tracker(scope)?.transitions(&Self::item(scope, key)).await?;
        Ok(moves.into_iter().map(|m| Transition { id: m.to.id.clone(), name: m.name, to: Status::from(&m.to) }).collect())
    }

    /// `scope` is the account the user was looking at when they acted; the write is refused if that has changed.
    pub async fn transition(&self, scope: &Scope, key: &str, status_id: &str) -> Result<()> {
        let intent = Intent::Transition { item: Self::item(scope, key), to: status_id.into() };
        self.tracker(scope)?.apply(&intent).await?;
        self.after_write(scope, key).await;
        Ok(())
    }

    /// `scope` is the account the user was looking at when they acted; the write is refused if that has changed.
    pub async fn comment(
        &self,
        scope: &Scope,
        key: &str,
        body: &str,
        mentions: &[MentionRef],
        files: &[Uploaded],
    ) -> Result<()> {
        let body = body.trim();
        if body.is_empty() && files.is_empty() {
            return Err(Error::Api { status: 400, message: "a comment can't be empty".into() });
        }
        let connection = Connection::jira_id(scope);
        let people: Vec<(PersonRef, String)> = mentions
            .iter()
            .map(|m| (PersonRef { connection_id: connection.clone(), account_id: m.account_id.clone() }, m.name.clone()))
            .collect();
        let intent = Intent::Comment { item: Self::item(scope, key), body: tracker::comment_doc(body, &people) };
        self.tracker(scope)?.apply_with_files(&intent, files).await?;
        self.after_write(scope, key).await;
        Ok(())
    }

    /// Where each of a ticket's attachments lives in the media service, as `media id → attachment id`, so the files a
    /// description or comment embeds can be shown. Lookups are cached: an attachment's media id never changes.
    pub async fn ticket_media(&self, scope: &Scope, key: &str) -> Result<HashMap<String, String>> {
        let attachments: Vec<Attachment> = self.ticket(scope, key).await?.attachments;
        let cached = self
            .with_db_for(scope, |db| attachments.iter().map(|a| Ok((a.id.clone(), db.meta(&media_key(&a.id))?))).collect::<Result<Vec<_>>>())
            .await?;
        let mut out = HashMap::new();
        for (id, media) in cached {
            let media = match media {
                Some(m) => m,
                None => {
                    let Some(m) = self.tracker(scope)?.media_id(&id).await? else { continue };
                    self.with_db_for(scope, |db| db.set_meta(&media_key(&id), &m)).await?;
                    m
                }
            };
            out.insert(media, id);
        }
        Ok(out)
    }

    /// An attachment's bytes and content type, for the signed-in account.
    pub async fn attachment(&self, id: &str) -> Result<(String, Vec<u8>)> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
            return Err(Error::Api { status: 400, message: "not an attachment id".into() });
        }
        let scope = self.scope().await?;
        self.tracker(&scope)?.download(id).await
    }

    /// Uploads a file to a ticket. The ticket isn't refreshed here: the comment that follows does that.
    pub async fn attach(&self, scope: &Scope, key: &str, filename: &str, mime_type: &str, bytes: Vec<u8>) -> Result<Uploaded> {
        let uploaded = self.tracker(scope)?.attach(&Self::item(scope, key), filename, mime_type, bytes).await?;
        if let Some(m) = &uploaded.media_id {
            let _ = self.with_db_for(scope, |db| db.set_meta(&media_key(&uploaded.id), m)).await;
        }
        Ok(uploaded)
    }

    pub async fn attachment_limit(&self, scope: &Scope) -> Result<Option<u64>> {
        self.tracker(scope)?.attachment_limit().await
    }

    /// Re-reads a ticket after a successful write. A failure here must not be reported as a failed write, or a retry
    /// would post the comment twice; the next sync picks the change up instead.
    async fn after_write(&self, scope: &Scope, key: &str) {
        if let Err(e) = self.refresh(scope, key).await {
            self.set_error(Some(format!("Saved, but couldn't refresh {key}: {e}")));
            self.wake.notify_one();
        }
    }

    /// The cached ticket, or a fresh read from Jira when it isn't cached.
    pub async fn ticket(&self, scope: &Scope, key: &str) -> Result<CachedTicket> {
        ticket_of(&self.work_item(scope, key).await?)
    }

    /// The cached item, or a fresh read from Jira when it isn't cached.
    pub async fn work_item(&self, scope: &Scope, key: &str) -> Result<WorkItem> {
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
        let (site, me) = self.identity().await?;
        if &Scope::of(&site, &me) != scope {
            return Err(Error::SiteChanged);
        }
        let connection_id = Connection::jira_id(scope);
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
        let id = Connection::jira_id(scope);
        self.with_db_for(scope, |db| {
            let visible = if include_unwatched { Visible::All } else { db.watch_set(&id)?.visible() };
            Ok(db.containers(&id)?.into_iter().filter(|c| visible.allows(&c.container_ref.external_id)).collect())
        })
        .await
    }

    pub async fn cache_workflow(&self, container: &ContainerRef) -> Result<Option<Workflow>> {
        self.workflow_in(&self.scope().await?, container).await
    }

    pub async fn workflow_in(&self, scope: &Scope, container: &ContainerRef) -> Result<Option<Workflow>> {
        self.with_db_for(scope, |db| db.workflow(container)).await
    }

    /// The signed-in person, across connections.
    pub async fn cache_me(&self) -> Result<Identity> {
        let (site, me) = self.identity().await?;
        Ok(identity_of(&Connection::jira_id(&Scope::of(&site, &me)), &me))
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
        if item.connection_id != Connection::jira_id(&scope) {
            return Err(Error::SiteChanged);
        }
        self.tracker(&scope)?.transitions(item).await
    }

    /// The signed-in connection with how its sync is going.
    pub async fn connections(&self) -> Result<Vec<ConnectionInfo>> {
        let mut out = Vec::new();
        if let Some((site, me)) = self.auth.identity().await {
            let scope = Scope::of(&site, &me);
            let connection = self.connection(&scope)?;
            let last_sync_at = self.with_db_for(&scope, |db| db.meta(LAST_SYNC)).await?;
            out.push(ConnectionInfo {
                id: connection.id,
                kind: connection.kind,
                workspace: site.name,
                url: site.url,
                account: me.name,
                last_sync_at,
                syncing: self.syncing.load(Ordering::SeqCst),
                error: self.last_error.lock().expect("error lock poisoned").clone(),
                transient: false,
            });
        }
        out.extend(self.code_connections());
        Ok(out)
    }

    pub async fn cache_events(&self, item: &ItemRef, limit: usize) -> Result<Vec<Event>> {
        let scope = self.scope().await?;
        self.with_db_for(&scope, |db| db.events_for_item(item, limit)).await
    }

    pub async fn cache_feed(&self, query: &FeedQuery) -> Result<FeedPage> {
        let scope = self.scope().await?;
        let id = self.connection(&scope)?.id;
        self.with_db_for(&scope, |db| {
            let visible = if query.include_unwatched { Visible::All } else { db.watch_set(&id)?.visible() };
            db.feed(&id, query, &visible)
        })
        .await
    }

    pub async fn cache_feed_unread(&self) -> Result<usize> {
        let scope = self.scope().await?;
        let id = self.connection(&scope)?.id;
        self.with_db_for(&scope, |db| db.feed_unread(&id, &db.watch_set(&id)?.visible())).await
    }

    /// `scope` is the account the user was looking at when they approved; the write is refused if that has changed.
    /// A failure part-way still reports what was created, so a retry can skip those and not duplicate them.
    pub async fn create_subtasks(&self, scope: &Scope, key: &str, summaries: &[String]) -> Result<CreatedSubtasks> {
        let intent = Intent::Subtasks { parent: Self::item(scope, key), summaries: summaries.to_vec() };
        let tracker::Applied { created, error } = self.tracker(scope)?.apply(&intent).await?;
        let created: Vec<String> = created.into_iter().map(|r| r.key).collect();
        if created.is_empty() {
            if let Some(e) = error {
                return Err(e);
            }
        }
        self.after_write(scope, key).await;
        Ok(CreatedSubtasks { created, error: error.map(|e| e.to_string()) })
    }

    /// Records a session started in Pip's sandbox folder, and as the one to continue for `key` when there is one.
    /// Sessions recorded by earlier versions, which ran in a user-chosen folder, never enter this list.
    pub async fn remember_claude_session(&self, key: Option<&str>, session_id: &str) -> Result<()> {
        self.with_db(|db| {
            if let Some(key) = key {
                db.set_meta(&format!("claude:{key}"), &serde_json::json!({ "id": session_id }).to_string())?;
            }
            let mut own: Vec<String> =
                db.meta(PIP_SESSIONS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            own.retain(|s| s != session_id);
            own.insert(0, session_id.to_string());
            own.truncate(OWN_SESSIONS_KEPT);
            db.set_meta(PIP_SESSIONS, &serde_json::to_string(&own)?)
        })
        .await
    }

    /// Whether Pip started `session_id` in its sandbox folder, which is the only place it can be resumed from.
    pub async fn is_pip_session(&self, session_id: &str) -> Result<bool> {
        self.with_db(|db| {
            let own: Vec<String> = db.meta(PIP_SESSIONS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            Ok(own.iter().any(|s| s == session_id))
        })
        .await
    }

    /// The session to continue for `key`, if it is one Pip can resume.
    pub async fn claude_session_for(&self, key: &str) -> Result<Option<String>> {
        let last = self
            .with_db(|db| Ok(db.meta(&format!("claude:{key}"))?.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())))
            .await?
            .and_then(|v| v["id"].as_str().map(String::from));
        match last {
            Some(id) if self.is_pip_session(&id).await? => Ok(Some(id)),
            _ => Ok(None),
        }
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
            .with_db(|db| db.set_meta("claude:CA-1", r#"{"id":"old-1","cwd":"/Users/me/code/app"}"#))
            .await
            .unwrap();
        assert!(!fx.core.is_pip_session("old-1").await.unwrap());
        assert_eq!(fx.core.claude_session_for("CA-1").await.unwrap(), None);

        fx.core.remember_claude_session(Some("CA-1"), "new-1").await.unwrap();
        fx.core.remember_claude_session(None, "ws-1").await.unwrap();
        assert!(fx.core.is_pip_session("new-1").await.unwrap() && fx.core.is_pip_session("ws-1").await.unwrap());
        assert_eq!(fx.core.claude_session_for("CA-1").await.unwrap().as_deref(), Some("new-1"));
        assert!(!fx.core.is_pip_session("old-1").await.unwrap());
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

    #[test]
    fn unread_cutoff_allows_for_clock_skew_and_defaults_to_a_day() {
        assert_eq!(unread_cutoff(Some("2026-09-28T12:00:00Z")), "2026-09-28T11:50:00Z");
        let fallback = unread_cutoff(None);
        assert!(fallback < now_iso() && fallback > ago(Duration::hours(25)));
    }

    #[test]
    fn each_site_and_account_gets_its_own_database_file() {
        let of = |cloud: &str, account: &str| Connection::jira(&Scope { cloud_id: cloud.into(), account_id: account.into() }, "Site");
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
        let connection = Connection::jira(&Scope { cloud_id: "site".into(), account_id: "me".into() }, "Site");

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
    use crate::auth::{Credentials, Tokens};
    use crate::domain::{Category, StatusDef, Transitions};
    use crate::tracker::testing::{sample_ticket, Recorder};

    pub struct Fixture {
        pub core: Arc<Core>,
        pub scope: Scope,
        pub tracker: Arc<Recorder>,
        pub dir: PathBuf,
        /// Where clones for runs may live.
        pub home: PathBuf,
    }

    impl Fixture {
        pub fn item(&self, key: &str) -> ItemRef {
            Core::item(&self.scope, key)
        }

        /// Replaces the cached containers.
        pub async fn set_containers(&self, containers: &[Container]) {
            let id = Connection::jira_id(&self.scope);
            self.core.with_db_for(&self.scope, |db| db.replace_containers(&id, containers, "2026-09-29T12:00:00Z")).await.unwrap();
        }

        /// Adds an item with `key` in `container` (a copy of the sample ticket) to the cache.
        pub async fn add_in(&self, key: &str, container: &str) {
            let connection = self.core.connection(&self.scope).unwrap();
            let mut ticket = sample_ticket();
            ticket.key = key.into();
            let mut item = tracker::item_from_ticket(&connection, &ticket);
            item.container.external_id = container.into();
            item.title = format!("Ticket {key}");
            self.core.with_db_for(&self.scope, |db| db.upsert_items(&[item], "2026-09-29T12:00:00Z").map(|_| ())).await.unwrap();
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
            let mut item = tracker::item_from_ticket(&connection, &sample_ticket());
            let key = format!("CA-{n}");
            item.item = connection.item(&key);
            item.title = format!("Ticket {n}");
            self.core.with_db_for(&self.scope, |db| db.upsert_items(&[item], "2026-09-29T12:00:00Z").map(|_| ())).await.unwrap();
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
        use crate::auth::{GithubAuth, MemoryStore};
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
        let auth = GithubAuth::for_test(http, Arc::new(MemoryStore::default()), &server.base, None, vec![]);
        let code = CodeService::with_factory(
            auth,
            Box::new(move |s, db| Arc::new(GithubHost::new(factory_http.clone(), &base, &s.token, &Connection::github_id(&s.login), &s.login, db))),
        );
        let fx = fixture_with(Some(code)).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        fx
    }

    /// The fixture with a scripted GitHub service in place of the real one.
    pub async fn fixture_with(code: Option<CodeService>) -> Fixture {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("gossamr-core-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let site = Site { cloud_id: "site".into(), name: "Acme".into(), url: "https://acme.example".into() };
        let me = Account { account_id: "me".into(), name: "Me".into(), avatar_url: None };
        let scope = Scope::of(&site, &me);
        let creds = Credentials { tokens: Tokens { access_token: "t".into(), refresh_token: "r".into(), expires_at: u64::MAX / 2 }, site, me };
        let http = reqwest::Client::new();
        let tracker = Arc::new(Recorder::default());
        let shared = tracker.clone();
        let registry = Registry::new(move |_| shared.clone());
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let mut core = Core::new(Arc::new(Auth::signed_in(http, creds.clone())), registry, dir.clone()).with_home(home.clone());
        if let Some(code) = code {
            core = core.with_code(code);
        }
        let core = Arc::new(core);
        core.registry.register(creds.connection());

        let fx = Fixture { core, scope, tracker, dir, home };
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
