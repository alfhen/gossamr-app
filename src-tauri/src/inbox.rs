use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::{Duration, SecondsFormat, Utc};
use tokio::sync::Notify;

use crate::auth::{Account, Auth, AuthStatus, Scope, Site};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::events::{changes_since, derive, my_actions, NewEvent};
use crate::domain::{Intent, ItemRef, PersonRef, WorkItem};
use crate::model::{Attachment, CachedTicket, CreatedSubtasks, MentionRef, Person, Snapshot, Status, Ticket, Transition, Uploaded};
use crate::tracker::{self, Connection, Registry, SearchOptions, WorkTracker};

/// Tickets the user follows are those they are involved in that changed this recently. Anything else only appears
/// as context, e.g. the children of an epic they watch.
const TRACKED_WINDOW_DAYS: u32 = 30;
/// Tickets the inbox tracks. Anything past this drops out of the inbox, so it is a sanity bound, not a page size.
const TRACKED_LIMIT: usize = 2000;
/// Tickets read for context, such as an epic's children, so a very broad query can't stall a sync.
pub const CONTEXT_LIMIT: usize = 300;
/// Events this old drop out of the inbox unless they are still unread.
const EVENT_WINDOW_DAYS: i64 = 30;
/// How far back My work can reach.
const ACTIVITY_DAYS: i64 = 30;
/// Before a ticket has been opened in the app, "since you last looked" covers this many days.
const DEFAULT_SEEN_DAYS: i64 = 3;
/// Leeway for clock differences between this machine and Jira when deciding what arrived since the last sync.
const CLOCK_SKEW_MINUTES: i64 = 10;

const LAST_SYNC: &str = "last_sync_at";
const OWN_CLAUDE_SESSIONS: &str = "claude_sessions";
const OWN_SESSIONS_KEPT: usize = 50;

/// Events after this are new since the previous sync (or, before the first sync, from the last 24 hours).
fn unread_cutoff(last_sync: Option<&str>) -> String {
    match last_sync.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(at) => (at.with_timezone(&Utc) - Duration::minutes(CLOCK_SKEW_MINUTES)).to_rfc3339_opts(SecondsFormat::Secs, true),
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

fn tickets_of(items: &[WorkItem]) -> Result<Vec<CachedTicket>> {
    items.iter().map(ticket_of).collect()
}

pub struct Core {
    pub auth: Arc<Auth>,
    registry: Registry,
    data_dir: PathBuf,
    /// One database per connection, opened for whichever is signed in. A connection is a site and an account, so two
    /// people signing in to the same site on one Mac never see each other's tickets or inbox.
    db: Mutex<Option<(String, Db)>>,
    last_error: Mutex<Option<String>>,
    pub wake: Notify,
}

impl Core {
    pub fn new(auth: Arc<Auth>, registry: Registry, data_dir: PathBuf) -> Self {
        Self { auth, registry, data_dir, db: Mutex::new(None), last_error: Mutex::new(None), wake: Notify::new() }
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
            *guard = Some((connection.id.clone(), Db::open(&self.data_dir.join(db_file(&connection)))?));
        }
        f(&guard.as_ref().expect("opened above").1)
    }

    pub fn close_db(&self) {
        *self.db.lock().expect("db lock poisoned") = None;
    }

    pub fn set_error(&self, e: Option<String>) {
        *self.last_error.lock().expect("error lock poisoned") = e;
    }

    /// Fetches tracked tickets and epic children, stores them, and returns events that are new and unread.
    /// The first sync for a site returns nothing, so connecting doesn't fire a burst of notifications.
    pub async fn sync(&self) -> Result<Vec<NewEvent>> {
        let (site, me) = self.identity().await?;
        let scope = Scope::of(&site, &me);
        let started = now_iso();
        let previous = self.with_db_for(&scope, |db| db.meta(LAST_SYNC)).await?;
        let unread_after = unread_cutoff(previous.as_deref());
        let tracker = self.tracker(&scope)?;
        let opts = SearchOptions { limit: TRACKED_LIMIT, history_since: Some(unread_after.clone()) };
        let tracked = tickets_of(&tracker.followed(TRACKED_WINDOW_DAYS, &opts).await?)?;
        let epics: Vec<ItemRef> = tracked.iter().filter(|t| t.is_epic).map(|t| Self::item(&scope, &t.key)).collect();
        let context = if epics.is_empty() {
            Vec::new()
        } else {
            let opts = SearchOptions { limit: CONTEXT_LIMIT, history_since: None };
            tickets_of(&tracker.children(&epics, &opts).await?)?
        };

        self.with_db_for(&scope, |db| {
            let tracked_keys: std::collections::HashSet<&str> = tracked.iter().map(|t| t.key.as_str()).collect();
            for t in tracked.iter().chain(context.iter().filter(|t| !tracked_keys.contains(t.key.as_str()))) {
                db.upsert_ticket(t, &started)?;
            }
            let derived: Vec<NewEvent> = tracked.iter().flat_map(|t| derive(t, &me.account_id)).collect();
            let fresh = db.insert_events(&derived, &unread_after)?;
            db.insert_activity(&tracked.iter().flat_map(|t| my_actions(t, &me.account_id)).collect::<Vec<_>>())?;
            db.set_meta(LAST_SYNC, &started)?;
            Ok(if previous.is_some() { fresh } else { Vec::new() })
        })
        .await
    }

    /// Re-reads one issue after a write so the UI shows the result without waiting for the next sync.
    async fn refresh(&self, scope: &Scope, key: &str) -> Result<()> {
        let last_sync = self.with_db_for(scope, |db| db.meta(LAST_SYNC)).await?;
        let since = unread_cutoff(last_sync.as_deref());
        let t = ticket_of(&self.tracker(scope)?.item(&Self::item(scope, key), &since).await?)?;
        self.with_db_for(scope, |db| {
            db.upsert_ticket(&t, &now_iso())?;
            db.insert_events(&derive(&t, &scope.account_id), &since)?;
            db.insert_activity(&my_actions(&t, &scope.account_id))?;
            Ok(())
        })
        .await
    }

    pub async fn snapshot(&self) -> Result<Snapshot> {
        let (site, me) = self.identity().await?;
        let sync_error = self.last_error.lock().expect("error lock poisoned").clone();
        // The identity above labels the snapshot, so the data must come from that same account's database.
        self.with_db_for(&Scope::of(&site, &me), |db| {
            let last_sync = db.meta(LAST_SYNC)?;
            // Tickets refreshed within a day of the last sync; older ones have dropped out of every query.
            let cutoff = last_sync
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| (d.with_timezone(&Utc) - Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true))
                .unwrap_or_default();
            let cached = db.tickets(&cutoff)?;
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
                events: db.events(&ago(Duration::days(EVENT_WINDOW_DAYS)))?,
                watching,
                last_sync_at: last_sync,
                sync_error,
                activity: db.activity(&ago(Duration::days(ACTIVITY_DAYS)))?,
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
        let (cached, last_sync) =
            self.with_db_for(scope, |db| Ok((db.tickets("")?.into_iter().find(|t| t.key == key), db.meta(LAST_SYNC)?))).await?;
        match cached {
            Some(t) => Ok(t),
            None => ticket_of(&self.tracker(scope)?.item(&Self::item(scope, key), &unread_cutoff(last_sync.as_deref())).await?),
        }
    }

    /// Tickets matching a query in the tracker's own language, for the assistant's search tool.
    pub async fn search_native(&self, scope: &Scope, query: &str, limit: usize) -> Result<Vec<CachedTicket>> {
        let opts = SearchOptions { limit, history_since: None };
        tickets_of(&self.tracker(scope)?.search_native(query, &opts).await?)
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

    /// Remembers the Claude session last used for a ticket, and that the app started it.
    pub async fn remember_claude_session(&self, key: &str, session_id: &str, cwd: &str) -> Result<()> {
        self.with_db(|db| {
            db.set_meta(&format!("claude:{key}"), &serde_json::json!({ "id": session_id, "cwd": cwd }).to_string())?;
            let mut own: Vec<String> =
                db.meta(OWN_CLAUDE_SESSIONS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            own.retain(|s| s != session_id);
            own.insert(0, session_id.to_string());
            own.truncate(OWN_SESSIONS_KEPT);
            db.set_meta(OWN_CLAUDE_SESSIONS, &serde_json::to_string(&own)?)
        })
        .await
    }

    /// The last session used for `key` (as `{id, cwd}`), and every session the app started.
    pub async fn claude_sessions(&self, key: &str) -> Result<(Option<serde_json::Value>, Vec<String>)> {
        self.with_db(|db| {
            let last = db.meta(&format!("claude:{key}"))?.and_then(|s| serde_json::from_str(&s).ok());
            let own = db.meta(OWN_CLAUDE_SESSIONS)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            Ok((last, own))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
