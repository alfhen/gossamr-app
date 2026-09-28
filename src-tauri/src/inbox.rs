use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::{Duration, SecondsFormat, Utc};
use tokio::sync::Notify;

use crate::auth::{Account, Auth, Scope, Site};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::events::{changes_since, derive, NewEvent};
use crate::jira::Jira;
use crate::model::{CachedTicket, Person, Snapshot, Ticket, Transition};

/// Tickets the user follows. Anything else only appears as context, e.g. the children of an epic they watch.
const TRACKED_JQL: &str =
    "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -30d ORDER BY updated DESC";
/// Events this old drop out of the inbox unless they are still unread.
const EVENT_WINDOW_DAYS: i64 = 30;
/// Before a ticket has been opened in the app, "since you last looked" covers this many days.
const DEFAULT_SEEN_DAYS: i64 = 3;
/// Leeway for clock differences between this machine and Jira when deciding what arrived since the last sync.
const CLOCK_SKEW_MINUTES: i64 = 10;

const LAST_SYNC: &str = "last_sync_at";
const OWN_CLAUDE_SESSIONS: &str = "claude_sessions";
const OWN_SESSIONS_KEPT: usize = 50;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn ago(d: Duration) -> String {
    (Utc::now() - d).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Separate files per site and account, so two people signing in on one Mac never see each other's inbox.
fn db_file(scope: &Scope) -> String {
    let safe = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect::<String>();
    format!("inbox-{}-{}.sqlite", safe(&scope.cloud_id), safe(&scope.account_id))
}

pub struct Core {
    pub auth: Arc<Auth>,
    pub jira: Jira,
    data_dir: PathBuf,
    /// One database per Jira site and account, opened for whichever is signed in. Keyed by account too, so two
    /// people signing in to the same site on one Mac never see each other's tickets or inbox.
    db: Mutex<Option<(Scope, Db)>>,
    last_error: Mutex<Option<String>>,
    pub wake: Notify,
}

impl Core {
    pub fn new(auth: Arc<Auth>, jira: Jira, data_dir: PathBuf) -> Self {
        Self { auth, jira, data_dir, db: Mutex::new(None), last_error: Mutex::new(None), wake: Notify::new() }
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
        if guard.as_ref().map(|(open, _)| open != scope).unwrap_or(true) {
            *guard = Some((scope.clone(), Db::open(&self.data_dir.join(db_file(scope)))?));
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
        let tracked = self.jira.search(&scope, TRACKED_JQL, true).await?;
        let epics: Vec<&str> = tracked.iter().filter(|t| t.is_epic).map(|t| t.key.as_str()).collect();
        let context = if epics.is_empty() {
            Vec::new()
        } else {
            let jql = format!("parent in ({}) ORDER BY updated DESC", epics.join(","));
            self.jira.search(&scope, &jql, false).await?
        };

        self.with_db_for(&scope, |db| {
            let previous = db.meta(LAST_SYNC)?;
            let unread_after = match &previous {
                Some(at) => (chrono::DateTime::parse_from_rfc3339(at).map(|d| d.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now())
                    - Duration::minutes(CLOCK_SKEW_MINUTES))
                .to_rfc3339_opts(SecondsFormat::Secs, true),
                None => ago(Duration::hours(24)),
            };
            let tracked_keys: std::collections::HashSet<&str> = tracked.iter().map(|t| t.key.as_str()).collect();
            for t in tracked.iter().chain(context.iter().filter(|t| !tracked_keys.contains(t.key.as_str()))) {
                db.upsert_ticket(t, &started)?;
            }
            let derived: Vec<NewEvent> = tracked.iter().flat_map(|t| derive(t, &me.account_id)).collect();
            let fresh = db.insert_events(&derived, &unread_after)?;
            db.set_meta(LAST_SYNC, &started)?;
            Ok(if previous.is_some() { fresh } else { Vec::new() })
        })
        .await
    }

    /// Re-reads one issue after a write so the UI shows the result without waiting for the next sync.
    async fn refresh(&self, scope: &Scope, key: &str) -> Result<()> {
        let t = self.jira.issue(scope, key).await?;
        self.with_db_for(scope, |db| {
            db.upsert_ticket(&t, &now_iso())?;
            // Same 24 hour lookback as the first sync, so recent activity on this ticket still arrives unread.
            let since = db.meta(LAST_SYNC)?.unwrap_or_else(|| ago(Duration::hours(24)));
            db.insert_events(&derive(&t, &scope.account_id), &since)?;
            Ok(())
        })
        .await
    }

    pub async fn snapshot(&self) -> Result<Snapshot> {
        let (site, me) = self.identity().await?;
        let sync_error = self.last_error.lock().expect("error lock poisoned").clone();
        self.with_db(|db| {
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
                        comments: t.comments,
                        subtasks: t.subtasks,
                        due_date: t.due_date,
                        sprint: None,
                        updated: t.updated,
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
        self.jira.mentionable(scope, key, query).await
    }

    pub async fn transitions(&self, scope: &Scope, key: &str) -> Result<Vec<Transition>> {
        self.jira.transitions(scope, key).await
    }

    /// `scope` is the account the user was looking at when they acted; the write is refused if that has changed.
    pub async fn transition(&self, scope: &Scope, key: &str, transition_id: &str) -> Result<()> {
        self.jira.transition(scope, key, transition_id).await?;
        self.after_write(scope, key).await;
        Ok(())
    }

    /// `scope` is the account the user was looking at when they acted; the write is refused if that has changed.
    pub async fn comment(&self, scope: &Scope, key: &str, body: &str, mentions: &[crate::adf::MentionRef]) -> Result<()> {
        let body = body.trim();
        if body.is_empty() {
            return Err(Error::Api { status: 400, message: "a comment can't be empty".into() });
        }
        self.jira.comment(scope, key, body, mentions).await?;
        self.after_write(scope, key).await;
        Ok(())
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
        let cached = self.with_db_for(scope, |db| Ok(db.tickets("")?.into_iter().find(|t| t.key == key))).await?;
        match cached {
            Some(t) => Ok(t),
            None => self.jira.issue(scope, key).await,
        }
    }

    /// `scope` is the account the user was looking at when they approved; the write is refused if that has changed.
    pub async fn create_subtasks(&self, scope: &Scope, key: &str, summaries: &[String]) -> Result<Vec<String>> {
        let created = self.jira.create_subtasks(scope, key, summaries).await?;
        self.after_write(scope, key).await;
        Ok(created)
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
    fn each_site_and_account_gets_its_own_database_file() {
        let a = Scope { cloud_id: "c1".into(), account_id: "712020:ab-cd".into() };
        let b = Scope { cloud_id: "c1".into(), account_id: "someone-else".into() };
        assert_eq!(db_file(&a), "inbox-c1-712020_ab-cd.sqlite");
        assert_ne!(db_file(&a), db_file(&b));
        assert!(!db_file(&Scope { cloud_id: "../x".into(), account_id: "y".into() }).contains('/'));
    }
}
