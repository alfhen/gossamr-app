//! Core's code host service: GitHub connections, each with its own database, and the watch set over repositories.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};

use super::watch::{CatalogEntry, CatalogPage, WatchRow, WatchState};
use super::{now_iso, Core};
use crate::auth::Scope;
use crate::auth::{DeviceStart, GithubAuth, GithubSession, KeychainStore, TokenStore};
use crate::codehost::events::{derive, from_notice, recent};
use crate::codehost::github::{GithubHost, API_BASE};
use crate::codehost::links::{discover, KnownKeys};
use crate::codehost::{CodeHost, PullList};
use crate::db::{stamp, Db};
use crate::domain::{
    CheckState, CodeChange, CodeChangeState, CodeFile, CodeHit, CommitQuery, ContainerQuery, ContainerSummary, DevLink, Event, Footprint, ItemRef,
    PullRequestDetail, TreeEntry, WatchChange, WatchMode, WatchSet, AUTO_EVERYTHING_MAX,
};
use crate::error::{Error, Result};
use crate::sync::Trigger;
use crate::tracker::{Connection, ConnectionKind};

const CATALOG_SIZE: &str = "watch_catalog_size";
const CATALOG_PROBED: &str = "watch_catalog_probed_at";
const FOOTPRINT: &str = "watch_footprint";
const PROBE_EVERY: Duration = Duration::hours(12);
const FOOTPRINT_TTL: Duration = Duration::hours(6);
const FOOTPRINT_DAYS: u32 = 90;
const CATALOG_PAGE: usize = 50;
/// Pull requests are followed while they are open and for this long after they last changed.
const PR_WINDOW_DAYS: i64 = 30;
/// Changes of repositories that are no longer watched are kept this long, so watching again needs no refetch.
const UNWATCH_GRACE_DAYS: i64 = 14;
const NOTIFICATIONS_NEXT: &str = "notifications_next_at";
const MIN_POLL_SECS: i64 = 60;
/// Answers not refreshed for this long are dropped from the conditional-request cache.
const HTTP_CACHE_DAYS: i64 = 14;
pub const LAST_SYNC: &str = "last_sync_at";

pub fn is_code_connection(id: &str) -> bool {
    id.starts_with("github:")
}

fn db_file(login: &str) -> String {
    let safe: String = login.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    format!("github-{safe}.sqlite")
}

type HostFactory = Box<dyn Fn(&GithubSession, Arc<Mutex<Db>>) -> Arc<dyn CodeHost> + Send + Sync>;

/// The GitHub connections, their databases and the hosts that talk to GitHub for them.
pub struct CodeService {
    pub auth: GithubAuth,
    factory: HostFactory,
    sessions: Mutex<HashMap<String, GithubSession>>,
    dbs: Mutex<HashMap<String, Arc<Mutex<Db>>>>,
    hosts: Mutex<HashMap<String, Arc<dyn CodeHost>>>,
    device: tokio::sync::Mutex<Option<crate::auth::DeviceChallenge>>,
    errors: Mutex<HashMap<String, String>>,
    syncing: Mutex<HashSet<String>>,
}

impl CodeService {
    pub fn new(http: reqwest::Client, store: Arc<dyn TokenStore>) -> Self {
        let client = http.clone();
        let factory: HostFactory = Box::new(move |s, db| {
            Arc::new(GithubHost::new(client.clone(), API_BASE, &s.token, &Connection::github_id(&s.login), &s.login, db))
        });
        Self::with_factory(GithubAuth::new(http, store), factory)
    }

    pub fn with_factory(auth: GithubAuth, factory: HostFactory) -> Self {
        Self {
            auth,
            factory,
            sessions: Mutex::new(HashMap::new()),
            dbs: Mutex::new(HashMap::new()),
            hosts: Mutex::new(HashMap::new()),
            device: tokio::sync::Mutex::new(None),
            errors: Mutex::new(HashMap::new()),
            syncing: Mutex::new(HashSet::new()),
        }
    }

    pub fn sign_in_options(&self) -> crate::auth::SignInOptions {
        self.auth.options()
    }

    pub fn default_store() -> Arc<dyn TokenStore> {
        Arc::new(KeychainStore)
    }

    fn remember(&self, session: GithubSession) -> Connection {
        let connection = session.connection();
        self.hosts.lock().expect("host lock poisoned").remove(&connection.id);
        self.sessions.lock().expect("session lock poisoned").insert(connection.id.clone(), session);
        connection
    }

    fn session(&self, id: &str) -> Result<GithubSession> {
        self.sessions.lock().expect("session lock poisoned").get(id).cloned().ok_or(Error::NotSignedIn)
    }

    pub fn connection_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.sessions.lock().expect("session lock poisoned").keys().cloned().collect();
        ids.sort();
        ids
    }
}

/// A connection as Settings shows it.
fn info(session: &GithubSession, last_sync_at: Option<String>, error: Option<String>) -> super::ConnectionInfo {
    super::ConnectionInfo {
        id: session.connection().id,
        kind: ConnectionKind::Github,
        workspace: session.login.clone(),
        url: format!("https://github.com/{}", session.login),
        account: session.name.clone().unwrap_or_else(|| session.login.clone()),
        last_sync_at,
        syncing: false,
        error,
    }
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

impl Core {
    pub fn code_sign_in_options(&self) -> crate::auth::SignInOptions {
        self.code.sign_in_options()
    }

    /// Registers the GitHub sign-ins kept in the Keychain.
    pub async fn restore_code(&self) {
        for session in self.code.auth.restore() {
            let connection = self.code.remember(session);
            self.registry.register(connection);
        }
    }

    fn code_db(&self, id: &str) -> Result<Arc<Mutex<Db>>> {
        let session = self.code.session(id)?;
        let mut dbs = self.code.dbs.lock().expect("db map lock poisoned");
        if let Some(db) = dbs.get(id) {
            return Ok(db.clone());
        }
        let db = Arc::new(Mutex::new(Db::open(&self.data_dir.join(db_file(&session.login)))?));
        dbs.insert(id.to_string(), db.clone());
        Ok(db)
    }

    pub(super) fn with_code_db<T>(&self, id: &str, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let db = self.code_db(id)?;
        let guard = db.lock().expect("db lock poisoned");
        f(&guard)
    }

    /// The host for a connection, after renewing its token when it is about to expire.
    pub(super) async fn code_host(&self, id: &str) -> Result<Arc<dyn CodeHost>> {
        if let Some(h) = self.code.hosts.lock().expect("host lock poisoned").get(id) {
            return Ok(h.clone());
        }
        let session = self.code.auth.fresh(self.code.session(id)?).await?;
        let session = self.code.sessions.lock().expect("session lock poisoned").entry(id.to_string()).and_modify(|s| *s = session.clone()).or_insert(session).clone();
        let host = (self.code.factory)(&session, self.code_db(id)?);
        // A token that expires soon must not be served from a host built with the old one.
        if session.expires_at.is_none() {
            self.code.hosts.lock().expect("host lock poisoned").insert(id.to_string(), host.clone());
        }
        Ok(host)
    }

    async fn connected(&self, session: GithubSession) -> Result<super::ConnectionInfo> {
        let connection = self.code.remember(session.clone());
        self.registry.register(connection.clone());
        // So the catalog is known before the first sync, which a search of the watched repositories depends on.
        let _ = self.probe_code_catalog(&connection.id).await;
        self.wake.notify_one();
        Ok(info(&session, None, None))
    }

    pub async fn github_connect_token(&self, token: &str) -> Result<super::ConnectionInfo> {
        let session = self.code.auth.connect_token(token).await?;
        self.connected(session).await
    }

    pub async fn github_import_gh_token(&self) -> Result<super::ConnectionInfo> {
        let session = self.code.auth.import_gh_token().await?;
        self.connected(session).await
    }

    pub async fn github_device_start(&self) -> Result<DeviceStart> {
        let challenge = self.code.auth.device_start().await?;
        let start = challenge.start.clone();
        *self.code.device.lock().await = Some(challenge);
        Ok(start)
    }

    /// Waits for the code from `github_device_start` to be authorised, then connects.
    pub async fn github_device_poll(&self) -> Result<super::ConnectionInfo> {
        let challenge = self.code.device.lock().await.clone().ok_or_else(|| Error::Auth("start signing in first".into()))?;
        let session = self.code.auth.device_wait(&challenge).await;
        *self.code.device.lock().await = None;
        self.connected(session?).await
    }

    /// Forgets the account: its token leaves the Keychain and its cached data is deleted.
    pub async fn github_disconnect(&self, connection_id: &str) -> Result<()> {
        let session = self.code.session(connection_id)?;
        self.code.auth.disconnect(&session.login)?;
        self.code.sessions.lock().expect("session lock poisoned").remove(connection_id);
        self.code.hosts.lock().expect("host lock poisoned").remove(connection_id);
        self.code.dbs.lock().expect("db map lock poisoned").remove(connection_id);
        self.registry.remove(connection_id);
        let path = self.data_dir.join(db_file(&session.login));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        Ok(())
    }

    pub(super) fn code_connections(&self) -> Vec<super::ConnectionInfo> {
        let sessions = self.code.sessions.lock().expect("session lock poisoned").clone();
        self.code
            .connection_ids()
            .iter()
            .filter_map(|id| {
                let last = self.with_code_db(id, |db| db.meta(LAST_SYNC)).ok().flatten();
                let error = self.code.errors.lock().expect("error lock poisoned").get(id).cloned();
                let syncing = self.code.syncing.lock().expect("sync lock poisoned").contains(id);
                sessions.get(id).map(|s| super::ConnectionInfo { syncing, ..info(s, last, error) })
            })
            .collect()
    }

    /// Reads the size of the catalog when it hasn't been read lately, and watches a small one whole. A catalog that
    /// can't be read leaves the choice for later.
    async fn probe_code_catalog(&self, id: &str) -> Result<()> {
        let (mode, probed) = self.with_code_db(id, |db| {
            db.http_cache_prune(id, &crate::db::stamp(Utc::now() - Duration::days(HTTP_CACHE_DAYS)))?;
            Ok((db.watch_mode(id)?, db.meta(CATALOG_PROBED)?))
        })?;
        if probed.and_then(|s| parse_time(&s)).is_some_and(|at| Utc::now() - at < PROBE_EVERY) {
            return Ok(());
        }
        let probe = ContainerQuery { query: String::new(), cursor: None, limit: AUTO_EVERYTHING_MAX + 1 };
        let Ok(page) = self.code_host(id).await?.list_repositories(&probe).await else { return Ok(()) };
        let small = page.containers.len() <= AUTO_EVERYTHING_MAX && page.next.is_none();
        self.with_code_db(id, |db| {
            db.catalog_upsert(id, &page.containers, &now_iso())?;
            db.set_meta(CATALOG_SIZE, &page.containers.len().min(AUTO_EVERYTHING_MAX + 1).to_string())?;
            db.set_meta(CATALOG_PROBED, &now_iso())?;
            if small && mode == WatchMode::Unset {
                db.set_watch_mode(id, WatchMode::Everything, &now_iso())?;
            }
            Ok(())
        })
    }

    pub(super) async fn code_watch_states(&self) -> Result<Vec<WatchState>> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            // The probe is best effort; the state is shown from whatever is stored.
            let _ = self.probe_code_catalog(&id).await;
            out.push(self.with_code_db(&id, |db| {
                let set = db.watch_set(&id)?;
                let counts = db.code_change_counts(&id)?;
                let size: Option<usize> = db.meta(CATALOG_SIZE)?.and_then(|s| s.parse().ok());
                let watches = set
                    .watches
                    .iter()
                    .map(|w| {
                        let ext = &w.container.external_id;
                        let known = db.catalog_search(&id, ext, 5).ok().and_then(|c| c.into_iter().find(|c| &c.container_ref.external_id == ext));
                        let (key, name) = known.map(|c| (c.key, c.name)).unwrap_or_else(|| (ext.clone(), ext.rsplit('/').next().unwrap_or(ext).to_string()));
                        WatchRow { watch: w.clone(), key, name, cached_items: counts.get(ext).copied().unwrap_or(0) }
                    })
                    .collect();
                let needs_choice = set.mode == WatchMode::Unset && size.is_some_and(|n| n > AUTO_EVERYTHING_MAX);
                Ok(WatchState { connection_id: id.clone(), mode: set.mode, needs_choice, catalog_size: size, watches })
            })?);
        }
        Ok(out)
    }

    pub(super) async fn code_watch_set_mode(&self, id: &str, mode: WatchMode) -> Result<()> {
        self.code.session(id)?;
        self.with_code_db(id, |db| db.set_watch_mode(id, mode, &now_iso()))?;
        self.wake.notify_one();
        Ok(())
    }

    pub(super) async fn code_watch_set_containers(&self, id: &str, changes: &[WatchChange]) -> Result<()> {
        self.code.session(id)?;
        self.with_code_db(id, |db| db.apply_watch_changes(id, changes, &now_iso()))?;
        self.wake.notify_one();
        Ok(())
    }

    /// The repositories of the catalog matching `query`, straight from GitHub, remembering what it lists.
    pub(super) async fn code_watch_catalog(&self, id: &str, query: &str, cursor: Option<String>) -> Result<CatalogPage> {
        let set: WatchSet = self.with_code_db(id, |db| db.watch_set(id))?;
        let q = ContainerQuery { query: query.trim().into(), cursor, limit: CATALOG_PAGE };
        let entry = |summary: ContainerSummary| {
            let watched = set.is_watched(&summary.container_ref.external_id);
            CatalogEntry { summary, watched }
        };
        match self.code_host(id).await?.list_repositories(&q).await {
            Ok(page) => {
                self.with_code_db(id, |db| db.catalog_upsert(id, &page.containers, &now_iso()))?;
                Ok(CatalogPage { containers: page.containers.into_iter().map(entry).collect(), next: page.next, offline: false })
            }
            Err(Error::Http(_)) if q.cursor.is_none() => {
                let cached = self.with_code_db(id, |db| db.catalog_search(id, &q.query, CATALOG_PAGE))?;
                Ok(CatalogPage { containers: cached.into_iter().map(entry).collect(), next: None, offline: true })
            }
            Err(e) => Err(e),
        }
    }

    /// Repositories the person was active in lately. Kept for a few hours, since answering costs several searches.
    pub(super) async fn code_watch_suggestions(&self, id: &str, refresh: bool) -> Result<Vec<Footprint>> {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Cached {
            at: String,
            rows: Vec<Footprint>,
        }
        let cached: Option<Cached> = self.with_code_db(id, |db| Ok(db.meta(FOOTPRINT)?.and_then(|s| serde_json::from_str(&s).ok())))?;
        if let Some(c) = cached.filter(|c| !refresh && parse_time(&c.at).is_some_and(|at| Utc::now() - at < FOOTPRINT_TTL)) {
            return Ok(c.rows);
        }
        let rows = self.code_host(id).await?.footprint(FOOTPRINT_DAYS).await?;
        let stored = serde_json::to_string(&Cached { at: now_iso(), rows: rows.clone() })?;
        self.with_code_db(id, |db| db.set_meta(FOOTPRINT, &stored))?;
        Ok(rows)
    }
}

/// What a sync of a GitHub connection left behind.
pub struct CodeSynced {
    /// Whether any cached change or event is new or different.
    pub changed: bool,
    /// Whether the set of work items linked to code changed.
    pub links_changed: bool,
}

/// A pull request to read in full.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRef {
    pub connection_id: String,
    pub repo: String,
    pub number: u64,
}

fn refused(repo: &str) -> Error {
    Error::CodeHost { status: 403, message: format!("{repo} isn't one of the repositories you watch, so it isn't read.") }
}

/// Repository names are not case sensitive on GitHub, and a watch may have been typed with other capitals.
fn is_watched_repo(repos: &[String], repo: &str) -> bool {
    repos.iter().any(|r| r.eq_ignore_ascii_case(repo))
}

fn me_of(change: &CodeChange, me: &str) -> bool {
    change.author.as_ref().is_some_and(|a| a.account_id.eq_ignore_ascii_case(me))
}

fn newest_first(links: &mut [DevLink]) {
    links.sort_by(|a, b| b.confidence.total_cmp(&a.confidence).then(b.change.updated_at.cmp(&a.change.updated_at)).then(a.change.external_id.cmp(&b.change.external_id)));
}

impl Core {
    /// The repositories a connection follows: the ones chosen, or every repository of a catalog small enough to watch
    /// whole. A large catalog nobody has chosen from yields none, and archived repositories are left out of a whole-catalog watch.
    pub fn watched_repos(&self, id: &str) -> Result<Vec<String>> {
        self.with_code_db(id, |db| {
            let set = db.watch_set(id)?;
            let catalog = || -> Result<Vec<String>> { Ok(db.catalog_search(id, "", usize::MAX >> 1)?.into_iter().filter(|c| !c.archived).map(|c| c.container_ref.external_id).collect()) };
            let size: Option<usize> = db.meta(CATALOG_SIZE)?.and_then(|s| s.parse().ok());
            Ok(match set.mode {
                WatchMode::Selected => set.watches.iter().filter(|w| w.unwatched_at.is_none() && !w.inaccessible).map(|w| w.container.external_id.clone()).collect(),
                WatchMode::Everything => catalog()?,
                WatchMode::Unset if size.is_some_and(|n| n <= AUTO_EVERYTHING_MAX) => catalog()?,
                WatchMode::Unset => Vec::new(),
            })
        })
    }

    fn require_watched(&self, id: &str, repo: &str) -> Result<()> {
        if is_watched_repo(&self.watched_repos(id)?, repo) {
            Ok(())
        } else {
            Err(refused(repo))
        }
    }

    /// The project keys of the signed-in tracker, which are what a key in a branch or title may name.
    async fn known_keys(&self) -> KnownKeys {
        let Some((site, me)) = self.auth.identity().await else { return KnownKeys::default() };
        let connection = Connection::jira_id(&Scope::of(&site, &me));
        let keys = self.with_db(|db| db.project_keys(&connection)).await.unwrap_or_default();
        KnownKeys::new(keys.iter().map(|k| (k.as_str(), connection.as_str())))
    }

    /// Rebuilds the links of a connection from its cached changes. Returns whether they changed.
    fn rediscover(&self, id: &str, known: &KnownKeys) -> Result<bool> {
        let repos = self.watched_repos(id)?;
        self.with_code_db(id, |db| {
            let before = db.link_signature(id)?;
            let originals: Vec<CodeChange> = db.code_changes(id)?.into_iter().filter(|c| is_watched_repo(&repos, &c.repo)).collect();
            let mut changes = originals.clone();
            let links = discover(&mut changes, known);
            let moved: Vec<CodeChange> = changes.iter().zip(&originals).filter(|(a, b)| a.linked_keys != b.linked_keys).map(|(a, _)| a.clone()).collect();
            let at = stamp(Utc::now());
            db.upsert_code_changes(&moved, &at)?;
            db.replace_item_links(id, &links, &at)?;
            Ok(db.link_signature(id)? != before)
        })
    }

    async fn sync_repo(&self, host: &dyn CodeHost, id: &str, me: &str, repo: &str, since: DateTime<Utc>) -> Result<bool> {
        let PullList { changes: listed, .. } = host.pull_requests(repo, since).await?;
        let previous: HashMap<String, CodeChange> = self.with_code_db(id, |db| Ok(db.code_changes(id)?.into_iter().filter(|c| c.repo == repo).map(|c| (c.external_id.clone(), c)).collect()))?;
        let mut stored = Vec::new();
        let mut events: Vec<Event> = Vec::new();
        for listed in listed {
            let prev = previous.get(&listed.external_id);
            let open = matches!(listed.state, CodeChangeState::Open | CodeChangeState::Draft);
            let stale = prev.is_none_or(|p| p.updated_at != listed.updated_at || p.sha != listed.sha);
            // Checks finish without the pull request changing, so the person's own and unfinished ones are looked at again.
            let recheck = open && prev.is_some_and(|p| me_of(p, me) || p.checks == CheckState::Pending);
            let (now, reviews) = if stale || recheck {
                let read = host.refresh_pull_request(&listed, open).await?;
                (read.change, read.reviews)
            } else {
                let p = prev.expect("not stale implies cached");
                (CodeChange { checks: p.checks, review: p.review, additions: p.additions, deletions: p.deletions, changed_files: p.changed_files, linked_keys: p.linked_keys.clone(), ..listed }, Vec::new())
            };
            events.extend(recent(derive(me, prev, &now, &reviews), since));
            if prev != Some(&now) {
                stored.push(now);
            }
        }
        let changed = !stored.is_empty();
        self.with_code_db(id, |db| {
            db.upsert_code_changes(&stored, &stamp(Utc::now()))?;
            Ok(db.insert_cache_events(&events)? > 0 || changed)
        })
    }

    /// Reads the notification threads aimed at the person, when the token may and GitHub's poll interval allows.
    async fn sync_notifications(&self, host: &dyn CodeHost, id: &str, repos: &[String]) -> Result<bool> {
        let session = self.code.session(id)?;
        if !session.can_read_notifications() {
            return Ok(false);
        }
        let due = self.with_code_db(id, |db| Ok(db.meta(NOTIFICATIONS_NEXT)?.and_then(|s| parse_time(&s)).is_none_or(|at| Utc::now() >= at)))?;
        if !due {
            return Ok(false);
        }
        let read = match host.notifications().await {
            Ok(r) => r,
            // A token that can't read them just doesn't feed Activity with them.
            Err(Error::CodeHost { .. }) => return Ok(false),
            Err(e) => return Err(e),
        };
        let wait = read.poll_interval.map_or(MIN_POLL_SECS, |s| s as i64).max(MIN_POLL_SECS);
        let events: Vec<Event> = if read.unchanged {
            Vec::new()
        } else {
            read.notices.iter().filter(|n| is_watched_repo(repos, &n.repo)).filter_map(|n| from_notice(id, n)).collect()
        };
        self.with_code_db(id, |db| {
            db.set_meta(NOTIFICATIONS_NEXT, &stamp(Utc::now() + Duration::seconds(wait)))?;
            Ok(db.insert_cache_events(&events)? > 0)
        })
    }

    /// Reads the watched repositories' pull requests, derives events, rebuilds links and polls notifications.
    pub async fn sync_code(&self, id: &str) -> Result<CodeSynced> {
        self.sync_code_at(id, Utc::now()).await
    }

    async fn sync_code_at(&self, id: &str, started: DateTime<Utc>) -> Result<CodeSynced> {
        let me = self.code.session(id)?.login;
        let host = self.code_host(id).await?;
        self.probe_code_catalog(id).await?;
        let repos = self.watched_repos(id)?;
        let since = started - Duration::days(PR_WINDOW_DAYS);
        let (mut changed, mut stop) = (false, None);
        for repo in &repos {
            match self.sync_repo(host.as_ref(), id, &me, repo, since).await {
                Ok(c) => changed |= c,
                Err(Error::CodeHost { status: 403 | 404, .. }) => self.with_code_db(id, |db| db.set_inaccessible(id, std::slice::from_ref(repo), true))?,
                Err(e @ Error::RateLimited { .. }) => {
                    stop = Some(e);
                    break;
                }
                Err(e) => {
                    stop.get_or_insert(e);
                }
            }
        }
        if stop.is_none() {
            changed |= self.sync_notifications(host.as_ref(), id, &repos).await.unwrap_or(false);
        }
        let links_changed = self.rediscover(id, &self.known_keys().await)?;
        self.with_code_db(id, |db| {
            db.prune_code_changes(id, &repos, &stamp(started - Duration::days(UNWATCH_GRACE_DAYS)))?;
            db.set_meta(LAST_SYNC, &stamp(started))
        })?;
        match stop {
            Some(e) => Err(e),
            None => Ok(CodeSynced { changed, links_changed }),
        }
    }

    /// Syncs each GitHub connection that is due. Each has its own schedule, so one that is rate limited waits alone.
    pub async fn sync_code_if_due(&self, trigger: Trigger) -> Vec<(String, Result<CodeSynced>)> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            let due = self.schedules.lock().expect("schedule lock poisoned").entry(id.clone()).or_default().due(Utc::now(), trigger);
            if !due {
                continue;
            }
            self.code.syncing.lock().expect("sync lock poisoned").insert(id.clone());
            let result = self.sync_code(&id).await;
            self.code.syncing.lock().expect("sync lock poisoned").remove(&id);
            {
                let mut schedules = self.schedules.lock().expect("schedule lock poisoned");
                let schedule = schedules.entry(id.clone()).or_default();
                schedule.finished(Utc::now(), result.is_ok());
                if let Err(Error::RateLimited { retry_after_secs, .. }) = &result {
                    schedule.defer(Utc::now() + Duration::seconds(*retry_after_secs as i64));
                }
            }
            let error = result.as_ref().err().map(|e| e.to_string());
            match error {
                Some(e) => self.code.errors.lock().expect("error lock poisoned").insert(id.clone(), e),
                None => self.code.errors.lock().expect("error lock poisoned").remove(&id),
            };
            out.push((id, result));
        }
        out
    }

    /// Pull request and notification events across the GitHub connections, newest first.
    pub fn code_events(&self, limit: usize) -> Result<Vec<Event>> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            out.extend(self.with_code_db(&id, |db| db.code_events(&id, limit))?);
        }
        out.sort_by(|a, b| b.at.cmp(&a.at).then(a.id.cmp(&b.id)));
        out.truncate(limit);
        Ok(out)
    }

    /// The code changes cached for a work item, from every GitHub connection, in repositories that are watched.
    pub fn dev_links(&self, item: &ItemRef) -> Result<Vec<DevLink>> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            let repos = self.watched_repos(&id)?;
            out.extend(self.with_code_db(&id, |db| db.dev_links(item))?.into_iter().filter(|l| is_watched_repo(&repos, &l.change.repo)));
        }
        newest_first(&mut out);
        Ok(out)
    }

    /// Searches the watched repositories for the item's key, caches what it finds and returns the links. The bool is
    /// the connections whose links changed.
    pub async fn dev_links_live(&self, item: &ItemRef) -> Result<(Vec<DevLink>, Vec<String>)> {
        let mut changed = Vec::new();
        let mut known = self.known_keys().await;
        if known.item(&item.key).is_none() {
            if let Some((prefix, _)) = item.key.rsplit_once('-') {
                known = KnownKeys::new([(prefix, item.connection_id.as_str())]);
            }
        }
        for id in self.code.connection_ids() {
            let repos = self.watched_repos(&id)?;
            if repos.is_empty() {
                continue;
            }
            // One account that is refused or limited must not hide what the others, and the cache, have.
            let Ok(host) = self.code_host(&id).await else { continue };
            let Ok(found) = host.search(&item.key, &repos).await else { continue };
            let found: Vec<CodeChange> = found.into_iter().filter(|c| is_watched_repo(&repos, &c.repo)).collect();
            self.with_code_db(&id, |db| {
                // What a sync already read in full is better than what a search saw of it.
                let fresh: Vec<CodeChange> = found.into_iter().filter(|c| db.code_change(&id, &c.external_id).ok().flatten().is_none()).collect();
                db.upsert_code_changes(&fresh, &stamp(Utc::now()))
            })?;
            if self.rediscover(&id, &known)? {
                changed.push(id.clone());
            }
        }
        Ok((self.dev_links(item)?, changed))
    }

    pub async fn code_pull_request(&self, r: &CodeRef) -> Result<PullRequestDetail> {
        self.require_watched(&r.connection_id, &r.repo)?;
        self.code_host(&r.connection_id).await?.pull_request(&r.repo, r.number).await
    }

    /// Pull requests, branches and commits in the watched repositories that match `query`, newest first.
    pub async fn code_search(&self, query: &str) -> Result<Vec<CodeChange>> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            let repos = self.watched_repos(&id)?;
            if !repos.is_empty() {
                out.extend(self.code_host(&id).await?.search(query, &repos).await?);
            }
        }
        out.sort_by_key(|c| std::cmp::Reverse(c.updated_at));
        Ok(out)
    }

    pub async fn code_file(&self, connection_id: &str, repo: &str, path: &str, reference: Option<&str>) -> Result<CodeFile> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.file(repo, path, reference).await
    }

    pub async fn code_tree(&self, connection_id: &str, repo: &str, path: &str, reference: Option<&str>) -> Result<Vec<TreeEntry>> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.tree(repo, path, reference).await
    }

    pub async fn code_commits(&self, connection_id: &str, q: &CommitQuery) -> Result<Vec<CodeChange>> {
        self.require_watched(connection_id, &q.repo)?;
        self.code_host(connection_id).await?.commits(q).await
    }

    /// Code search across `repos` (every watched repository when none are named), never outside what is watched.
    pub async fn code_search_code(&self, connection_id: &str, query: &str, repos: Option<&[String]>) -> Result<Vec<CodeHit>> {
        let watched = self.watched_repos(connection_id)?;
        let asked: Vec<String> = match repos {
            Some(r) => {
                if let Some(bad) = r.iter().find(|r| !is_watched_repo(&watched, r)) {
                    return Err(refused(bad));
                }
                r.to_vec()
            }
            None => watched,
        };
        if asked.is_empty() {
            return Ok(Vec::new());
        }
        self.code_host(connection_id).await?.search_code(query, &asked).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::auth::{Auth, GithubAuth};
    use crate::auth::MemoryStore;
    use crate::codehost::github::testserver::{serve, Reply, Server};
    use crate::domain::WatchSource;
    use crate::tracker::Registry;

    const USER: &str = include_str!("../codehost/github/fixtures/user.json");
    const REPOS: &str = include_str!("../codehost/github/fixtures/repos.json");

    struct Fx {
        core: Core,
        store: Arc<MemoryStore>,
        server: Server,
        dir: std::path::PathBuf,
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// `n` repositories named `acme/r1`…, most recently pushed first.
    fn many(n: usize) -> String {
        let repos: Vec<String> = (1..=n)
            .map(|i| format!("{{\"full_name\":\"acme/r{i}\",\"name\":\"r{i}\",\"archived\":false,\"pushed_at\":\"2026-09-{:02}T10:00:00Z\",\"permissions\":{{\"push\":true}}}}", 30 - i.min(29)))
            .collect();
        format!("[{}]", repos.join(","))
    }

    async fn fixture(repos: &str) -> Fx {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("gossamr-code-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let server = serve(vec![
            ("/user", vec![Reply::ok(USER)]),
            ("/user/repos", vec![Reply::ok(repos)]),
            ("/search/issues", vec![Reply::ok("{\"items\":[]}")]),
            ("/users/ann/events", vec![Reply::ok("[]")]),
        ])
        .await;
        let store = Arc::new(MemoryStore::default());
        let http = reqwest::Client::new();
        let base = server.base.clone();
        let factory_http = http.clone();
        let auth = GithubAuth::for_test(http.clone(), store.clone(), &server.base, None, vec![]);
        let code = CodeService::with_factory(
            auth,
            Box::new(move |s, db| Arc::new(GithubHost::new(factory_http.clone(), &base, &s.token, &Connection::github_id(&s.login), &s.login, db))),
        );
        let registry = Registry::new(|_| unreachable!("no tracker for GitHub"));
        let core = Core::new(Arc::new(Auth::signed_out(http)), registry, dir.clone()).with_code(code);
        Fx { core, store, server, dir }
    }

    #[tokio::test]
    async fn connecting_a_token_registers_a_github_connection_and_lists_it() {
        let fx = fixture(REPOS).await;
        let connected = fx.core.github_connect_token("ghp_x").await.unwrap();
        assert_eq!((connected.id.as_str(), connected.kind, connected.workspace.as_str(), connected.account.as_str()), ("github:ann", ConnectionKind::Github, "ann", "Ann Example"));
        assert_eq!(fx.core.registry.connection("github:ann").unwrap().kind, ConnectionKind::Github);
        let listed = fx.core.connections().await.unwrap();
        assert_eq!(listed.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["github:ann"]);
        assert_eq!(listed[0].url, "https://github.com/ann");
    }

    #[tokio::test]
    async fn sign_ins_in_the_keychain_come_back_at_launch_and_two_accounts_can_coexist() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        let other = fixture(REPOS).await;
        other.store.save(&fx.store.load("ann").unwrap().unwrap()).unwrap();
        let mut bot = fx.store.load("ann").unwrap().unwrap();
        bot.login = "acme-bot".into();
        other.store.save(&bot).unwrap();
        other.core.restore().await;
        let ids: Vec<String> = other.core.connections().await.unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["github:acme-bot", "github:ann"]);
        assert_ne!(db_file("ann"), db_file("acme-bot"));
    }

    #[tokio::test]
    async fn a_small_catalog_is_watched_whole_without_asking() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        let [state] = fx.core.watch_state().await.unwrap().try_into().unwrap();
        assert_eq!((state.mode, state.needs_choice, state.catalog_size), (WatchMode::Everything, false, Some(3)));
    }

    #[tokio::test]
    async fn a_catalog_over_twelve_repositories_waits_for_the_person_to_choose() {
        let fx = fixture(&many(13)).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        let [state] = fx.core.watch_state().await.unwrap().try_into().unwrap();
        assert_eq!((state.mode, state.needs_choice, state.catalog_size), (WatchMode::Unset, true, Some(13)));

        fx.core.watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        let change = WatchChange { container_id: "acme/r2".into(), watched: Some(true), source: Some(WatchSource::Footprint), ..Default::default() };
        fx.core.watch_set_containers("github:ann", &[change]).await.unwrap();
        let [state] = fx.core.watch_state().await.unwrap().try_into().unwrap();
        assert_eq!((state.mode, state.needs_choice), (WatchMode::Selected, false));
        assert_eq!((state.watches[0].watch.container.external_id.as_str(), state.watches[0].name.as_str(), state.watches[0].watch.source), ("acme/r2", "r2", WatchSource::Footprint));
        let set = fx.core.with_code_db("github:ann", |db| db.watch_set("github:ann")).unwrap();
        assert!(set.is_watched("acme/r2") && !set.is_watched("acme/r3"));
    }

    #[tokio::test]
    async fn the_catalog_marks_watched_repositories_and_suggestions_are_kept_for_a_while() {
        let fx = fixture(&many(13)).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        fx.core.watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        fx.core.watch_set_containers("github:ann", &[WatchChange { container_id: "acme/r1".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        let page = fx.core.watch_catalog("github:ann", "", None).await.unwrap();
        assert!(!page.offline);
        assert_eq!(page.containers.iter().filter(|c| c.watched).map(|c| c.summary.key.as_str()).collect::<Vec<_>>(), ["acme/r1"]);

        fx.core.watch_suggestions("github:ann", false).await.unwrap();
        let calls = || fx.server.targets().iter().filter(|t| t.starts_with("/search/issues")).count();
        let first = calls();
        assert!(first > 0);
        fx.core.watch_suggestions("github:ann", false).await.unwrap();
        assert_eq!(calls(), first, "answered from the stored result");
        fx.core.watch_suggestions("github:ann", true).await.unwrap();
        assert!(calls() > first);
        assert!(fx.core.watch_unwatched_assigned("github:ann", true).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn disconnecting_forgets_the_token_and_deletes_the_cache() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        fx.core.watch_state().await.unwrap();
        let file = fx.dir.join(db_file("ann"));
        assert!(file.exists());
        fx.core.github_disconnect("github:ann").await.unwrap();
        assert!(fx.store.logins().unwrap().is_empty());
        assert!(!file.exists());
        assert!(fx.core.connections().await.unwrap().is_empty());
        assert!(fx.core.registry.connection("github:ann").is_none());
        assert!(matches!(fx.core.watch_set_mode("github:ann", WatchMode::Everything).await, Err(Error::NotSignedIn)));
    }

    #[tokio::test]
    async fn starting_the_device_flow_without_a_client_id_fails_and_polling_without_starting_does_too() {
        let fx = fixture(REPOS).await;
        assert!(fx.core.github_device_start().await.is_err());
        assert!(fx.core.github_device_poll().await.is_err());
    }

    // ---- sync, links and reads, with a Jira connection that knows the project `CA` ----

    use crate::domain::{EventKind, Subject};
    use crate::inbox::testing::{fixture_with, Fixture};

    const PULLS_OPEN: &str = include_str!("../codehost/github/fixtures/pulls_open.json");
    const PULLS_ALL: &str = include_str!("../codehost/github/fixtures/pulls_all.json");
    const REVIEWS: &str = include_str!("../codehost/github/fixtures/reviews_208.json");
    const RUNS_FAILING: &str = include_str!("../codehost/github/fixtures/check_runs_failing.json");
    const RUNS_PASSING: &str = include_str!("../codehost/github/fixtures/check_runs_passing.json");
    const NOTIFICATIONS: &str = include_str!("../codehost/github/fixtures/notifications.json");
    const ISSUES_KEY: &str = include_str!("../codehost/github/fixtures/search_issues_key.json");
    const BRANCHES: &str = include_str!("../codehost/github/fixtures/branches.json");
    const FILE: &str = include_str!("../codehost/github/fixtures/contents_file.json");
    const CODE: &str = include_str!("../codehost/github/fixtures/search_code.json");
    const NOW: &str = "2026-09-30T12:00:00Z";

    struct Linked {
        fx: Fixture,
        server: Server,
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(NOW).unwrap().with_timezone(&Utc)
    }

    fn pull(number: u64) -> String {
        let all: Vec<serde_json::Value> = serde_json::from_str(PULLS_ALL).unwrap();
        let open: Vec<serde_json::Value> = serde_json::from_str(PULLS_OPEN).unwrap();
        all.into_iter().chain(open).find(|p| p["number"] == number).unwrap().to_string()
    }

    fn repo_routes(repo: &str, list_open: &str, list_all: &str) -> Vec<(String, Vec<Reply>)> {
        let mut routes = vec![(format!("/repos/{repo}/pulls"), vec![Reply::ok(list_open), Reply::ok(list_all)])];
        if repo == "acme/webshop" {
            for n in [208, 205, 201, 150] {
                routes.push((format!("/repos/{repo}/pulls/{n}"), vec![Reply::ok(&pull(n))]));
                routes.push((format!("/repos/{repo}/pulls/{n}/reviews"), vec![Reply::ok(if n == 208 { REVIEWS } else { "[]" })]));
            }
            routes.push((format!("/repos/{repo}/commits/aaa1111/check-runs"), vec![Reply::ok(RUNS_FAILING)]));
            routes.push((format!("/repos/{repo}/commits/ccc3333/check-runs"), vec![Reply::ok(RUNS_PASSING)]));
        }
        routes
    }

    async fn linked(extra: Vec<(String, Vec<Reply>)>, scopes: Option<&str>) -> Linked {
        let repos = "[{\"full_name\":\"acme/webshop\",\"name\":\"webshop\",\"pushed_at\":\"2026-09-29T10:00:00Z\"},{\"full_name\":\"acme/gateway\",\"name\":\"gateway\",\"pushed_at\":\"2026-09-20T10:00:00Z\"}]";
        let user = match scopes {
            Some(s) => Reply::ok(USER).header("x-oauth-scopes", s),
            None => Reply::ok(USER),
        };
        let mut routes: Vec<(String, Vec<Reply>)> = vec![("/user".into(), vec![user]), ("/user/repos".into(), vec![Reply::ok(repos)])];
        routes.extend(repo_routes("acme/webshop", PULLS_OPEN, PULLS_ALL));
        routes.extend(repo_routes("acme/gateway", "[]", "[]"));
        routes.extend(extra);
        // Later entries win for a repeated target, so callers can override any default.
        routes.reverse();
        let server = serve(routes.iter().map(|(t, r)| (t.as_str(), r.clone())).collect()).await;
        let store = Arc::new(MemoryStore::default());
        let http = reqwest::Client::new();
        let (base, factory_http) = (server.base.clone(), http.clone());
        let auth = GithubAuth::for_test(http, store, &server.base, None, vec![]);
        let code = CodeService::with_factory(auth, Box::new(move |s, db| Arc::new(GithubHost::new(factory_http.clone(), &base, &s.token, &Connection::github_id(&s.login), &s.login, db))));
        let fx = fixture_with(Some(code)).await;
        fx.core.github_connect_token("ghp_x").await.unwrap();
        Linked { fx, server }
    }

    impl Linked {
        fn core(&self) -> &Core {
            &self.fx.core
        }

        fn requests_to(&self, part: &str) -> usize {
            self.server.targets().iter().filter(|t| t.contains(part)).count()
        }

        /// Requests to exactly this path, query aside.
        fn requests_for(&self, path: &str) -> usize {
            self.server.targets().iter().filter(|t| t.split('?').next() == Some(path)).count()
        }

        async fn sync(&self) -> CodeSynced {
            self.core().sync_code_at("github:ann", now()).await.unwrap()
        }

        fn events(&self) -> Vec<Event> {
            self.core().code_events(100).unwrap()
        }
    }

    #[tokio::test]
    async fn a_sync_stores_pull_requests_in_full_and_links_them_to_the_tickets_their_branch_or_title_names() {
        let lx = linked(vec![], Some("repo")).await;
        let synced = lx.sync().await;
        assert!(synced.changed && synced.links_changed);

        let ca208 = lx.fx.item("CA-208");
        let links = lx.core().dev_links(&ca208).unwrap();
        assert_eq!(links.len(), 1);
        let pr = &links[0].change;
        assert_eq!((pr.number, pr.state, pr.checks, pr.review), (Some(208), CodeChangeState::Draft, CheckState::Failing, crate::domain::ReviewState::ChangesRequested));
        assert_eq!((pr.additions, pr.changed_files), (None, None), "the fixture's detail has no stats; the list values stand");
        assert_eq!((links[0].provenance, pr.linked_keys.clone()), (crate::domain::LinkSource::Branch, vec!["CA-208".to_string()]));

        let merged = lx.core().dev_links(&lx.fx.item("CA-190")).unwrap();
        assert_eq!((merged.len(), merged[0].change.state, merged[0].provenance), (1, CodeChangeState::Merged, crate::domain::LinkSource::Branch));
        assert!(lx.core().dev_links(&lx.fx.item("DEVOPS-471")).unwrap().is_empty(), "DEVOPS isn't a project this workspace has");
        assert_eq!(lx.core().with_code_db("github:ann", |db| Ok(db.code_changes("github:ann")?.len())).unwrap(), 4, "the pull request from March is outside the window");
        assert!(lx.core().connections().await.unwrap().iter().any(|c| c.id == "github:ann" && c.last_sync_at.is_some()));
    }

    #[tokio::test]
    async fn a_sync_writes_the_events_the_activity_feed_will_show_once_each() {
        let lx = linked(vec![], Some("repo")).await;
        lx.sync().await;
        let events = lx.events();
        let summary = |k: EventKind| events.iter().filter(|e| e.kind == k).count();
        assert_eq!((summary(EventKind::PrOpened), summary(EventKind::PrMerged), summary(EventKind::PrClosed)), (3, 1, 1), "the pull request from June is older than the window");
        assert_eq!(summary(EventKind::ReviewSubmitted), 3, "reviews of the person's own pull request");
        assert_eq!(summary(EventKind::CheckFailed), 1);
        assert!(events.iter().any(|e| e.subject == Subject::CodeChange { repo: "acme/webshop".into(), number: 208 }));
        assert!(events.iter().all(|e| e.connection_id == "github:ann"));
        let before = events.len();
        lx.sync().await;
        assert_eq!(lx.events().len(), before, "the same things are not stored again");
    }

    #[tokio::test]
    async fn a_second_sync_sends_conditional_requests_and_reads_only_what_may_have_changed() {
        let lx = linked(vec![], Some("repo")).await;
        lx.sync().await;
        let detail_reads = || lx.requests_for("/repos/acme/webshop/pulls/205") + lx.requests_for("/repos/acme/webshop/pulls/201");
        let first = detail_reads();
        let second = lx.sync().await;
        assert!(!second.changed && !second.links_changed);
        assert_eq!(detail_reads(), first, "closed pull requests that didn't change are not read again");
        assert!(lx.requests_for("/repos/acme/webshop/pulls/208") > 1, "the person's own open pull request is looked at again for its checks");
        assert!(lx.requests_for("/repos/acme/webshop/pulls/150") == 1, "someone else's open pull request with finished checks is not");
    }

    #[tokio::test]
    async fn only_watched_repositories_are_ever_fetched() {
        let lx = linked(vec![], Some("repo")).await;
        lx.core().watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "acme/gateway".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        lx.sync().await;
        assert_eq!(lx.requests_to("/repos/acme/webshop"), 0, "unwatched");
        assert!(lx.requests_to("/repos/acme/gateway/pulls") > 0);
        assert_eq!(lx.core().watched_repos("github:ann").unwrap(), ["acme/gateway"]);

        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "acme/webshop".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        lx.sync().await;
        assert!(lx.requests_to("/repos/acme/webshop/pulls") > 0);
        assert_eq!(lx.core().dev_links(&lx.fx.item("CA-208")).unwrap().len(), 1);
        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "acme/webshop".into(), watched: Some(false), ..Default::default() }]).await.unwrap();
        assert!(lx.core().dev_links(&lx.fx.item("CA-208")).unwrap().is_empty(), "unwatching hides what was cached at once");
    }

    #[tokio::test]
    async fn a_watch_typed_with_other_capitals_still_shows_the_links_of_that_repository() {
        let lx = linked(vec![], Some("repo")).await;
        lx.sync().await;
        lx.core().watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "ACME/WEBSHOP".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        assert_eq!(lx.core().dev_links(&lx.fx.item("CA-208")).unwrap().len(), 1);
        assert!(lx.core().code_file("github:ann", "Acme/Webshop", "src/main.rs", None).await.is_err(), "allowed, then a plain not-found from the scripted server");
        assert!(!matches!(lx.core().code_file("github:ann", "Acme/Webshop", "src/main.rs", None).await, Err(Error::CodeHost { status: 403, .. })));
    }

    #[tokio::test]
    async fn a_failed_live_search_still_returns_what_is_cached() {
        let lx = linked(vec![("/search/issues".into(), vec![Reply::status(500, "{}")]), ("/search/commits".into(), vec![Reply::status(500, "{}")])], Some("repo")).await;
        lx.sync().await;
        let (links, changed) = lx.core().dev_links_live(&lx.fx.item("CA-208")).await.unwrap();
        assert_eq!((links.len(), changed.len()), (1, 0));
    }

    #[tokio::test]
    async fn a_catalog_nobody_has_chosen_from_syncs_nothing() {
        let lx = linked(vec![("/user/repos".into(), vec![Reply::ok(&many(13))])], Some("repo")).await;
        lx.sync().await;
        assert_eq!(lx.requests_to("/pulls"), 0);
        assert!(lx.core().watched_repos("github:ann").unwrap().is_empty());
        lx.core().watch_set_mode("github:ann", WatchMode::Everything).await.unwrap();
        assert_eq!(lx.core().watched_repos("github:ann").unwrap().len(), 13);
    }

    #[tokio::test]
    async fn a_rate_limit_stops_the_sync_with_a_friendly_error_and_holds_the_schedule_off() {
        let limited = Reply::status(403, "{\"message\":\"API rate limit exceeded\"}").header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "4102444800");
        let lx = linked(vec![("/repos/acme/webshop/pulls".into(), vec![limited])], Some("repo")).await;
        let err = lx.core().sync_code_at("github:ann", now()).await.err().expect("limited");
        assert!(matches!(err, Error::RateLimited { .. }) && err.to_string().contains("limiting requests"), "{err}");
        let results = lx.core().sync_code_if_due(Trigger::Now).await;
        assert!(matches!(results[0].1, Err(Error::RateLimited { .. })));
        assert!(lx.core().connections().await.unwrap().iter().any(|c| c.id == "github:ann" && c.error.as_deref().is_some_and(|e| e.contains("limit"))));
        assert!(lx.core().sync_code_if_due(Trigger::Timer).await.is_empty(), "not due again before the limit resets");
    }

    #[tokio::test]
    async fn an_inaccessible_repository_is_marked_and_does_not_fail_the_sync() {
        let lx = linked(vec![("/repos/acme/gateway/pulls".into(), vec![Reply::status(404, "{}")])], Some("repo")).await;
        lx.core().watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        let changes = ["acme/gateway", "acme/webshop"].map(|r| WatchChange { container_id: r.into(), watched: Some(true), ..Default::default() });
        lx.core().watch_set_containers("github:ann", &changes).await.unwrap();
        lx.sync().await;
        assert_eq!(lx.core().dev_links(&lx.fx.item("CA-208")).unwrap().len(), 1);
        let set = lx.core().with_code_db("github:ann", |db| db.watch_set("github:ann")).unwrap();
        assert!(set.watch("acme/gateway").unwrap().inaccessible);
    }

    #[tokio::test]
    async fn notifications_feed_activity_only_with_the_scope_and_only_for_watched_repositories() {
        let classic = linked(vec![("/notifications".into(), vec![Reply::ok(NOTIFICATIONS).header("last-modified", "Tue, 29 Sep 2026 10:00:00 GMT").header("x-poll-interval", "60")])], Some("notifications, repo")).await;
        classic.sync().await;
        let kinds: Vec<EventKind> = classic.events().into_iter().filter(|e| e.id.starts_with("notif:")).map(|e| e.kind).collect();
        assert_eq!(kinds.len(), 2, "review request and CI, not the chatter or the repository that isn't watched: {kinds:?}");
        assert!(kinds.contains(&EventKind::ReviewRequested) && kinds.contains(&EventKind::CheckFailed));
        classic.sync().await;
        assert_eq!(classic.requests_to("/notifications"), 1, "not asked again inside the poll interval");

        let fine_grained = linked(vec![("/notifications".into(), vec![Reply::ok(NOTIFICATIONS)])], None).await;
        fine_grained.sync().await;
        assert_eq!(fine_grained.requests_to("/notifications"), 0, "a token that doesn't list notification scopes isn't asked");
    }

    #[tokio::test]
    async fn a_live_search_finds_and_caches_what_a_sync_has_not_seen_and_says_what_changed() {
        let lx = linked(
            vec![
                ("/repos/acme/webshop/branches".into(), vec![Reply::ok(BRANCHES)]),
                ("/repos/acme/webshop/pulls".into(), vec![Reply::ok("[]")]),
                ("/repos/acme/webshop/commits/ccc3333".into(), vec![Reply::ok("{\"sha\":\"ccc3333\",\"html_url\":\"u\",\"commit\":{\"message\":\"m\",\"committer\":{\"date\":\"2026-09-26T09:10:00Z\"}},\"author\":{\"login\":\"bob\"}}")]),
                ("/search/issues".into(), vec![Reply::ok(ISSUES_KEY)]),
                ("/search/commits".into(), vec![Reply::ok("{\"items\":[]}")]),
            ],
            Some("repo"),
        )
        .await;
        lx.core().watch_set_mode("github:ann", WatchMode::Everything).await.unwrap();
        assert!(lx.core().dev_links(&lx.fx.item("CA-209")).unwrap().is_empty(), "nothing is cached before a sync or a search");
        let (links, changed) = lx.core().dev_links_live(&lx.fx.item("CA-209")).await.unwrap();
        assert_eq!(changed, ["github:ann"]);
        assert_eq!((links.len(), links[0].change.kind, links[0].provenance), (1, crate::domain::CodeChangeKind::Branch, crate::domain::LinkSource::Branch));
        assert_eq!(lx.core().dev_links(&lx.fx.item("CA-209")).unwrap().len(), 1, "now from the cache");
        let (_, changed_again) = lx.core().dev_links_live(&lx.fx.item("CA-209")).await.unwrap();
        assert!(changed_again.is_empty(), "nothing new the second time");
    }

    #[tokio::test]
    async fn reads_of_files_trees_commits_pull_requests_and_code_are_refused_outside_what_is_watched() {
        let lx = linked(
            vec![
                ("/repos/acme/webshop/contents/src/main.rs".into(), vec![Reply::ok(FILE)]),
                ("/search/code".into(), vec![Reply::ok(CODE)]),
                ("/repos/acme/webshop/pulls/208/files".into(), vec![Reply::ok("[]")]),
                ("/repos/acme/webshop/pulls/208/commits".into(), vec![Reply::ok("[]")]),
            ],
            Some("repo"),
        )
        .await;
        lx.core().watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "acme/webshop".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        let id = "github:ann";
        assert_eq!(lx.core().code_file(id, "acme/webshop", "src/main.rs", None).await.unwrap().size, 39);
        assert!(lx.core().code_pull_request(&CodeRef { connection_id: id.into(), repo: "acme/webshop".into(), number: 208 }).await.is_ok());
        for result in [
            lx.core().code_file(id, "acme/gateway", "README.md", None).await.map(|_| ()),
            lx.core().code_tree(id, "acme/gateway", "", None).await.map(|_| ()),
            lx.core().code_commits(id, &CommitQuery { repo: "acme/gateway".into(), ..Default::default() }).await.map(|_| ()),
            lx.core().code_pull_request(&CodeRef { connection_id: id.into(), repo: "acme/gateway".into(), number: 1 }).await.map(|_| ()),
            lx.core().code_search_code(id, "x", Some(&["acme/gateway".to_string()])).await.map(|_| ()),
        ] {
            let err = result.unwrap_err();
            assert!(matches!(err, Error::CodeHost { status: 403, .. }) && err.to_string().contains("isn't one of the repositories you watch"), "{err}");
        }
        assert_eq!(lx.requests_to("/repos/acme/gateway/contents") + lx.requests_to("/repos/acme/gateway/commits"), 0, "refused before anything was sent");
        let hits = lx.core().code_search_code(id, "checkout", None).await.unwrap();
        assert_eq!(hits.len(), 2);
        let searched = &lx.server.targets().into_iter().find(|t| t.starts_with("/search/code")).unwrap();
        assert!(searched.contains("repo%3Aacme%2Fwebshop") && !searched.contains("gateway"), "{searched}");
    }
}
