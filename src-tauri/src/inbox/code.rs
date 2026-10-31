//! Core's code host service: GitHub connections, each with its own database, and the watch set over repositories.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};

use super::watch::{CatalogEntry, CatalogPage, WatchRow, WatchState};
use super::{now_iso, Core};
use crate::auth::Scope;
use crate::config::AppConfig;
use crate::connections::{self, Binding};
use crate::auth::{CredentialSource, GithubAuth, GithubSession};
use crate::codehost::diff::{commentable, relative_path};
use crate::codehost::events::{derive, from_notice, recent};
use crate::codehost::github::{GithubHost, API_BASE};
use crate::codehost::links::{discover, KnownKeys};
use crate::codehost::{CodeHost, PullList};
use crate::db::{stamp, Db};
use crate::domain::{
    clip, Actor, ChangedFile, CheckState, CodeChange, CodeChangeState, CodeFile, CodeHit, CommitQuery, ContainerQuery, ContainerSummary, CreatedBy,
    DevLink, Event, Footprint, Intent, ItemRef, MaybePosted, Origin, Proposal, ProposalState, PullRequestDetail, ReviewComment, TreeEntry, WatchChange,
    WatchMode, WatchSet, WorkstreamEvent, AUTO_EVERYTHING_MAX,
};
use crate::error::{Error, Result};
use crate::proposals::{self, Draft};
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
/// Pull requests whose reviews or checks couldn't be read, one external id per line, read again at the next sync.
const INCOMPLETE: &str = "incomplete_details";
const MIN_POLL_SECS: i64 = 60;
/// Answers not refreshed for this long are dropped from the conditional-request cache.
const HTTP_CACHE_DAYS: i64 = 14;
pub const LAST_SYNC: &str = "last_sync_at";

pub fn is_code_connection(id: &str) -> bool {
    id.starts_with("github:")
}

pub(super) fn github_db_file(login: &str) -> String {
    let safe: String = login.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    format!("github-{safe}.sqlite")
}

type HostFactory = Box<dyn Fn(&GithubSession, Arc<dyn CredentialSource>, Arc<Mutex<Db>>) -> Arc<dyn CodeHost> + Send + Sync>;

/// The GitHub connections, their databases and the hosts that talk to GitHub for them.
pub struct CodeService {
    pub auth: GithubAuth,
    factory: HostFactory,
    sessions: Mutex<HashMap<String, GithubSession>>,
    dbs: Mutex<HashMap<String, Arc<Mutex<Db>>>>,
    hosts: Mutex<HashMap<String, Arc<dyn CodeHost>>>,
    /// The last failed sync per connection, and whether it was transient.
    errors: Mutex<HashMap<String, (String, bool)>>,
    syncing: Mutex<HashSet<String>>,
}

impl CodeService {
    pub fn new(http: reqwest::Client) -> Self {
        let client = http.clone();
        let factory: HostFactory = Box::new(move |s, credentials, db| {
            Arc::new(GithubHost::new(client.clone(), API_BASE, credentials, &Connection::github_id(&s.login), &s.login, db))
        });
        Self::with_factory(GithubAuth::new(http), factory)
    }

    pub fn with_factory(auth: GithubAuth, factory: HostFactory) -> Self {
        Self {
            auth,
            factory,
            sessions: Mutex::new(HashMap::new()),
            dbs: Mutex::new(HashMap::new()),
            hosts: Mutex::new(HashMap::new()),
            errors: Mutex::new(HashMap::new()),
            syncing: Mutex::new(HashSet::new()),
        }
    }

    fn remember(&self, session: GithubSession) -> Connection {
        let connection = session.connection();
        self.hosts.lock().expect("host lock poisoned").remove(&connection.id);
        self.sessions.lock().expect("session lock poisoned").insert(connection.id.clone(), session);
        connection
    }

    pub(super) fn session(&self, id: &str) -> Result<GithubSession> {
        self.sessions.lock().expect("session lock poisoned").get(id).cloned().ok_or(Error::NotSignedIn)
    }

    pub fn connection_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.sessions.lock().expect("session lock poisoned").keys().cloned().collect();
        ids.sort();
        ids
    }
}

/// A connection as Settings shows it.
fn info(session: &GithubSession, last_sync_at: Option<String>, error: Option<(String, bool)>) -> super::ConnectionInfo {
    let (error, transient) = match error {
        Some((message, transient)) => (Some(message), transient),
        None => (None, false),
    };
    super::ConnectionInfo {
        id: session.connection().id,
        instance_id: session.connection().id,
        display_name: session.login.clone(),
        enabled: true,
        kind: ConnectionKind::Github,
        workspace: session.login.clone(),
        url: format!("https://github.com/{}", session.login),
        account: session.name.clone().unwrap_or_else(|| session.login.clone()),
        last_sync_at,
        syncing: false,
        error,
        transient,
        reauth: false,
        status: None,
    }
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

impl Core {
    /// The logins to register at launch: the GitHub instances in `config.json`, or the recorded logins until they are
    /// adopted and whenever the list can't be read.
    fn github_logins(&self) -> Vec<String> {
        let config = AppConfig::load(&self.data_dir);
        if !connections::is_live(&config) {
            return self.code.auth.logins();
        }
        config.connections.iter().filter(|i| i.kind == ConnectionKind::Github).filter_map(|i| i.config.login.clone()).collect()
    }

    /// Registers the GitHub accounts Gossamr is connected to. `gh` is not asked until one is used.
    pub async fn restore_code(&self) {
        for login in self.github_logins() {
            let connection = self.code.remember(GithubSession { login, name: None });
            self.registry.register(connection);
        }
    }

    /// Deletes the token an earlier build saved for `login`, once `gh` is known to hold the login and the connections
    /// are adopted. The login stays in the index, which is what finds the account when `config.json` can't.
    pub(super) fn drop_saved_token(&self, login: &str) {
        if !connections::is_live(&AppConfig::load(&self.data_dir)) {
            return;
        }
        if let Err(e) = self.code.auth.drop_saved_token(login) {
            eprintln!("couldn't remove the GitHub token saved for {login}: {e}");
        }
    }

    fn code_db(&self, id: &str) -> Result<Arc<Mutex<Db>>> {
        let session = self.code.session(id)?;
        let mut dbs = self.code.dbs.lock().expect("db map lock poisoned");
        if let Some(db) = dbs.get(id) {
            return Ok(db.clone());
        }
        let db = Arc::new(Mutex::new(Db::open(&self.data_dir.join(github_db_file(&session.login)))?));
        dbs.insert(id.to_string(), db.clone());
        Ok(db)
    }

    pub(crate) fn with_code_db<T>(&self, id: &str, f: impl FnOnce(&Db) -> Result<T>) -> Result<T> {
        let db = self.code_db(id)?;
        let guard = db.lock().expect("db lock poisoned");
        f(&guard)
    }

    /// The host for a connection. It asks `gh` for a token with every request.
    pub(super) async fn code_host(&self, id: &str) -> Result<Arc<dyn CodeHost>> {
        if let Some(h) = self.code.hosts.lock().expect("host lock poisoned").get(id) {
            return Ok(h.clone());
        }
        let session = self.code.session(id)?;
        let credentials = self.code.auth.credentials(&session.login);
        let host = (self.code.factory)(&session, credentials, self.code_db(id)?);
        self.code.hosts.lock().expect("host lock poisoned").insert(id.to_string(), host.clone());
        Ok(host)
    }

    /// Records the account where the next launch finds it: `config.json` when its connections are live, and the index
    /// either way, since it is all that remains while they are not.
    fn keep_account(&self, login: &str) -> Result<()> {
        let recorded = self.code.auth.record_login(login);
        if !connections::is_live(&AppConfig::load(&self.data_dir)) {
            return recorded;
        }
        if let Err(e) = recorded {
            eprintln!("couldn't record the GitHub login {login}: {e}");
        }
        self.try_bind_instance(Binding::github(login))
    }

    async fn connected(&self, session: GithubSession) -> Result<super::ConnectionInfo> {
        self.keep_account(&session.login)?;
        let connection = self.code.remember(session.clone());
        self.probes_rebound();
        self.drop_saved_token(&session.login);
        self.probe_bound_now(&connection.id).await;
        self.registry.register(connection.clone());
        // So the catalog is known before the first sync, which a search of the watched repositories depends on.
        let _ = self.probe_code_catalog(&connection.id).await;
        self.wake.notify_one();
        let mut connected = info(&session, None, None);
        self.name_instances(std::slice::from_mut(&mut connected));
        Ok(connected)
    }

    /// Connects the account `gh` holds for `login`, or its active account with none named.
    pub async fn github_connect(&self, login: Option<&str>) -> Result<super::ConnectionInfo> {
        let session = self.code.auth.connect(login).await?;
        self.connected(session).await
    }

    /// Forgets the account: its place in the index and any token an earlier build saved leave the Keychain, and its
    /// cached data is deleted. `gh` keeps its login.
    pub async fn github_disconnect(&self, connection_id: &str) -> Result<()> {
        let session = self.code.session(connection_id)?;
        self.code.auth.forget_login(&session.login)?;
        self.code.sessions.lock().expect("session lock poisoned").remove(connection_id);
        self.code.hosts.lock().expect("host lock poisoned").remove(connection_id);
        self.code.dbs.lock().expect("db map lock poisoned").remove(connection_id);
        self.registry.remove(connection_id);
        self.unbind_instance(connection_id);
        let path = self.data_dir.join(github_db_file(&session.login));
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
                db.set_watch_mode_if_unset(id, WatchMode::Everything, &now_iso())?;
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
                Ok(WatchState { connection_id: id.clone(), chosen: set.mode == WatchMode::Selected, needs_choice, catalog_size: size, watches })
            })?);
        }
        Ok(out)
    }

    #[cfg(test)]
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
        if self.off_name(id).is_some() {
            return Ok(Vec::new());
        }
        self.chosen_repos(id)
    }

    /// Like `watched_repos`, and still the answer while the connection is off: a sync and the links read it so that the
    /// cache stays whole until the connection is on again.
    fn chosen_repos(&self, id: &str) -> Result<Vec<String>> {
        self.with_code_db(id, |db| {
            let set = db.watch_set(id)?;
            let catalog = || -> Result<Vec<String>> { Ok(db.catalog_search(id, "", usize::MAX >> 1)?.into_iter().filter(|c| !c.archived).map(|c| c.container_ref.external_id).collect()) };
            let size: Option<usize> = db.meta(CATALOG_SIZE)?.and_then(|s| s.parse().ok());
            Ok(match set.mode {
                WatchMode::Selected => set.watches.iter().filter(|w| !w.inaccessible).map(|w| w.container.external_id.clone()).collect(),
                WatchMode::Everything => catalog()?,
                WatchMode::Unset if size.is_some_and(|n| n <= AUTO_EVERYTHING_MAX) => catalog()?,
                WatchMode::Unset => Vec::new(),
            })
        })
    }

    pub(super) fn require_watched(&self, id: &str, repo: &str) -> Result<()> {
        if let Some(name) = self.off_name(id) {
            return Err(Error::CodeHost { status: 403, message: format!("{name} is off, so {repo} isn't read.") });
        }
        if is_watched_repo(&self.watched_repos(id)?, repo) {
            Ok(())
        } else {
            Err(refused(repo))
        }
    }

    /// The project keys of the signed-in tracker, which are what a key in a branch or title may name.
    async fn known_keys(&self) -> KnownKeys {
        let Some((scope, _, _)) = self.auth.identity().await else { return KnownKeys::default() };
        let connection = scope.connection_id;
        let keys = self.with_db(|db| db.project_keys(&connection)).await.unwrap_or_default();
        KnownKeys::new(keys.iter().map(|k| (k.as_str(), connection.as_str())))
    }

    /// Rebuilds the links of a connection from its cached changes. Returns whether they changed.
    fn rediscover(&self, id: &str, known: &KnownKeys) -> Result<bool> {
        let repos = self.chosen_repos(id)?;
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
        let (previous, owed): (HashMap<String, CodeChange>, HashSet<String>) = self.with_code_db(id, |db| {
            let previous = db.code_changes(id)?.into_iter().filter(|c| c.repo == repo).map(|c| (c.external_id.clone(), c)).collect();
            let owed = db.meta(INCOMPLETE)?.unwrap_or_default().lines().map(str::to_string).collect();
            Ok((previous, owed))
        })?;
        let mut owed_after = owed.clone();
        let mut stored = Vec::new();
        let mut events: Vec<Event> = Vec::new();
        for listed in listed {
            let prev = previous.get(&listed.external_id);
            let open = matches!(listed.state, CodeChangeState::Open | CodeChangeState::Draft);
            let stale = prev.is_none_or(|p| p.updated_at != listed.updated_at || p.sha != listed.sha);
            // Checks finish without the pull request changing, so the person's own and unfinished ones are looked at again.
            let recheck = open && prev.is_some_and(|p| me_of(p, me) || p.checks == CheckState::Pending);
            let key = listed.external_id.clone();
            let carried = |listed: CodeChange| match prev {
                Some(p) => CodeChange {
                    checks: if p.sha == listed.sha { p.checks } else { CheckState::None },
                    review: p.review,
                    additions: p.additions,
                    deletions: p.deletions,
                    changed_files: p.changed_files,
                    linked_keys: p.linked_keys.clone(),
                    ..listed
                },
                None => listed,
            };
            let (now, reviews) = if stale || recheck || owed.contains(&key) {
                match host.refresh_pull_request(&listed, open).await {
                    Ok(read) => {
                        if read.incomplete {
                            owed_after.insert(key);
                        } else {
                            owed_after.remove(&key);
                        }
                        (read.change, read.reviews)
                    }
                    Err(e) if e.is_transient() => {
                        owed_after.insert(key);
                        (carried(listed), Vec::new())
                    }
                    Err(e) => return Err(e),
                }
            } else {
                (carried(listed), Vec::new())
            };
            events.extend(recent(derive(me, prev, &now, &reviews), since));
            if prev != Some(&now) {
                stored.push(now);
            }
        }
        let changed = !stored.is_empty();
        self.with_code_db(id, |db| {
            db.upsert_code_changes(&stored, &stamp(Utc::now()))?;
            if owed_after != owed {
                db.set_meta(INCOMPLETE, &owed_after.iter().cloned().collect::<Vec<_>>().join("\n"))?;
            }
            Ok(db.insert_cache_events(&events)? > 0 || changed)
        })
    }

    /// Reads the notification threads aimed at the person, when the token may and GitHub's poll interval allows.
    async fn sync_notifications(&self, host: &dyn CodeHost, id: &str, repos: &[String]) -> Result<bool> {
        let due = self.with_code_db(id, |db| Ok(db.meta(NOTIFICATIONS_NEXT)?.and_then(|s| parse_time(&s)).is_none_or(|at| Utc::now() >= at)))?;
        if !due {
            return Ok(false);
        }
        // A token that can't be read at all just doesn't feed Activity with notifications.
        match host.me().await {
            Ok(me) if me.can_read_notifications() => {}
            Ok(_) | Err(Error::CodeHost { .. }) => return Ok(false),
            Err(e) => return Err(e),
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
        let repos = self.chosen_repos(id)?;
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

    /// Asks the sync loop for a code sync now, as the Sync button does: a build that just pushed a branch has its pull
    /// request found sooner than at the next interval.
    pub fn request_code_sync(&self) {
        self.wake.notify_one();
    }

    /// Syncs each GitHub connection that is due. Each has its own schedule, so one that is rate limited waits alone.
    pub async fn sync_code_if_due(&self, trigger: Trigger) -> Vec<(String, Result<CodeSynced>)> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            if self.off_name(&id).is_some() {
                continue;
            }
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
            let error = result.as_ref().err().map(|e| (e.to_string(), e.is_transient()));
            match error {
                Some(e) => self.code.errors.lock().expect("error lock poisoned").insert(id.clone(), e),
                None => self.code.errors.lock().expect("error lock poisoned").remove(&id),
            };
            out.push((id, result));
        }
        out
    }

    /// Pull request and notification events across the GitHub connections, newest first.
    #[cfg(test)]
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
            if self.off_name(&id).is_some() {
                continue;
            }
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

    /// The pull request as GitHub has it now, in a watched repository.
    pub async fn code_pull_change(&self, repo: &str, number: u64) -> Result<CodeChange> {
        let (id, repo) = self.chosen_connection_for(repo)?;
        self.code_host(&id).await?.pull_request_change(&repo, number).await
    }

    /// The connection that watches `repo` (compared without regard to case) and the repository as it is spelled there.
    /// A repository of a connection that is off is refused as off, not as unwatched.
    pub fn code_connection_for(&self, repo: &str) -> Result<(String, String)> {
        for id in self.code.connection_ids() {
            if let Some(found) = self
                .watched_repos(&id)?
                .into_iter()
                .find(|r| r.eq_ignore_ascii_case(repo))
            {
                return Ok((id, found));
            }
        }
        match self.off_code_name(Some(repo))? {
            Some(name) => Err(Error::CodeHost { status: 403, message: format!("{name} is off, so {repo} isn't read.") }),
            None => Err(refused(repo)),
        }
    }

    /// Like `code_connection_for`, and still the answer while the connection is off: a run already approved keeps its
    /// way to GitHub, since it works in a local clone.
    pub(crate) fn chosen_connection_for(&self, repo: &str) -> Result<(String, String)> {
        for id in self.code.connection_ids() {
            if let Some(found) = self.chosen_repos(&id)?.into_iter().find(|r| r.eq_ignore_ascii_case(repo)) {
                return Ok((id, found));
            }
        }
        Err(refused(repo))
    }

    /// The name of a GitHub connection that is off: the one that follows `repo` when one is given, else any.
    pub fn off_code_name(&self, repo: Option<&str>) -> Result<Option<String>> {
        for id in self.code.connection_ids() {
            let Some(name) = self.off_name(&id) else { continue };
            if repo.is_none_or(|repo| self.chosen_repos(&id).is_ok_and(|repos| is_watched_repo(&repos, repo))) {
                return Ok(Some(name));
            }
        }
        Ok(None)
    }

    /// Every watched repository with the connection that watches it.
    pub fn watched_code_repos(&self) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            out.extend(
                self.watched_repos(&id)?
                    .into_iter()
                    .map(|r| (id.clone(), r)),
            );
        }
        Ok(out)
    }

    /// Every repository chosen, off connections included, for the checks that run at launch.
    pub(crate) fn chosen_code_repos(&self) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for id in self.code.connection_ids() {
            out.extend(self.chosen_repos(&id)?);
        }
        Ok(out)
    }

    /// The watched repositories of every connection as owner/name, once each (names are not case sensitive), sorted.
    pub fn watched_repo_names(&self) -> Result<Vec<String>> {
        let mut names: Vec<String> = self.watched_code_repos()?.into_iter().map(|(_, r)| r).collect();
        names.sort_by_cached_key(|r| (r.to_ascii_lowercase(), r.clone()));
        names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        Ok(names)
    }

    /// Open pull requests of a watched repository and those updated in the last month, newest first. A pull request a
    /// sync has already read in full comes with its review outcome and checks.
    pub async fn code_pull_requests(
        &self,
        connection_id: &str,
        repo: &str,
    ) -> Result<Vec<CodeChange>> {
        self.require_watched(connection_id, repo)?;
        let listed = self
            .code_host(connection_id)
            .await?
            .pull_requests(repo, Utc::now() - Duration::days(PR_WINDOW_DAYS))
            .await?
            .changes;
        self.with_code_db(connection_id, |db| {
            Ok(listed
                .into_iter()
                .map(|c| match db.code_change(connection_id, &c.external_id) {
                    Ok(Some(full)) if full.updated_at == c.updated_at && full.sha == c.sha => full,
                    _ => c,
                })
                .collect())
        })
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

pub const REVIEW_OUTDATED_NOTE: &str =
    "GitHub says this review's lines no longer match the pull request; it is outdated. Discard it or edit the comments and try again.";
/// The error a review draft keeps when a post may have reached GitHub though no answer said so. The draft keeps that
/// post as `maybe_posted`, and its next post looks for it on GitHub first.
pub const REVIEW_MAYBE_POSTED_NOTE: &str = "GitHub may have posted this review already; Gossamr checks the pull request before sending it again.";
/// Why a review that may be on GitHub already isn't sent again: Gossamr looked and didn't find it, which doesn't prove it
/// isn't there. Only the person's choice to post anyway sends it.
pub const REVIEW_NOT_FOUND_NOTE: &str =
    "Gossamr looked on the pull request and didn't find the review it may have posted. Check the pull request; if the review isn't there, choose Post anyway to send it.";
/// Why a post of a review draft that changed since the person looked at it is refused.
pub const REVIEW_CHANGED: &str = "this review changed since you looked at it; read it again before posting";

fn outcome_unknown(e: &Error) -> bool {
    match e {
        Error::Http(e) => !e.is_connect() && !e.is_builder(),
        Error::Json(_) => true,
        Error::CodeHost { status, .. } => (500..600).contains(status),
        _ => false,
    }
}

#[derive(Clone, Debug)]
pub struct GithubReviewDraft {
    pub run_id: String,
    pub repo: String,
    pub number: u64,
    pub reviewed_sha: String,
    pub summary: String,
    pub comments: Vec<ReviewComment>,
}

impl Core {
    pub async fn draft_review(&self, scope: &Scope, origin: Origin, input: GithubReviewDraft) -> Result<Proposal> {
        let GithubReviewDraft { run_id, repo, number, reviewed_sha, mut summary, comments } = input;
        if !(7..=40).contains(&reviewed_sha.len()) || !reviewed_sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::Proposal("a review needs reviewed_sha as 7 to 40 hex characters".into()));
        }
        let run = self.with_app_db_for(scope, |db| db.run(&run_id)).await?
            .ok_or_else(|| Error::Proposal("the reviewer run no longer exists".into()))?;
        if !run.spec.repo.eq_ignore_ascii_case(&repo) || run.spec.pr != Some(number) {
            return Err(Error::Proposal("the reviewer run must belong to this pull request".into()));
        }
        if origin.workstream().is_some_and(|workstream| run.spec.workstream.as_deref() != Some(workstream)) {
            return Err(Error::Proposal("the reviewer run belongs to another workstream".into()));
        }
        if run.spec.pr_sha.as_deref() != Some(reviewed_sha.as_str()) {
            return Err(Error::Proposal("reviewed_sha must match the reviewer's pinned commit".into()));
        }
        let (connection_id, repo) = self.code_connection_for(&repo)?;
        let files = self.diff_at(&connection_id, &repo, number, &reviewed_sha).await?;
        let supplied = comments.len();
        let mut inline = Vec::new();
        let mut positions = HashSet::new();
        for comment in comments {
            let fits = relative_path(&comment.path)
                && files.iter().any(|file| file.path == comment.path && file.patch.as_deref().is_some_and(|patch| commentable(patch, comment.line, comment.side)));
            if fits && inline.len() < proposals::REVIEW_COMMENTS_MAX && positions.insert((comment.path.clone(), comment.line, comment.side)) {
                inline.push(comment);
            } else {
                let side = match comment.side { crate::domain::DiffSide::Left => "LEFT", crate::domain::DiffSide::Right => "RIGHT" };
                summary.push_str(&format!("\n\n{}:{} ({side}): {}", comment.path, comment.line, comment.body));
            }
        }
        let moved = supplied - inline.len();
        if moved > 0 && summary.chars().count() > proposals::REVIEW_SUMMARY_LIMIT {
            return Err(Error::Proposal(format!("Moving {moved} inline comments into the summary would exceed its {} character limit. Shorten the summary or the comments and draft again; no content was discarded.", proposals::REVIEW_SUMMARY_LIMIT)));
        }
        let intent = Intent::GithubReview { connection_id, item: run.item, run_id, repo, number, commit_sha: reviewed_sha, summary, comments: inline };
        self.propose(scope, Draft { origin, created_by: CreatedBy::Pip, intent, label: None, basis: None }).await
    }
}

impl Core {
    /// The files of pull request `number` as its diff shows them at `commit_sha`, the commit a review is posted against,
    /// whose diff is the one GitHub places the review's lines on. Only the head's diff is read, so once the head has moved
    /// on from `commit_sha` this refuses rather than offer lines of a diff the review won't be posted on.
    async fn diff_at(&self, connection_id: &str, repo: &str, number: u64, commit_sha: &str) -> Result<Vec<ChangedFile>> {
        let host = self.code_host(connection_id).await?;
        let head = host.pull_request_change(repo, number).await?.sha;
        if head.as_deref() != Some(commit_sha) {
            return Err(Error::Proposal(format!("the pull request has moved on from {} since the review read it", clip(commit_sha, 8))));
        }
        let files = host.pull_files(repo, number).await?;
        if host.pull_request_change(repo, number).await?.sha.as_deref() != Some(commit_sha) {
            return Err(Error::Proposal("the pull request moved while its diff was being read; try again".into()));
        }
        Ok(files)
    }
}

impl Core {
    /// Posts the pending review draft `id` to GitHub as one comment review, on the person's approval: the only path by
    /// which anything is written to GitHub. `seen` is how many revisions the draft had when the person looked at it: one
    /// revised since (by Pip, say) is refused, so only what they read is posted. The draft is claimed first, so it is
    /// posted at most once. It never goes through the tracker. A refusal leaves it pending with the reason as its error;
    /// GitHub saying its lines no longer match marks it outdated (`REVIEW_OUTDATED_NOTE`).
    ///
    /// A post whose outcome isn't known (a failure in transit, a 5xx, an answer that doesn't read, or Gossamr closing
    /// while it was out) stays on the draft as `maybe_posted`, which edits and revisions leave alone. While it is set,
    /// posting sends nothing: it looks on GitHub for that post (the commit and summary it was sent with) and records it as
    /// posted when found; when not found, or when GitHub can't be asked, the draft stays pending and says so
    /// (`REVIEW_NOT_FOUND_NOTE`). Only `post_anyway`, the person's explicit choice, then sends it again.
    pub async fn post_review_draft(&self, id: &str, seen: usize, post_anyway: bool) -> Result<Proposal> {
        let scope = self.scope().await?;
        let gate = self.draft_gate.lock().await;
        let (claimed, look_for) = self
            .with_app_db_for(&scope, |db| {
                let current = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
                if let Intent::GithubReview { connection_id, .. } = &current.intent {
                    self.refuse_while_off(connection_id)?;
                }
                if current.state == ProposalState::Pending && current.revisions.len() != seen {
                    return Err(Error::Proposal(REVIEW_CHANGED.into()));
                }
                let look_for = current.maybe_posted.clone().filter(|_| !post_anyway);
                // What is about to be sent is kept with the claim, so it is looked for should no answer come.
                let sending = match (&look_for, &current.intent) {
                    (None, Intent::GithubReview { commit_sha, summary, .. }) => Some(MaybePosted { at: Utc::now(), commit_sha: commit_sha.clone(), summary: summary.clone(), checked_at: None }),
                    _ => None,
                };
                match db.begin_posting_review(id, Utc::now(), sending)? {
                    Some(p) => Ok((p, look_for)),
                    None => Err(proposals::not_pending(&current)),
                }
            })
            .await?;
        drop(gate);
        let Intent::GithubReview { connection_id, repo, number, commit_sha, summary, comments, .. } = &claimed.intent else {
            unreachable!("only a review draft is claimed for posting")
        };
        let posted = match (self.code_host(connection_id).await, &look_for) {
            // Nothing is sent while it can't be told whether the last attempt went through.
            (Ok(host), Some(sent)) => match host.posted_review(repo, *number, &sent.commit_sha, &sent.summary).await {
                Ok(Some(review)) => Ok(review),
                Ok(None) => Err(Error::Proposal(REVIEW_NOT_FOUND_NOTE.into())),
                Err(e) => Err(Error::Proposal(format!("{REVIEW_MAYBE_POSTED_NOTE} Gossamr couldn't check just now ({e}). Try again, or check the pull request and choose Post anyway."))),
            },
            (Ok(host), None) => host.post_review(repo, *number, commit_sha, summary, comments).await,
            (Err(e), Some(_)) => Err(Error::Proposal(format!("{REVIEW_MAYBE_POSTED_NOTE} Gossamr couldn't check just now ({e}). Try again, or check the pull request and choose Post anyway."))),
            (Err(e), None) => Err(e),
        };
        let label = format!("{repo}#{number}");
        self.with_app_db_for(&scope, |db| {
            let at = Utc::now();
            let mut p = db.proposal(id)?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
            p.updated_at = at;
            match posted {
                Ok(review) => {
                    let detail = format!("{label} review {}", review.id);
                    (p.state, p.error, p.posted, p.maybe_posted) = (ProposalState::Applied, None, Some(review), None);
                    db.save_proposal(&p)?;
                    proposals::record(db, &p, Actor::Person, "draft_approved", at);
                    if let Some(ws) = p.workstream().filter(|ws| db.workstream(ws).ok().flatten().is_some()) {
                        if let Err(e) = db.append_workstream_event(&WorkstreamEvent::new(ws, Actor::Person, "review_posted", at).proposal(&p.id).detail(detail)) {
                            eprintln!("couldn't record the posted review of draft {} in workstream {ws}: {e}", p.id);
                        }
                    }
                }
                // Looked for and not found, or not looked for: it stays maybe posted, now checked, for the person to decide.
                Err(e) if look_for.is_some() => {
                    eprintln!("review draft {id} on {label} may be on GitHub already and wasn't sent again: {e}");
                    let checked = look_for.map(|sent| MaybePosted { checked_at: Some(at), ..sent });
                    (p.state, p.error, p.maybe_posted) = (ProposalState::Pending, Some(e.to_string()), checked);
                    db.save_proposal(&p)?;
                }
                // GitHub refused it, so it isn't there.
                Err(Error::ReviewOutdated(said)) => {
                    eprintln!("GitHub refused review draft {id} on {label} as outdated: {said}");
                    (p.state, p.error, p.maybe_posted) = (ProposalState::Pending, Some(REVIEW_OUTDATED_NOTE.into()), None);
                    db.save_proposal(&p)?;
                }
                // What was sent stays as `maybe_posted`, kept with the claim.
                Err(e) if outcome_unknown(&e) => {
                    eprintln!("posting review draft {id} on {label} may have gone through: {e}");
                    (p.state, p.error) = (ProposalState::Pending, Some(format!("{REVIEW_MAYBE_POSTED_NOTE} ({e})")));
                    db.save_proposal(&p)?;
                }
                Err(e) => {
                    (p.state, p.error, p.maybe_posted) = (ProposalState::Pending, Some(e.to_string()), None);
                    db.save_proposal(&p)?;
                }
            }
            Ok(p)
        })
        .await
    }

    /// Whether the token of `connection_id` may post a review on `repo`, which must be watched.
    pub async fn code_review_access(&self, connection_id: &str, repo: &str) -> Result<crate::codehost::ReviewAccess> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.review_access(repo).await
    }

    /// The files of pull request `number` with patches long enough for a review's comments, in a watched repository.
    pub async fn code_pull_files(&self, connection_id: &str, repo: &str, number: u64) -> Result<Vec<ChangedFile>> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.pull_files(repo, number).await
    }

    /// The reviews and inline comments already on pull request `number` in a watched repository. Reads only.
    pub async fn code_review_comments(&self, connection_id: &str, repo: &str, number: u64) -> Result<crate::codehost::ReviewComments> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.review_comments(repo, number).await
    }

    /// Pip's revision of review draft `id`: `summary` when given, and `comments` as its complete new list (any left out
    /// are dropped). The same rule as for any revision applies (`proposals::require_pip_may_revise`): a draft the
    /// person edited stays theirs, and one of a workstream only changes from that workstream's conversation. A comment
    /// at a position the draft already had keeps it; one at a new position must sit on a line the pull request's diff
    /// shows at the reviewed commit, so none can be added once the head has moved on. Nothing is posted: the revision is still a draft for the person to approve.
    pub async fn revise_review_as_pip(&self, scope: &Scope, workstream: Option<&str>, id: &str, summary: Option<String>, comments: Vec<ReviewComment>) -> Result<Proposal> {
        let current = self.proposal_in(scope, id).await?.ok_or_else(|| Error::Proposal("that draft no longer exists".into()))?;
        proposals::require_pip_may_revise(&current, workstream)?;
        let Intent::GithubReview { connection_id, item, run_id, repo, number, commit_sha, summary: was, comments: had } = &current.intent else {
            return Err(Error::Proposal("that draft isn't a GitHub review".into()));
        };
        let at = |c: &ReviewComment| (c.path.clone(), c.line, c.side);
        let new: Vec<&ReviewComment> = comments.iter().filter(|c| !had.iter().any(|h| at(h) == at(c))).collect();
        if !new.is_empty() {
            self.require_watched(connection_id, repo)?;
            let files = self
                .diff_at(connection_id, repo, *number, commit_sha)
                .await
                .map_err(|e| Error::Proposal(format!("couldn't read the pull request's diff at the reviewed commit to place the new comments ({e}); reword or drop the comments it has instead, or try again later")))?;
            if let Some(c) = new.iter().find(|c| !files.iter().any(|f| f.path == c.path && f.patch.as_deref().is_some_and(|p| commentable(p, c.line, c.side)))) {
                return Err(Error::Proposal(format!("{}:{} isn't a line the pull request's diff shows; call get_proposal to see the lines it has", c.path, c.line)));
            }
        }
        let intent = Intent::GithubReview {
            connection_id: connection_id.clone(),
            item: item.clone(),
            run_id: run_id.clone(),
            repo: repo.clone(),
            number: *number,
            commit_sha: commit_sha.clone(),
            summary: summary.unwrap_or_else(|| was.clone()),
            comments,
        };
        self.revise_as_pip(scope, workstream, id, intent).await
    }

    /// Pull request `number` in a watched repository with the files it changes, for review drafts.
    pub async fn code_pull_diff(&self, connection_id: &str, repo: &str, number: u64) -> Result<crate::codehost::PullDiff> {
        self.require_watched(connection_id, repo)?;
        self.code_host(connection_id).await?.pull_diff(repo, number).await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::auth::{Auth, GithubAuth};
    use crate::codehost::github::testserver::{serve, Reply, Server};
    use crate::domain::WatchSource;
    use crate::tracker::Registry;

    const USER: &str = include_str!("../codehost/github/fixtures/user.json");
    const REPOS: &str = include_str!("../codehost/github/fixtures/repos.json");

    struct Fx {
        core: Core,
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
        let http = reqwest::Client::new();
        let base = server.base.clone();
        let factory_http = http.clone();
        let auth = GithubAuth::for_test(http.clone(), &server.base, crate::auth::fake_gh("ghp_x"));
        let code = CodeService::with_factory(
            auth,
            Box::new(move |s, credentials, db| Arc::new(GithubHost::new(factory_http.clone(), &base, credentials, &Connection::github_id(&s.login), &s.login, db))),
        );
        let registry = Registry::new(|_| unreachable!("no tracker for GitHub"));
        let core = Core::new(Arc::new(Auth::signed_out(http)), registry, dir.clone()).with_code(code);
        Fx { core, server, dir }
    }

    #[tokio::test]
    async fn connecting_through_gh_registers_a_github_connection_and_lists_it() {
        let fx = fixture(REPOS).await;
        let connected = fx.core.github_connect(Some("ann")).await.unwrap();
        assert_eq!((connected.id.as_str(), connected.kind, connected.workspace.as_str(), connected.account.as_str()), ("github:ann", ConnectionKind::Github, "ann", "Ann Example"));
        assert_eq!(fx.core.registry.connection("github:ann").unwrap().kind, ConnectionKind::Github);
        let listed = fx.core.connections().await.unwrap();
        assert_eq!(listed.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["github:ann"]);
        assert_eq!(listed[0].url, "https://github.com/ann");
    }

    #[tokio::test]
    async fn the_accounts_in_config_json_come_back_at_launch_without_asking_gh_and_two_can_coexist() {
        let fx = fixture(REPOS).await;
        fx.core.adopt_instances().await;
        fx.core.bind_instance(Binding::github("ann"));
        fx.core.bind_instance(Binding::github("acme-bot"));
        std::fs::write(fx.core.code.auth.gh_dirs()[0].join("gh"), "#!/bin/sh\nexit 1\n").unwrap();
        let relaunched = Core::new(Arc::new(Auth::signed_out(reqwest::Client::new())), Registry::new(|_| unreachable!("no tracker")), fx.dir.clone())
            .with_code(CodeService::with_factory(GithubAuth::for_test(reqwest::Client::new(), "http://unused.invalid", Vec::new()), Box::new(|_, _, _| unreachable!("no host is built"))));
        relaunched.restore().await;
        let ids: Vec<String> = relaunched.connections().await.unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["github:acme-bot", "github:ann"]);
        assert_ne!(github_db_file("ann"), github_db_file("acme-bot"));
    }

    #[tokio::test]
    async fn before_the_accounts_are_adopted_the_logins_an_earlier_build_saved_come_back_at_launch() {
        let fake = crate::secrets::fake::Fake::default();
        fake.put("github-logins", r#"["ann","acme-bot"]"#);
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fx.core.restore().await;
        let ids: Vec<String> = fx.core.connections().await.unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["github:acme-bot", "github:ann"]);
    }

    fn instance_ids(fx: &Fx) -> Vec<(String, String)> {
        let config = crate::config::AppConfig::load(&fx.dir);
        config.connections.into_iter().map(|i| (i.id, i.bound_to.unwrap_or_default())).collect()
    }

    #[tokio::test]
    async fn existing_github_sign_ins_become_instances_in_the_order_they_were_saved_and_list_under_them() {
        let fake = crate::secrets::fake::Fake::default();
        fake.put("github-logins", r#"["ann","acme-bot"]"#);
        let _vault = crate::secrets::fake::install(&fake);
        let other = fixture(REPOS).await;
        other.core.restore().await;
        other.core.adopt_instances().await;
        assert_eq!(instance_ids(&other), [("github".to_string(), "github:ann".to_string()), ("github_2".to_string(), "github:acme-bot".to_string())]);
        let listed: Vec<_> = other.core.connections().await.unwrap().into_iter().map(|c| (c.id, c.instance_id, c.display_name, c.enabled)).collect();
        assert_eq!(
            listed,
            [
                ("github:acme-bot".into(), "github_2".into(), "GitHub (acme-bot)".into(), true),
                ("github:ann".into(), "github".into(), "GitHub".into(), true)
            ]
        );
    }

    #[tokio::test]
    async fn nothing_is_adopted_while_the_keychain_cant_be_read_and_it_is_adopted_on_a_later_launch() {
        let fake = crate::secrets::fake::Fake::default();
        fake.deny_reads_of("vault");
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        assert!(matches!(fx.core.github_connect(None).await, Err(Error::KeychainUnavailable(_))), "the account would be lost at relaunch");
        fx.core.adopt_instances().await;
        assert_eq!(crate::config::AppConfig::load(&fx.dir).version, 0);
        assert!(instance_ids(&fx).is_empty());

        let readable = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&readable);
        fx.core.github_connect(None).await.unwrap();
        fx.core.adopt_instances().await;
        assert_eq!(instance_ids(&fx), [("github".to_string(), "github:ann".to_string())]);
    }

    #[tokio::test]
    async fn connecting_and_disconnecting_accounts_keeps_the_instances_and_never_reuses_an_id() {
        let fx = fixture(REPOS).await;
        fx.core.adopt_instances().await;
        fx.core.github_connect(None).await.unwrap();
        assert_eq!(instance_ids(&fx), [("github".to_string(), "github:ann".to_string())]);
        fx.core.github_disconnect("github:ann").await.unwrap();
        assert!(instance_ids(&fx).is_empty());
        fx.core.github_connect(None).await.unwrap();
        assert_eq!(instance_ids(&fx), [("github_2".to_string(), "github:ann".to_string())]);
    }

    #[tokio::test]
    async fn connecting_returns_the_instance_the_account_is_listed_under() {
        let fx = fixture(REPOS).await;
        fx.core.adopt_instances().await;
        let connected = fx.core.github_connect(None).await.unwrap();
        assert_eq!((connected.id.as_str(), connected.instance_id.as_str(), connected.display_name.as_str()), ("github:ann", "github", "GitHub"));
        let listed = fx.core.connections().await.unwrap();
        assert_eq!((listed[0].instance_id.as_str(), listed[0].display_name.as_str()), ("github", "GitHub"));
    }

    #[tokio::test]
    async fn a_config_file_that_isnt_json_is_not_replaced_at_launch_and_nothing_is_adopted_from_it() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect(None).await.unwrap();
        std::fs::write(fx.dir.join("config.json"), "{ nope").unwrap();
        fx.core.adopt_instances().await;
        fx.core.adopt_instances().await;
        assert_eq!(std::fs::read_to_string(fx.dir.join("config.json")).unwrap(), "{ nope");
        fx.core.github_connect(None).await.unwrap();
        assert_eq!(std::fs::read_to_string(fx.dir.join("config.json")).unwrap(), "{ nope", "signing in doesn't replace it either");
    }

    #[tokio::test]
    async fn adopting_leaves_config_json_byte_for_byte_once_it_has_run() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect(None).await.unwrap();
        let text = r#"{"version":1,"connections":[],"retiredIds":[],"agents":{"maxRuns":"2"},"futureKey":true}"#;
        std::fs::write(fx.dir.join("config.json"), text).unwrap();
        fx.core.adopt_instances().await;
        assert_eq!(std::fs::read_to_string(fx.dir.join("config.json")).unwrap(), text);
    }

    #[tokio::test]
    async fn nothing_is_adopted_while_the_github_index_cant_be_read_though_the_vault_can() {
        let fake = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        let keychain = GithubAuth::for_test(reqwest::Client::new(), &fx.server.base, vec![]);
        let code = CodeService::with_factory(keychain, Box::new(|_, _, _| unreachable!("no host is built")));
        let core = Core::new(Arc::new(Auth::signed_out(reqwest::Client::new())), Registry::new(|_| unreachable!("no tracker")), fx.dir.clone()).with_code(code);
        fake.deny_reads_of("github-logins");
        core.adopt_instances().await;
        assert_eq!(crate::config::AppConfig::load(&fx.dir).version, 0);
        assert!(instance_ids(&fx).is_empty());
    }

    #[tokio::test]
    async fn nothing_is_adopted_while_the_saved_jira_token_cant_be_read_though_the_vault_can() {
        let fake = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fake.deny_reads_of("jira-token");
        let core = Core::new(Arc::new(Auth::load(reqwest::Client::new())), Registry::new(|_| unreachable!("no tracker")), fx.dir.clone());
        core.adopt_instances().await;
        assert_eq!(crate::config::AppConfig::load(&fx.dir).version, 0);
    }

    #[tokio::test]
    async fn a_connection_without_an_instance_lists_as_its_own() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect(None).await.unwrap();
        let listed = fx.core.connections().await.unwrap();
        assert_eq!((listed[0].instance_id.as_str(), listed[0].display_name.as_str(), listed[0].enabled), ("github:ann", "ann", true));
        assert!(instance_ids(&fx).is_empty(), "before the sign-ins are adopted nothing is written");
    }

    #[tokio::test]
    async fn a_small_catalog_is_watched_whole_without_asking() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect(None).await.unwrap();
        let [state] = fx.core.watch_state().await.unwrap().try_into().unwrap();
        assert_eq!((state.chosen, state.needs_choice, state.catalog_size), (false, false, Some(3)));
    }

    #[tokio::test]
    async fn a_catalog_over_twelve_repositories_waits_for_the_person_to_choose() {
        let fx = fixture(&many(13)).await;
        fx.core.github_connect(None).await.unwrap();
        let [state] = fx.core.watch_state().await.unwrap().try_into().unwrap();
        assert_eq!((state.chosen, state.needs_choice, state.catalog_size), (false, true, Some(13)));

        fx.core.watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        let change = WatchChange { container_id: "acme/r2".into(), watched: Some(true), source: Some(WatchSource::Footprint), ..Default::default() };
        fx.core.watch_set_containers("github:ann", &[change]).await.unwrap();
        let [state] = fx.core.watch_state().await.unwrap().try_into().unwrap();
        assert_eq!((state.chosen, state.needs_choice), (true, false));
        assert_eq!((state.watches[0].watch.container.external_id.as_str(), state.watches[0].name.as_str(), state.watches[0].watch.source), ("acme/r2", "r2", WatchSource::Footprint));
        let set = fx.core.with_code_db("github:ann", |db| db.watch_set("github:ann")).unwrap();
        assert!(set.is_watched("acme/r2") && !set.is_watched("acme/r3"));
    }

    #[tokio::test]
    async fn the_catalog_marks_watched_repositories_and_suggestions_are_kept_for_a_while() {
        let fx = fixture(&many(13)).await;
        fx.core.github_connect(None).await.unwrap();
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
    async fn disconnecting_forgets_a_token_an_earlier_build_saved_and_deletes_the_cache() {
        let fake = crate::secrets::fake::Fake::default();
        fake.put("github-logins", r#"["ann"]"#);
        fake.put("github:ann", "{}");
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fx.core.github_connect(None).await.unwrap();
        fx.core.watch_state().await.unwrap();
        let file = fx.dir.join(github_db_file("ann"));
        assert!(file.exists());
        fx.core.github_disconnect("github:ann").await.unwrap();
        assert_eq!((fake.get("github:ann"), fx.core.code.auth.logins().is_empty()), (None, true));
        assert!(!file.exists());
        assert!(fx.core.connections().await.unwrap().is_empty());
        assert!(fx.core.registry.connection("github:ann").is_none());
        assert!(matches!(fx.core.watch_set_mode("github:ann", WatchMode::Everything).await, Err(Error::NotSignedIn)));
    }

    #[tokio::test]
    async fn connecting_an_account_gh_holds_makes_its_snapshot_ready_without_another_probe() {
        let fx = fixture(REPOS).await;
        fx.core.adopt_instances().await;
        let status = r#"{"hosts":{"github.com":[{"state":"success","host":"github.com","login":"ann"}]}}"#;
        let gh = fx.core.code.auth.gh_dirs()[0].join("gh");
        std::fs::write(&gh, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\n[ \"$1 $2\" = \"auth token\" ] && {{ echo ghp_x; exit 0; }}\necho '{status}'\n")).unwrap();
        fx.core.github_connect(Some("ann")).await.unwrap();
        let config = crate::config::AppConfig::load(&fx.dir);
        let seen = fx.core.probe_snapshot(&config.connections[0]).unwrap();
        assert_eq!((seen.state, seen.account.as_deref()), (crate::probe::State::Ready, Some("ann")));
    }

    #[tokio::test]
    async fn a_token_an_earlier_build_saved_is_deleted_once_gh_connects_the_login_and_not_before_adoption() {
        let fake = crate::secrets::fake::Fake::default();
        fake.put("github-logins", r#"["ann"]"#);
        fake.put("github:ann", "{}");
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fx.core.github_connect(Some("ann")).await.unwrap();
        assert!(fake.get("github:ann").is_some(), "the saved logins are what adopts the account, so they stay until then");

        fx.core.adopt_instances().await;
        fx.core.github_connect(Some("ann")).await.unwrap();
        assert_eq!(fake.get("github:ann"), None);
        assert_eq!(fx.core.code.auth.logins(), ["ann"], "the login stays: it is what finds the account when config.json can't");
    }

    fn relaunch(fx: &Fx) -> Core {
        Core::new(Arc::new(Auth::signed_out(reqwest::Client::new())), Registry::new(|_| unreachable!("no tracker")), fx.dir.clone())
            .with_code(CodeService::with_factory(GithubAuth::for_test(reqwest::Client::new(), "http://unused.invalid", Vec::new()), Box::new(|_, _, _| unreachable!("no host is built"))))
    }

    async fn connected_ids(core: &Core) -> Vec<String> {
        core.connections().await.unwrap().into_iter().map(|c| c.id).collect()
    }

    #[tokio::test]
    async fn an_account_connected_before_the_connections_are_adopted_is_adopted_and_listed_at_the_next_launch() {
        let fake = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fx.core.github_connect(Some("ann")).await.unwrap();
        assert!(instance_ids(&fx).is_empty(), "nothing is adopted yet");

        let relaunched = relaunch(&fx);
        relaunched.adopt_instances().await;
        relaunched.restore().await;

        assert_eq!(instance_ids(&fx), [("github".to_string(), "github:ann".to_string())]);
        assert_eq!(connected_ids(&relaunched).await, ["github:ann"]);
    }

    #[tokio::test]
    async fn connecting_while_the_login_cant_be_recorded_fails_rather_than_losing_the_account_at_relaunch() {
        let fake = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fake.deny_writes(true);
        assert!(fx.core.github_connect(Some("ann")).await.is_err());
        assert!(fx.core.code.connection_ids().is_empty());
    }

    #[tokio::test]
    async fn an_adopted_account_is_still_listed_when_the_connections_block_cant_be_read_after_gh_took_over_from_the_saved_token() {
        let fake = crate::secrets::fake::Fake::default();
        fake.put("github-logins", r#"["ann"]"#);
        fake.put("github:ann", "{}");
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        fx.core.adopt_instances().await;
        let status = r#"{"hosts":{"github.com":[{"state":"success","host":"github.com","login":"ann"}]}}"#;
        let gh = fx.core.code.auth.gh_dirs()[0].join("gh");
        std::fs::write(&gh, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\n[ \"$1 $2\" = \"auth token\" ] && {{ echo ghp_x; exit 0; }}\necho '{status}'\n")).unwrap();
        fx.core.github_connect(Some("ann")).await.unwrap();
        assert_eq!(fake.get("github:ann"), None, "gh holds the login, so the saved token is gone");

        std::fs::write(fx.dir.join("config.json"), r#"{"version":1,"connections":[{"displayName":"no id or kind"}]}"#).unwrap();
        let relaunched = relaunch(&fx);
        relaunched.adopt_instances().await;
        relaunched.restore().await;

        assert_eq!(connected_ids(&relaunched).await, ["github:ann"]);
    }

    #[tokio::test]
    async fn an_account_connected_while_the_connections_cant_be_read_is_still_there_after_they_can() {
        let fake = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&fake);
        let fx = fixture(REPOS).await;
        std::fs::create_dir_all(&fx.dir).unwrap();
        std::fs::write(fx.dir.join("config.json"), r#"{"version":1,"connections":[{"displayName":"no id or kind"}]}"#).unwrap();
        fx.core.github_connect(Some("ann")).await.unwrap();
        std::fs::remove_file(fx.dir.join("config.json")).unwrap();

        let relaunched = relaunch(&fx);
        relaunched.adopt_instances().await;
        relaunched.restore().await;

        assert_eq!(connected_ids(&relaunched).await, ["github:ann"]);
    }

    #[tokio::test]
    async fn a_sync_refused_for_its_token_is_unauthorised_and_the_probe_it_prompts_marks_the_instance_not_signed_in() {
        let fx = fixture(REPOS).await;
        fx.core.adopt_instances().await;
        let ready = r#"{"hosts":{"github.com":[{"state":"success","host":"github.com","login":"ann"}]}}"#;
        let gh = fx.core.code.auth.gh_dirs()[0].join("gh");
        std::fs::write(&gh, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\n[ \"$1 $2\" = \"auth token\" ] && {{ echo ghp_x; exit 0; }}\necho '{ready}'\n")).unwrap();
        fx.core.github_connect(Some("ann")).await.unwrap();
        let state = |fx: &Fx| fx.core.probe_snapshot(&crate::config::AppConfig::load(&fx.dir).connections[0]).map(|s| s.state);
        assert_eq!(state(&fx), Some(crate::probe::State::Ready));

        let lost = r#"{"hosts":{"github.com":[{"state":"error","host":"github.com","login":"ann","error":"HTTP 401: Bad credentials"}]}}"#;
        std::fs::write(&gh, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\n[ \"$1 $2\" = \"auth token\" ] && exit 1\necho '{lost}'\n")).unwrap();
        let synced = fx.core.sync_code_if_due(crate::sync::Trigger::Now).await;
        assert!(matches!(synced.as_slice(), [(_, Err(e))] if e.is_unauthorized()));

        assert_eq!(fx.core.probe_connections(crate::inbox::probes::Probe::Unauthorized).await, ["github:ann"]);
        assert_eq!(state(&fx), Some(crate::probe::State::NotSignedIn));
    }

    #[tokio::test]
    async fn gh_losing_the_login_fails_the_next_request_as_unauthorised_and_gh_getting_it_back_needs_no_reconnecting() {
        let fx = fixture(REPOS).await;
        fx.core.github_connect(Some("ann")).await.unwrap();
        let gh = fx.core.code.auth.gh_dirs()[0].join("gh");
        let working = std::fs::read_to_string(&gh).unwrap();
        std::fs::write(&gh, "#!/bin/sh\nexit 1\n").unwrap();
        let err = fx.core.watch_catalog("github:ann", "", None).await.unwrap_err();
        assert!(err.is_unauthorized() && err.to_string().contains("gh auth login -h github.com"), "{err}");
        std::fs::write(&gh, working).unwrap();
        assert!(fx.core.watch_catalog("github:ann", "", None).await.is_ok());
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

    pub(crate) struct Linked {
        pub(crate) fx: Fixture,
        pub(crate) server: Server,
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

    pub(crate) async fn linked(extra: Vec<(String, Vec<Reply>)>, scopes: Option<&str>) -> Linked {
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
        let http = reqwest::Client::new();
        let (base, factory_http) = (server.base.clone(), http.clone());
        let auth = GithubAuth::for_test(http, &server.base, crate::auth::fake_gh("ghp_x"));
        let code = CodeService::with_factory(auth, Box::new(move |s, credentials, db| Arc::new(GithubHost::new(factory_http.clone(), &base, credentials, &Connection::github_id(&s.login), &s.login, db))));
        let fx = fixture_with(Some(code)).await;
        fx.core.github_connect(None).await.unwrap();
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

        pub(crate) async fn sync(&self) -> CodeSynced {
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
    async fn watched_repo_names_follow_the_watch_mode_and_leave_out_unwatched_and_inaccessible_ones() {
        let lx = linked(vec![], Some("repo")).await;
        assert_eq!(lx.core().watched_repo_names().unwrap(), ["acme/gateway", "acme/webshop"], "a small catalog nobody has chosen from is watched whole");
        lx.core().watch_set_mode("github:ann", WatchMode::Selected).await.unwrap();
        assert!(lx.core().watched_repo_names().unwrap().is_empty());
        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "acme/webshop".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        assert_eq!(lx.core().watched_repo_names().unwrap(), ["acme/webshop"]);
        lx.core().watch_set_containers("github:ann", &[WatchChange { container_id: "acme/gateway".into(), watched: Some(true), ..Default::default() }]).await.unwrap();
        lx.core().with_code_db("github:ann", |db| db.set_inaccessible("github:ann", &["acme/gateway".to_string()], true)).unwrap();
        assert_eq!(lx.core().watched_repo_names().unwrap(), ["acme/webshop"], "an inaccessible repository is left out");
        lx.core().watch_set_mode("github:ann", WatchMode::Everything).await.unwrap();
        assert_eq!(lx.core().watched_repo_names().unwrap(), ["acme/gateway", "acme/webshop"]);
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
    async fn a_connection_that_is_off_is_not_synced_and_is_synced_again_once_it_is_on() {
        let lx = linked(vec![], Some("repo")).await;
        lx.core().adopt_instances().await;
        let instance = AppConfig::load(&lx.fx.dir).connections.into_iter().find(|i| i.kind == ConnectionKind::Github).unwrap().id;
        lx.core().set_instance_enabled(&instance, false).await.unwrap();

        assert!(lx.core().sync_code_if_due(Trigger::Now).await.is_empty());
        assert_eq!(lx.requests_to("/pulls"), 0);

        lx.core().set_instance_enabled(&instance, true).await.unwrap();
        assert_eq!(lx.core().sync_code_if_due(Trigger::Now).await.len(), 1);
    }

    fn webshop_pulls(lx: &Linked) -> HashMap<u64, CodeChange> {
        let changes = lx.core().with_code_db("github:ann", |db| db.code_changes("github:ann")).unwrap();
        changes.into_iter().filter(|c| c.repo == "acme/webshop").map(|c| (c.number.unwrap(), c)).collect()
    }

    #[tokio::test]
    async fn a_pull_request_whose_reviews_cannot_be_read_is_kept_and_filled_in_by_the_next_sync() {
        let lists = vec![Reply::ok(PULLS_OPEN), Reply::ok(PULLS_ALL), Reply::ok(PULLS_OPEN), Reply::ok(PULLS_ALL)];
        let reviews = vec![Reply::hang_up(), Reply::hang_up(), Reply::hang_up(), Reply::ok(REVIEWS)];
        let lx = linked(vec![("/repos/acme/webshop/pulls".into(), lists), ("/repos/acme/webshop/pulls/208/reviews".into(), reviews)], Some("repo")).await;
        lx.core().watch_set_mode("github:ann", WatchMode::Everything).await.unwrap();

        lx.sync().await;
        let first = webshop_pulls(&lx);
        assert_eq!(first.len(), 4, "the other pull requests were stored too");
        assert_ne!(first[&208].review, crate::domain::ReviewState::ChangesRequested, "the reviews weren't read");
        assert!(lx.core().with_code_db("github:ann", |db| db.meta(LAST_SYNC)).unwrap().is_some());
        assert_eq!(lx.requests_for("/repos/acme/webshop/pulls/208/reviews"), 3);

        lx.sync().await;
        assert_eq!(webshop_pulls(&lx)[&208].review, crate::domain::ReviewState::ChangesRequested, "read on the next sync");
        assert_eq!(lx.requests_for("/repos/acme/webshop/pulls/208/reviews"), 4);
        let owed = lx.core().with_code_db("github:ann", |db| db.meta(INCOMPLETE)).unwrap().unwrap_or_default();
        assert!(owed.is_empty(), "nothing is owed once it is read: {owed:?}");
    }

    #[tokio::test]
    async fn a_transient_failure_of_the_list_is_recorded_on_the_connection_as_transient_and_a_rate_limit_is_not() {
        let lx = linked(vec![("/repos/acme/webshop/pulls".into(), vec![Reply::hang_up()])], Some("repo")).await;
        lx.core().watch_set_mode("github:ann", WatchMode::Everything).await.unwrap();
        let results = lx.core().sync_code_if_due(Trigger::Now).await;
        assert!(results[0].1.as_ref().is_err_and(Error::is_transient));
        let row = lx.core().connections().await.unwrap().into_iter().find(|c| c.id == "github:ann").unwrap();
        assert!(row.transient && row.error.is_some_and(|e| e.starts_with("Network error: ")));

        let limited = Reply::status(403, "{\"message\":\"API rate limit exceeded\"}").header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "4102444800");
        let lx = linked(vec![("/repos/acme/webshop/pulls".into(), vec![limited])], Some("repo")).await;
        lx.core().sync_code_if_due(Trigger::Now).await;
        let row = lx.core().connections().await.unwrap().into_iter().find(|c| c.id == "github:ann").unwrap();
        assert!(row.error.is_some() && !row.transient);
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
    async fn a_github_that_is_off_hides_its_repositories_and_links_and_shows_them_again_without_a_sync() {
        let lx = linked(vec![], Some("repo")).await;
        lx.core().adopt_instances().await;
        lx.sync().await;
        let ca208 = lx.fx.item("CA-208");
        let (watched, links, fetched) = (lx.core().watched_repo_names().unwrap(), lx.core().dev_links(&ca208).unwrap(), lx.requests_to("/pulls"));
        assert!(!watched.is_empty() && !links.is_empty());
        let instance = AppConfig::load(&lx.fx.dir).connections.into_iter().find(|i| i.kind == ConnectionKind::Github).unwrap().id;

        lx.core().set_instance_enabled(&instance, false).await.unwrap();

        assert!(lx.core().watched_repo_names().unwrap().is_empty());
        assert!(lx.core().dev_links(&ca208).unwrap().is_empty());
        for refused in [lx.core().code_pull_request(&CodeRef { connection_id: "github:ann".into(), repo: "acme/webshop".into(), number: 208 }).await.err(), lx.core().code_pull_requests("github:ann", "acme/webshop").await.err()] {
            assert!(refused.is_some_and(|e| e.to_string().contains("is off, so acme/webshop isn't read")));
        }
        let refused = lx.core().code_connection_for("acme/webshop").unwrap_err().to_string();
        assert!(refused.contains("is off, so acme/webshop isn't read"), "{refused}");
        assert!(lx.core().code_connection_for("acme/gateway").is_err_and(|e| e.to_string().contains("is off")), "the repositories chosen are the ones that are off");
        assert!(lx.core().require_watched_repo("acme/webshop").is_ok(), "a run is still launched into a chosen repository");
        assert_eq!(lx.core().with_code_db("github:ann", |db| Ok(db.code_changes("github:ann")?.len())).unwrap(), 4, "the cache is kept");

        lx.core().set_instance_enabled(&instance, true).await.unwrap();
        assert_eq!(lx.core().watched_repo_names().unwrap(), watched);
        assert_eq!(lx.core().dev_links(&ca208).unwrap(), links);
        assert_eq!(lx.requests_to("/pulls"), fetched, "nothing was fetched to bring them back");
    }

    #[tokio::test]
    async fn a_review_run_can_still_read_its_pull_request_while_github_is_off() {
        let lx = linked(vec![], Some("repo")).await;
        lx.core().adopt_instances().await;
        lx.sync().await;
        let instance = AppConfig::load(&lx.fx.dir).connections.into_iter().find(|i| i.kind == ConnectionKind::Github).unwrap().id;
        lx.core().set_instance_enabled(&instance, false).await.unwrap();

        let change = lx.core().code_pull_change("acme/webshop", 208).await.unwrap();

        assert_eq!(change.number, Some(208));
    }

    #[tokio::test]
    async fn a_live_search_does_not_ask_a_github_that_is_off() {
        let lx = linked(vec![("/search/issues".into(), vec![Reply::ok(ISSUES_KEY)]), ("/search/commits".into(), vec![Reply::ok("{\"items\":[]}")])], Some("repo")).await;
        lx.core().adopt_instances().await;
        lx.core().watch_set_mode("github:ann", WatchMode::Everything).await.unwrap();
        let instance = AppConfig::load(&lx.fx.dir).connections.into_iter().find(|i| i.kind == ConnectionKind::Github).unwrap().id;
        lx.core().set_instance_enabled(&instance, false).await.unwrap();

        let (_, changed) = lx.core().dev_links_live(&lx.fx.item("CA-209")).await.unwrap();

        assert!(changed.is_empty());
        assert_eq!(lx.requests_to("/search"), 0);
        lx.core().set_instance_enabled(&instance, true).await.unwrap();
        lx.core().dev_links_live(&lx.fx.item("CA-209")).await.unwrap();
        assert!(lx.requests_to("/search") > 0);
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
#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::codehost::github::testserver::{pull_reply, pull_reply_at, Reply};
    use crate::domain::{DiffSide, ProposalQuery, Run};
    use crate::inbox::testing::{fixture_watching, fixture_watching_with, Fixture};

    const FILES_ROUTE: &str = "/repos/acme/webshop/pulls/12/files";
    const PULL_ROUTE: &str = "/repos/acme/webshop/pulls/12";

    fn pull_route() -> (&'static str, Vec<Reply>) {
        (PULL_ROUTE, vec![pull_reply(12, "open", Some("acme/webshop"), "main")])
    }

    fn hunks() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../src/lib/diffHunks.fixtures.json")).unwrap()
    }

    fn files_reply() -> Reply {
        let h = hunks();
        let files = serde_json::json!([
            { "filename": "src/consumer/retry.ts", "status": "modified", "additions": 6, "deletions": 1, "patch": h["patches"]["retry"] },
            { "filename": "src/consumer/index.ts", "status": "modified", "additions": 1, "deletions": 1, "patch": h["patches"]["index"] }
        ]);
        Reply::ok(&files.to_string())
    }

    async fn reviewer(fx: &Fixture) -> Run {
        let clone = fx.home.join("webshop");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        let spec = crate::domain::fixtures::run_spec();
        let mut run = fx.core.queue_test_run(crate::domain::RunSpec { clone_path: clone, ..spec }, Some(fx.item("CA-1"))).await.unwrap();
        run.spec.pr = Some(12);
        run.spec.pr_sha = Some("a1b2c3d4e5f6".into());
        fx.core.save_run(&run).await.unwrap();
        run
    }

    fn comments() -> Vec<ReviewComment> {
        [42, 17].into_iter().map(|line| ReviewComment { path: "src/consumer/retry.ts".into(), line, side: DiffSide::Right, body: format!("Review comment at {line}.") }).collect()
    }

    async fn draft_for(fx: &Fixture, run: &Run, comments: Vec<ReviewComment>) -> Result<Proposal> {
        fx.core.draft_review(&fx.scope, Origin::chat("review-turn"), GithubReviewDraft {
            run_id: run.id.clone(), repo: "acme/webshop".into(), number: 12, reviewed_sha: "a1b2c3d4e5f6".into(), summary: "Review summary.".into(), comments,
        }).await
    }

    #[tokio::test]
    async fn an_off_diff_comment_that_overflows_the_summary_is_refused_without_losing_text() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let run = reviewer(&fx).await;
        let input = GithubReviewDraft {
            run_id: run.id, repo: "acme/webshop".into(), number: 12, reviewed_sha: "a1b2c3d4e5f6".into(),
            summary: "s".repeat(9_000),
            comments: vec![ReviewComment { path: "missing.rs".into(), line: 1, side: DiffSide::Right, body: "c".repeat(1_500) }],
        };
        let error = fx.core.draft_review(&fx.scope, Origin::chat("turn"), input).await.unwrap_err().to_string();
        assert!(error.contains("Moving 1 inline comments") && error.contains("no content was discarded"), "{error}");
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
        assert!(posts(&fx).is_empty());
    }

    #[tokio::test]
    async fn inline_comments_beyond_the_cap_are_kept_in_the_summary() {
        let patch = format!("@@ -0,0 +1,51 @@\n{}", "+line\n".repeat(51));
        let files = serde_json::json!([{ "filename": "many.rs", "status": "added", "additions": 51, "deletions": 0, "patch": patch }]);
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![Reply::ok(&files.to_string())])]).await;
        let run = reviewer(&fx).await;
        let comments = (1..=51).map(|line| ReviewComment { path: "many.rs".into(), line, side: DiffSide::Right, body: format!("Comment {line}") }).collect();
        let proposal = draft_for(&fx, &run, comments).await.unwrap();
        let Intent::GithubReview { comments, summary, .. } = proposal.intent else { panic!() };
        assert_eq!(comments.len(), proposals::REVIEW_COMMENTS_MAX);
        assert!(summary.contains("many.rs:51 (RIGHT): Comment 51"));
        assert!(posts(&fx).is_empty());
    }

    #[tokio::test]
    async fn explicit_review_text_needs_no_structured_report_or_finished_run() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let run = reviewer(&fx).await;
        assert!(run.result.is_none());
        let proposal = draft_for(&fx, &run, comments()).await.unwrap();
        assert_eq!(proposal.created_by, CreatedBy::Pip);
        assert_eq!(proposal.state, ProposalState::Pending);
        assert_eq!(intent_of(&proposal).4, "Review summary.");
        assert_eq!(intent_of(&proposal).5, comments());
        assert!(posts(&fx).is_empty());
    }

    #[tokio::test]
    async fn comments_outside_the_reviewed_diff_move_to_the_summary_without_losing_their_text() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let run = reviewer(&fx).await;
        let mut list = comments();
        list.extend([
            ReviewComment { path: "src/not-in-diff.ts".into(), line: 8, side: DiffSide::Right, body: "Missing file finding.".into() },
            ReviewComment { path: "../outside.ts".into(), line: 3, side: DiffSide::Right, body: "Unsafe path finding.".into() },
            ReviewComment { path: "src/consumer/retry.ts".into(), line: 0, side: DiffSide::Right, body: "Missing line finding.".into() },
            ReviewComment { path: "src/consumer/retry.ts".into(), line: 42, side: DiffSide::Left, body: "Wrong side finding.".into() },
            ReviewComment { body: "Second finding on the same line.".into(), ..comments()[0].clone() },
        ]);
        let proposal = draft_for(&fx, &run, list).await.unwrap();
        let (.., summary, inline) = intent_of(&proposal);
        assert_eq!(inline, comments());
        for text in ["Missing file finding.", "Unsafe path finding.", "Missing line finding.", "Wrong side finding.", "Second finding on the same line."] {
            assert!(summary.contains(text), "{summary}");
        }
        assert!(posts(&fx).is_empty());
    }

    #[tokio::test]
    async fn a_missing_patch_moves_its_comments_to_the_summary() {
        let files = Reply::ok(r#"[{"filename":"src/consumer/retry.ts","status":"modified","additions":1,"deletions":0}]"#);
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files])]).await;
        let run = reviewer(&fx).await;
        let proposal = draft_for(&fx, &run, comments()).await.unwrap();
        assert!(intent_of(&proposal).5.is_empty());
        assert!(intent_of(&proposal).4.contains("Review comment at 42."));
    }

    #[tokio::test]
    async fn a_review_requires_a_reviewer_of_the_same_pull_request_and_pinned_commit() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let mut run = reviewer(&fx).await;
        for (repo, number, sha) in [
            ("other/repo", Some(12), Some("a1b2c3d4e5f6")),
            ("acme/webshop", Some(99), Some("a1b2c3d4e5f6")),
            ("acme/webshop", None, Some("a1b2c3d4e5f6")),
            ("acme/webshop", Some(12), Some("f00dfeed0000")),
            ("acme/webshop", Some(12), None),
        ] {
            run.spec.repo = repo.into();
            run.spec.pr = number;
            run.spec.pr_sha = sha.map(String::from);
            fx.core.save_run(&run).await.unwrap();
            assert!(draft_for(&fx, &run, comments()).await.is_err());
        }
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
        assert!(posts(&fx).is_empty());
    }

    #[tokio::test]
    async fn an_unknown_reviewer_or_invalid_reviewed_sha_creates_no_draft() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        for sha in ["", "main", "a1b2c3", "123456g", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "a1b2c3d4e5f6"] {
            let input = GithubReviewDraft { run_id: "missing".into(), repo: "acme/webshop".into(), number: 12, reviewed_sha: sha.into(), summary: "Summary.".into(), comments: vec![] };
            assert!(fx.core.draft_review(&fx.scope, Origin::chat("turn"), input).await.is_err());
        }
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_review_cannot_borrow_the_reviewer_from_another_workstreams_conversation() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = reviewer(&fx).await;
        let input = GithubReviewDraft { run_id: run.id, repo: "acme/webshop".into(), number: 12, reviewed_sha: "a1b2c3d4e5f6".into(), summary: "Summary.".into(), comments: vec![] };
        let origin = Origin::Chat { request_id: "turn".into(), workstream: Some("another-workstream".into()) };
        assert!(fx.core.draft_review(&fx.scope, origin, input).await.unwrap_err().to_string().contains("another workstream"));
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_deleted_line_stays_inline_on_the_left_and_a_missing_left_line_moves_to_the_summary() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let run = reviewer(&fx).await;
        let deleted = ReviewComment { path: "src/consumer/retry.ts".into(), line: 38, side: DiffSide::Left, body: "Keep the deleted call.".into() };
        let misplaced = ReviewComment { line: 42, body: "This line is not on the left.".into(), ..deleted.clone() };
        let proposal = draft_for(&fx, &run, vec![deleted.clone(), misplaced]).await.unwrap();
        assert_eq!(intent_of(&proposal).5, [deleted]);
        assert!(intent_of(&proposal).4.contains("This line is not on the left."));
    }

    #[tokio::test]
    async fn a_review_is_refused_when_the_pull_request_moves_before_or_during_its_diff_read() {
        for moved_during in [false, true] {
            let mut pulls = Vec::new();
            if moved_during {
                pulls.push(pull_reply(12, "open", Some("acme/webshop"), "main"));
            }
            pulls.push(pull_reply_at(12, "open", Some("acme/webshop"), "main", "f00dfeed0000"));
            let fx = fixture_watching_with(&["acme/webshop"], vec![(PULL_ROUTE, pulls), (FILES_ROUTE, vec![files_reply()])]).await;
            let run = reviewer(&fx).await;
            assert!(draft_for(&fx, &run, comments()).await.is_err());
            assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
        }
    }

    fn intent_of(p: &Proposal) -> (&str, &str, u64, &str, &str, &[ReviewComment]) {
        let Intent::GithubReview { connection_id, repo, number, commit_sha, summary, comments, .. } = &p.intent else { panic!("{:?}", p.intent) };
        (connection_id, repo, *number, commit_sha, summary, comments)
    }

    const POST_ROUTE: &str = "POST /repos/acme/webshop/pulls/12/reviews";

    fn posted_reply() -> Reply {
        Reply::ok("{\"id\":77,\"html_url\":\"https://github.com/acme/webshop/pull/12#pullrequestreview-77\"}")
    }

    async fn drafted(fx: &Fixture) -> Proposal {
        let run = reviewer(fx).await;
        draft_for(fx, &run, comments()).await.unwrap()
    }

    fn posts(fx: &Fixture) -> Vec<String> {
        fx.github_seen().into_iter().filter(|(m, _)| m != "GET").map(|(m, t)| format!("{m} {t}")).collect()
    }

    #[tokio::test]
    async fn posting_a_review_draft_sends_one_comment_review_and_records_it() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        assert!(posts(&fx).is_empty(), "drafting posts nothing");
        let done = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        assert_eq!((done.state.clone(), done.error.clone()), (ProposalState::Applied, None));
        let posted = done.posted.clone().expect("posted");
        assert_eq!((posted.id, posted.url.as_str()), (77, "https://github.com/acme/webshop/pull/12#pullrequestreview-77"));
        assert_eq!(posts(&fx), ["POST /repos/acme/webshop/pulls/12/reviews"]);
        let seen = fx.github.as_ref().unwrap().lock().unwrap().iter().find(|s| s.method == "POST").cloned().unwrap();
        let body: serde_json::Value = serde_json::from_str(&seen.body).unwrap();
        assert_eq!((body["event"].as_str(), body["commit_id"].as_str()), (Some("COMMENT"), Some("a1b2c3d4e5f6")));
        assert_eq!(body["comments"].as_array().unwrap().iter().map(|c| (c["path"].as_str().unwrap(), c["line"].as_u64().unwrap())).collect::<Vec<_>>(), [("src/consumer/retry.ts", 42), ("src/consumer/retry.ts", 17)]);
        assert!(fx.tracker.intents().is_empty(), "posting a review writes nothing to Jira");
        assert_eq!(fx.core.proposal(&p.id).await.unwrap(), Some(done));
    }

    #[tokio::test]
    async fn a_review_for_a_connection_that_is_off_waits_and_posts_once_it_is_on() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        fx.core.adopt_instances().await;
        let p = drafted(&fx).await;
        let instance = AppConfig::load(&fx.dir).connections.into_iter().find(|i| i.kind == ConnectionKind::Github).unwrap().id;
        fx.core.set_instance_enabled(&instance, false).await.unwrap();

        let refused = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap_err();

        assert!(refused.to_string().contains("GitHub is off. This draft waits until you turn it on."), "{refused}");
        assert!(posts(&fx).is_empty());
        assert_eq!(fx.core.proposal(&p.id).await.unwrap().unwrap().state, ProposalState::Pending);

        fx.core.set_instance_enabled(&instance, true).await.unwrap();
        let done = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
    }

    #[tokio::test]
    async fn a_review_draft_is_posted_at_most_once_and_never_through_the_tracker() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        let err = fx.core.approve_proposal(&p.id).await.unwrap_err();
        assert!(err.to_string().contains("posted to GitHub with its own button"), "{err}");
        assert!(posts(&fx).is_empty() && fx.tracker.intents().is_empty(), "the approval path sends nothing");
        assert_eq!(fx.core.proposal(&p.id).await.unwrap().unwrap().state, ProposalState::Pending, "and leaves the draft as it was");
        fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        let again = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap_err();
        assert!(again.to_string().contains("already been applied"), "{again}");
        assert_eq!(posts(&fx).len(), 1, "the second post sent nothing");
    }

    #[tokio::test]
    async fn only_a_review_draft_can_be_claimed_for_posting() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let comment = fx.core.draft_as_user(Intent::Comment { item: fx.item("CA-1"), body: crate::domain::Doc::paragraph("hi") }, None).await.unwrap();
        let err = fx.core.post_review_draft(&comment.id, 0, false).await.unwrap_err();
        assert!(err.to_string().contains("only a review draft"), "{err}");
        assert_eq!(fx.core.proposal(&comment.id).await.unwrap().unwrap().state, ProposalState::Pending);
        assert!(posts(&fx).is_empty() && fx.tracker.intents().is_empty());
    }

    #[tokio::test]
    async fn a_review_github_finds_outdated_stays_pending_and_says_so() {
        let fx = fixture_watching_with(
            &["acme/webshop"],
            vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(422, "{\"message\":\"Unprocessable Entity\",\"errors\":[\"Line could not be resolved\"]}"), posted_reply()])],
        )
        .await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        assert_eq!((back.state.clone(), back.error.as_deref(), back.posted.clone()), (ProposalState::Pending, Some(REVIEW_OUTDATED_NOTE), None));
        let refused = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        assert_eq!(refused.state, ProposalState::Applied, "a later attempt may go through");
        assert_eq!(posts(&fx).len(), 2);
    }

    #[tokio::test]
    async fn a_post_gh_cant_get_a_token_for_sends_nothing_and_isnt_marked_maybe_posted() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        let gh = fx.core.code.auth.gh_dirs()[0].join("gh");
        let working = std::fs::read_to_string(&gh).unwrap();
        std::fs::write(&gh, "#!/nonexistent/interpreter\n").unwrap();

        let back = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();

        assert_eq!((back.state.clone(), back.maybe_posted.clone()), (ProposalState::Pending, None));
        assert!(back.error.as_deref().unwrap().contains("couldn't run gh") && !back.error.as_deref().unwrap().contains(REVIEW_MAYBE_POSTED_NOTE), "{:?}", back.error);
        assert!(posts(&fx).is_empty());

        std::fs::write(&gh, working).unwrap();
        let done = fx.core.post_review_draft(&p.id, back.revisions.len(), false).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(posts(&fx).len(), 1, "posted once, with no search for a review that was never sent");
    }

    #[tokio::test]
    async fn a_token_that_cannot_write_leaves_the_draft_pending_with_the_reason() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(403, "{\"message\":\"Resource not accessible by personal access token\"}")])]).await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().unwrap().contains("the token can't write to pull requests in acme/webshop"), "{:?}", back.error);

    }

    #[tokio::test]
    async fn a_review_left_posting_when_gossamr_closed_is_pending_again() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let claimed = fx.core.with_db_for(&fx.scope, |db| db.begin_posting_review(&p.id, Utc::now(), None)).await.unwrap().unwrap();
        assert_eq!(claimed.state, ProposalState::Applying);
        assert_eq!(fx.core.with_db_for(&fx.scope, |db| db.begin_posting_review(&p.id, Utc::now(), None)).await.unwrap(), None, "claimed once");
        assert_eq!(fx.core.with_db_for(&fx.scope, |db| db.release_interrupted(Utc::now())).await.unwrap(), 1);
        let back = fx.core.proposal(&p.id).await.unwrap().unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().unwrap().contains("Check whether it went through"));
    }

    #[tokio::test]
    async fn a_review_out_when_gossamr_closed_is_looked_for_before_anything_is_sent_again() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        let (.., summary, _) = intent_of(&p);
        let sending = MaybePosted { at: Utc::now(), commit_sha: "a1b2c3d4e5f6".into(), summary: summary.into(), checked_at: None };
        fx.core.with_db_for(&fx.scope, |db| db.begin_posting_review(&p.id, Utc::now(), Some(sending))).await.unwrap().unwrap();
        fx.core.with_db_for(&fx.scope, |db| db.release_interrupted(Utc::now())).await.unwrap();
        assert!(fx.core.proposal(&p.id).await.unwrap().unwrap().maybe_posted.is_some(), "what was out is kept");
        fx.github_route(REVIEWS_ROUTE, vec![reviews_with(summary)]);
        let done = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        assert_eq!((done.state, done.posted.map(|r| r.id)), (ProposalState::Applied, Some(88)));
        assert!(posts(&fx).is_empty(), "nothing was sent");
    }
    #[tokio::test]
    async fn pip_may_add_a_comment_only_while_the_head_is_the_reviewed_commit() {
        let pulls = vec![pull_reply(12, "open", Some("acme/webshop"), "main"), pull_reply(12, "open", Some("acme/webshop"), "main"), pull_reply(12, "open", Some("acme/webshop"), "main"), pull_reply(12, "open", Some("acme/webshop"), "main"), pull_reply_at(12, "open", Some("acme/webshop"), "main", "f00dfeed0000")];
        let fx = fixture_watching_with(&["acme/webshop"], vec![(PULL_ROUTE, pulls), (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let (.., had) = intent_of(&p);
        let at_index = ReviewComment { path: "src/consumer/index.ts".into(), line: 1, side: DiffSide::Right, body: "This export moved.".into() };
        let added = [had.to_vec(), vec![at_index.clone()]].concat();
        let revised = fx.core.revise_review_as_pip(&fx.scope, None, &p.id, None, added.clone()).await.unwrap();
        assert_eq!(intent_of(&revised).5.len(), 3, "the head is the reviewed commit, so a line its diff shows may be added");
        let mut later = had.to_vec();
        later.push(ReviewComment { line: 2, ..at_index });
        let err = fx.core.revise_review_as_pip(&fx.scope, None, &p.id, None, later).await.unwrap_err();
        assert!(err.to_string().contains("has moved on from a1b2c3d4 since the review read it"), "{err}");
        assert_eq!(intent_of(&fx.core.proposal(&p.id).await.unwrap().unwrap()).5, added.as_slice(), "nothing changed");
    }

    #[tokio::test]
    async fn a_review_changed_since_the_person_looked_is_not_posted() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![posted_reply()])]).await;
        let p = drafted(&fx).await;
        let (.., comments) = intent_of(&p);
        fx.core.revise_review_as_pip(&fx.scope, None, &p.id, Some("Pip's words.".into()), comments.to_vec()).await.unwrap();
        let err = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap_err();
        assert_eq!(err.to_string(), REVIEW_CHANGED);
        assert!(posts(&fx).is_empty(), "nothing was sent");
        let now = fx.core.proposal(&p.id).await.unwrap().unwrap();
        assert_eq!(now.state, ProposalState::Pending);
        assert_eq!(fx.core.post_review_draft(&p.id, now.revisions.len(), false).await.unwrap().state, ProposalState::Applied, "posted once read again");
    }

    const REVIEWS_ROUTE: &str = "/repos/acme/webshop/pulls/12/reviews?per_page=100";

    #[tokio::test]
    async fn a_review_that_fails_at_the_gateway_may_be_posted_and_is_found_on_github_rather_than_sent_again() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(502, "{\"message\":\"Bad Gateway\"}")])]).await;
        let p = drafted(&fx).await;
        let (.., summary, _) = intent_of(&p);
        let back = fx.core.post_review_draft(&p.id, p.revisions.len(), false).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().unwrap().starts_with(REVIEW_MAYBE_POSTED_NOTE), "{:?}", back.error);
        assert_eq!(posts(&fx).len(), 1);

        // It had gone through: the next post finds it and records it, and sends nothing.
        let theirs = serde_json::json!([
            { "id": 5, "user": { "login": "bob" }, "state": "COMMENTED", "commit_id": "a1b2c3d4e5f6", "body": summary, "submitted_at": "2026-10-01T10:00:00Z" },
            { "id": 88, "user": { "login": "ann" }, "state": "COMMENTED", "commit_id": "a1b2c3d4e5f6", "body": summary, "html_url": "https://github.com/acme/webshop/pull/12#pullrequestreview-88", "submitted_at": "2026-10-01T10:00:00Z" }
        ]);
        fx.github_route(REVIEWS_ROUTE, vec![Reply::ok(&theirs.to_string())]);
        let done = fx.core.post_review_draft(&p.id, back.revisions.len(), false).await.unwrap();
        assert_eq!((done.state.clone(), done.error.clone(), done.posted.as_ref().map(|r| r.id)), (ProposalState::Applied, None, Some(88)));
        assert_eq!(posts(&fx).len(), 1, "it wasn't posted a second time");
    }

    /// Review 88 by this token's login at the reviewed commit, with `summary` as its body.
    fn reviews_with(summary: &str) -> Reply {
        let found = serde_json::json!([{ "id": 88, "user": { "login": "ann" }, "state": "COMMENTED", "commit_id": "a1b2c3d4e5f6", "body": summary, "html_url": "https://github.com/acme/webshop/pull/12#pullrequestreview-88", "submitted_at": "2026-10-01T10:00:00Z" }]);
        Reply::ok(&found.to_string())
    }

    #[tokio::test]
    async fn an_edit_after_an_uncertain_post_keeps_it_maybe_posted_and_the_review_sent_with_the_old_summary_is_found() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(502, "{}")])]).await;
        let p = drafted(&fx).await;
        let sent = intent_of(&p).4.to_string();
        let back = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        assert_eq!(back.maybe_posted.as_ref().map(|m| (m.commit_sha.as_str(), m.summary.as_str(), m.checked_at)), Some(("a1b2c3d4e5f6", sent.as_str(), None)));

        // Pip rewords it, then the person does, which clears the error but not what may be on GitHub.
        let (.., comments) = intent_of(&back);
        let revised = fx.core.revise_review_as_pip(&fx.scope, None, &p.id, Some("Pip's words.".into()), comments.to_vec()).await.unwrap();
        assert_eq!(revised.maybe_posted, back.maybe_posted, "a revision leaves it maybe posted");
        let edited = fx.core.edit_proposal(&p.id, &super::super::drafts::Edit::GithubReview { summary: Some("My own words.".into()), comments: None }).await.unwrap();
        assert_eq!((edited.error.as_deref(), intent_of(&edited).4), (None, "My own words."));
        assert_eq!(edited.maybe_posted, back.maybe_posted, "and so does an edit");

        // The review it sent had the old summary, and is found by it: recorded as posted, and nothing sent.
        fx.github_route(REVIEWS_ROUTE, vec![reviews_with(&sent)]);
        let now = fx.core.proposal(&p.id).await.unwrap().unwrap();
        let done = fx.core.post_review_draft(&p.id, now.revisions.len(), false).await.unwrap();
        assert_eq!((done.state.clone(), done.posted.as_ref().map(|r| r.id), done.maybe_posted.clone()), (ProposalState::Applied, Some(88), None));
        assert_eq!(posts(&fx).len(), 1, "it wasn't posted a second time");
    }

    #[tokio::test]
    async fn a_maybe_posted_review_github_doesnt_show_is_held_until_the_person_posts_anyway_and_then_sent_once() {
        let fx = fixture_watching_with(
            &["acme/webshop"],
            vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(504, "{}"), posted_reply()]), (REVIEWS_ROUTE, vec![Reply::ok("[]")])],
        )
        .await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        assert!(back.error.as_deref().unwrap().starts_with(REVIEW_MAYBE_POSTED_NOTE));
        for _ in 0..2 {
            let held = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
            assert_eq!((held.state.clone(), held.error.as_deref()), (ProposalState::Pending, Some(REVIEW_NOT_FOUND_NOTE)));
            let unsure = held.maybe_posted.expect("still maybe posted");
            assert!(unsure.checked_at.is_some(), "looked for");
            assert_eq!(posts(&fx).len(), 1, "nothing sent without the person's say");
        }
        assert!(fx.github_seen().iter().any(|(_, t)| t == REVIEWS_ROUTE), "it looked");

        let done = fx.core.post_review_draft(&p.id, 0, true).await.unwrap();
        assert_eq!((done.state, done.posted.map(|r| r.id), done.maybe_posted), (ProposalState::Applied, Some(77), None));
        assert_eq!(posts(&fx).len(), 2, "posted once more, once");
    }

    #[tokio::test]
    async fn a_maybe_posted_review_github_cant_be_asked_about_is_held_and_says_so() {
        let fx = fixture_watching_with(
            &["acme/webshop"],
            vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(502, "{}")]), (REVIEWS_ROUTE, vec![Reply::status(500, "{\"message\":\"boom\"}")])],
        )
        .await;
        let p = drafted(&fx).await;
        fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        let held = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        assert_eq!(held.state, ProposalState::Pending);
        assert!(held.error.as_deref().unwrap().contains("couldn't check just now"), "{:?}", held.error);
        assert!(held.maybe_posted.is_some_and(|m| m.checked_at.is_some()));
        assert_eq!(posts(&fx).len(), 1);
    }

    #[tokio::test]
    async fn a_review_definitely_refused_isnt_left_maybe_posted() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![Reply::status(422, "{\"errors\":[\"Line could not be resolved\"]}")])]).await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        assert_eq!((back.error.as_deref(), back.maybe_posted), (Some(REVIEW_OUTDATED_NOTE), None));
    }

    #[tokio::test]
    async fn a_422_that_isnt_about_the_lines_keeps_githubs_words_and_isnt_outdated() {
        let refused = Reply::status(422, "{\"message\":\"Unprocessable Entity\",\"errors\":[\"User can only have one pending review per pull request\"]}");
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()]), (POST_ROUTE, vec![refused])]).await;
        let p = drafted(&fx).await;
        let back = fx.core.post_review_draft(&p.id, 0, false).await.unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert_eq!(back.error.as_deref(), Some("GitHub didn't accept the review: User can only have one pending review per pull request."));
    }

    #[tokio::test]
    async fn an_items_drafts_include_the_review_of_its_pull_request() {
        let fx = fixture_watching_with(&["acme/webshop"], vec![pull_route(), (FILES_ROUTE, vec![files_reply()])]).await;
        let p = drafted(&fx).await;
        let of_item = fx.core.proposals(&ProposalQuery { item: Some(fx.item("CA-1")), ..Default::default() }).await.unwrap();
        assert!(of_item.iter().any(|d| d.id == p.id), "{of_item:?}");
    }
}
