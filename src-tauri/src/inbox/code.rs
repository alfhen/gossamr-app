//! Core's code host service: GitHub connections, each with its own database, and the watch set over repositories.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};

use super::watch::{CatalogEntry, CatalogPage, WatchRow, WatchState};
use super::{now_iso, Core};
use crate::auth::{DeviceStart, GithubAuth, GithubSession, KeychainStore, TokenStore};
use crate::codehost::github::{GithubHost, API_BASE};
use crate::codehost::CodeHost;
use crate::db::Db;
use crate::domain::{ContainerQuery, ContainerSummary, Footprint, WatchChange, WatchMode, WatchSet, AUTO_EVERYTHING_MAX};
use crate::error::{Error, Result};
use crate::tracker::{Connection, ConnectionKind};

const CATALOG_SIZE: &str = "watch_catalog_size";
const CATALOG_PROBED: &str = "watch_catalog_probed_at";
const FOOTPRINT: &str = "watch_footprint";
const PROBE_EVERY: Duration = Duration::hours(12);
const FOOTPRINT_TTL: Duration = Duration::hours(6);
const FOOTPRINT_DAYS: u32 = 90;
const CATALOG_PAGE: usize = 50;
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
        self.registry.register(connection);
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
                sessions.get(id).map(|s| info(s, last, None))
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
}
