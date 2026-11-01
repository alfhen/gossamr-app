//! Jira sign-in behind an `Authenticator`, and the signed-in session Core reads credentials from.

mod atlassian;
mod gh;
mod github;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::NaiveDate;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::secrets;
use crate::tracker::Connection;

pub use gh::{find_gh_in, CredentialSource};
#[cfg(test)]
pub use gh::{fake_gh, FixedToken};
pub use github::{GithubAuth, GithubSession};
pub use atlassian::{Atlassian, SiteScope};

/// Where an earlier build kept its one Jira token; `restore_sessions` moves it to `TOKEN_PREFIX` plus its connection id.
const TOKEN_KEY: &str = "jira-token";
const TOKEN_PREFIX: &str = "jira-token:";
/// What an earlier build kept for Atlassian sign-in. Nothing reads these now.
const RETIRED_KEYS: [&str; 2] = ["session", "oauth-app"];
/// Days before a token's expiry that Gossamr starts saying so.
pub const EXPIRY_WARNING_DAYS: i64 = 14;

/// What the Connect Jira sheet sends.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSignIn {
    pub site: String,
    /// Only when the site wouldn't give it.
    pub cloud_id: Option<String>,
    pub email: String,
    pub token: String,
    /// `YYYY-MM-DD`. Atlassian doesn't report a token's expiry, so this is what the person says it is.
    pub expires_on: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub cloud_id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub account_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

/// What a sign-in leaves in the Keychain. It must never derive `Debug`: the token would reach logs.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub email: String,
    pub token: String,
    pub expires_on: String,
    pub site: Site,
    pub me: Account,
}

impl Credentials {
    pub fn site_scope(&self) -> SiteScope {
        SiteScope { cloud_id: self.site.cloud_id.clone(), account_id: self.me.account_id.clone() }
    }

    pub fn scope(&self) -> Scope {
        self.site_scope().scope()
    }

    pub fn connection(&self) -> Connection {
        self.site_scope().connection(&self.site.name)
    }

    pub fn connection_id(&self) -> String {
        self.site_scope().connection_id()
    }

    fn access_token(&self) -> AccessToken {
        AccessToken { email: self.email.clone(), token: self.token.clone(), scope: self.site_scope() }
    }
}

#[async_trait]
pub trait Authenticator: Send + Sync {
    /// The cloud id `site` reports about itself, or `None` when it doesn't say.
    async fn find_cloud_id(&self, site: &str) -> Result<Option<String>>;

    /// Checks the token against Jira and returns what to keep.
    async fn connect(&self, input: &TokenSignIn) -> Result<Credentials>;

    /// Who `token` signs in as, which also proves it still works.
    async fn whoami(&self, token: &AccessToken) -> Result<Account>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub site: Option<Site>,
    pub me: Option<Account>,
    pub email: Option<String>,
    pub expires_on: Option<String>,
}

/// The signed-in connection and account a piece of work belongs to. Work started for one scope is refused once the
/// person has signed in as another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub connection_id: String,
    pub account_id: String,
}

/// What the Jira client needs for one request.
pub struct AccessToken {
    pub email: String,
    pub token: String,
    pub scope: SiteScope,
}

pub struct Auth {
    authenticator: Arc<dyn Authenticator>,
    /// The signed-in accounts ordered by `Saved::added`; the first is the primary.
    sessions: Mutex<Vec<Credentials>>,
    restore_failed: bool,
}

fn token_key(connection_id: &str) -> String {
    format!("{TOKEN_PREFIX}{connection_id}")
}

/// What the vault holds for one account. `added` keeps the order accounts were added in, because listing the keys
/// gives alphabetical order; the lowest is the primary. Tokens saved before it existed read as 0.
#[derive(Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    added: u64,
    #[serde(flatten)]
    credentials: Credentials,
}

fn saved_op(added: u64, credentials: &Credentials) -> Result<secrets::Op> {
    secrets::Op::save(&token_key(&credentials.connection_id()), &Saved { added, credentials: credentials.clone() })
}

/// The `added` of the account saved under `key`.
fn added_of(key: &str) -> Result<Option<u64>> {
    Ok(secrets::load::<Saved>(key)?.map(|s| s.added))
}

/// The sessions saved in the Keychain, and whether any of them was there but couldn't be read.
fn restore_sessions() -> (Vec<Credentials>, bool) {
    let keys = match secrets::keys_with_prefix(TOKEN_PREFIX) {
        Ok(keys) => keys,
        Err(e) => {
            eprintln!("couldn't restore the saved Jira tokens: {e}");
            return (Vec::new(), true);
        }
    };
    let mut failed = false;
    let mut saved = Vec::new();
    for key in &keys {
        match secrets::load::<Saved>(key) {
            Ok(found) => saved.extend(found),
            Err(e) => {
                eprintln!("couldn't restore a saved Jira token: {e}");
                failed = true;
            }
        }
    }
    saved.sort_by_key(|s| s.added);
    let mut sessions: Vec<Credentials> = saved.into_iter().map(|s| s.credentials).collect();
    match secrets::load::<Credentials>(TOKEN_KEY) {
        Ok(Some(old)) if keys.is_empty() => move_old_token(old, &mut sessions),
        Ok(Some(_)) if !failed => forget_old_token(),
        Ok(_) => {}
        Err(e) => {
            eprintln!("couldn't restore the saved Jira token: {e}");
            failed = true;
        }
    }
    (sessions, failed)
}

/// Moves the token that an earlier build saved as `jira-token` to its connection's own key. A failed write leaves the
/// old key whole so the move runs again next launch.
fn move_old_token(old: Credentials, sessions: &mut Vec<Credentials>) {
    let moved = saved_op(1, &old).and_then(|save| secrets::apply(&[save, secrets::Op::delete(TOKEN_KEY)]));
    if let Err(e) = moved {
        eprintln!("couldn't move the saved Jira token to its own key: {e}");
    }
    sessions.push(old);
}

/// Once any account has its own key, `jira-token` is stale: restoring it after the last key goes would sign the person
/// back in to an account they left.
fn forget_old_token() {
    if let Err(e) = secrets::delete(TOKEN_KEY) {
        eprintln!("couldn't remove the stale Jira token: {e}");
    }
}

impl Auth {
    /// Restores the saved sessions. If the Keychain can't be read, the app starts signed out rather than failing.
    pub fn load(http: reqwest::Client) -> Self {
        let (sessions, restore_failed) = restore_sessions();
        if sessions.is_empty() && !restore_failed {
            for key in RETIRED_KEYS {
                if let Err(e) = secrets::delete(key) {
                    eprintln!("couldn't remove the old Atlassian sign-in ({key}): {e}");
                }
            }
        }
        Self { authenticator: Arc::new(Atlassian::new(http)), sessions: Mutex::new(sessions), restore_failed }
    }

    /// Whether a saved session was there but couldn't be read, so a signed-out `Auth` doesn't mean nobody was signed in.
    pub fn restore_failed(&self) -> bool {
        self.restore_failed
    }

    #[cfg(test)]
    pub fn signed_out(http: reqwest::Client) -> Self {
        Self { authenticator: Arc::new(Atlassian::new(http)), sessions: Mutex::new(Vec::new()), restore_failed: false }
    }

    #[cfg(test)]
    pub fn with_authenticator(authenticator: Arc<dyn Authenticator>, credentials: Credentials) -> Self {
        Self::with_sessions(authenticator, vec![credentials])
    }

    #[cfg(test)]
    pub fn with_sessions(authenticator: Arc<dyn Authenticator>, sessions: Vec<Credentials>) -> Self {
        Self { authenticator, sessions: Mutex::new(sessions), restore_failed: false }
    }

    #[cfg(test)]
    pub fn signed_in(http: reqwest::Client, credentials: Credentials) -> Self {
        Self::with_authenticator(Arc::new(Atlassian::new(http)), credentials)
    }

    /// The primary session's site and account.
    pub async fn status(&self) -> Result<AuthStatus> {
        let sessions = self.sessions.lock().await;
        let primary = sessions.first();
        Ok(AuthStatus {
            site: primary.map(|s| s.site.clone()),
            me: primary.map(|s| s.me.clone()),
            email: primary.map(|s| s.email.clone()),
            expires_on: primary.map(|s| s.expires_on.clone()),
        })
    }

    pub async fn find_cloud_id(&self, site: &str) -> Result<Option<String>> {
        self.authenticator.find_cloud_id(site).await
    }

    /// Checks `input` against Jira and, only if it works, keeps it in place of every earlier sign-in.
    pub async fn connect(&self, input: &TokenSignIn) -> Result<Connection> {
        let credentials = self.authenticator.connect(input).await?;
        let connection = credentials.connection();
        let mut replaced: Vec<String> = self.sessions.lock().await.iter().map(|s| token_key(&s.connection_id())).collect();
        match secrets::keys_with_prefix(TOKEN_PREFIX) {
            Ok(keys) => replaced.extend(keys),
            Err(e) => eprintln!("couldn't list the saved Jira tokens to replace: {e}"),
        }
        replaced.retain(|key| *key != token_key(&connection.id));
        replaced.sort();
        replaced.dedup();
        let mut ops = vec![saved_op(1, &credentials)?];
        ops.extend(replaced.iter().map(|key| secrets::Op::delete(key)));
        ops.push(secrets::Op::delete(TOKEN_KEY));
        secrets::apply(&ops)?;
        *self.sessions.lock().await = vec![credentials];
        Ok(connection)
    }

    /// Checks `input` against Jira and, only if it works, keeps it beside the earlier sign-ins. An account that is
    /// already signed in gets the new token in its place.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn add(&self, input: &TokenSignIn) -> Result<Connection> {
        let credentials = self.authenticator.connect(input).await?;
        let connection = credentials.connection();
        let key = token_key(&connection.id);
        let keys = secrets::keys_with_prefix(TOKEN_PREFIX)?;
        let next = keys.iter().filter_map(|k| added_of(k).ok().flatten()).max().unwrap_or(0) + 1;
        // A `jira-token` the launch couldn't move goes into this write, or the next launch would drop it.
        let unmoved = match secrets::load::<Credentials>(TOKEN_KEY) {
            Ok(old) => old,
            Err(e) => {
                eprintln!("couldn't read the old Jira token while adding: {e}");
                None
            }
        };
        let mut ops = Vec::new();
        let mut added = match added_of(&key) {
            Ok(Some(added)) => added,
            _ => next,
        };
        if let Some(old) = unmoved {
            if old.connection_id() != connection.id && !keys.contains(&token_key(&old.connection_id())) {
                ops.push(saved_op(next, &old)?);
                if added == next {
                    added = next + 1;
                }
            }
            ops.push(secrets::Op::delete(TOKEN_KEY));
        }
        ops.push(saved_op(added, &credentials)?);
        secrets::apply(&ops)?;
        let mut sessions = self.sessions.lock().await;
        match sessions.iter_mut().find(|s| s.connection_id() == connection.id) {
            Some(existing) => *existing = credentials,
            None => sessions.push(credentials),
        }
        Ok(connection)
    }

    /// Forgets the token of `connection_id`. Nothing happens to the other accounts.
    pub async fn disconnect(&self, connection_id: &str) -> Result<()> {
        let mut ops = vec![secrets::Op::delete(&token_key(connection_id))];
        match secrets::load::<Credentials>(TOKEN_KEY) {
            Ok(Some(old)) if old.connection_id() == connection_id => ops.push(secrets::Op::delete(TOKEN_KEY)),
            Ok(_) => {}
            Err(e) => eprintln!("couldn't read the old Jira token while signing out: {e}"),
        }
        secrets::apply(&ops)?;
        self.sessions.lock().await.retain(|s| s.connection_id() != connection_id);
        Ok(())
    }

    /// The primary session's site and account, if any.
    pub async fn identity(&self) -> Option<(Scope, Site, Account)> {
        self.sessions.lock().await.first().map(|s| (s.scope(), s.site.clone(), s.me.clone()))
    }

    /// The primary connection, if any.
    pub async fn connection(&self) -> Option<Connection> {
        self.sessions.lock().await.first().map(Credentials::connection)
    }

    /// Every signed-in connection, the primary first.
    pub async fn connections(&self) -> Vec<Connection> {
        self.sessions.lock().await.iter().map(Credentials::connection).collect()
    }

    /// The day the saved token of `connection_id` expires, as the person said.
    pub async fn expires_on(&self, connection_id: &str) -> Option<NaiveDate> {
        let sessions = self.sessions.lock().await;
        let session = sessions.iter().find(|s| s.connection_id() == connection_id)?;
        NaiveDate::parse_from_str(&session.expires_on, "%Y-%m-%d").ok()
    }

    /// Asks Jira who the saved token of `connection_id` signs in as, and gives up on Jira's answer after `within`
    /// (`None`).
    pub async fn whoami(&self, connection_id: &str, within: Duration) -> Option<Result<Account>> {
        let token = match self.credentials_for_connection(connection_id).await {
            Ok(token) => token,
            Err(e) => return Some(Err(e)),
        };
        tokio::time::timeout(within, self.authenticator.whoami(&token)).await.ok()
    }

    /// The credentials for `scope`. A scope that isn't signed in is refused, so work started for one account can
    /// never run as another.
    pub async fn credentials_for(&self, scope: &SiteScope) -> Result<AccessToken> {
        let sessions = self.sessions.lock().await;
        if sessions.is_empty() {
            return Err(Error::NotSignedIn);
        }
        sessions.iter().find(|s| &s.site_scope() == scope).map(Credentials::access_token).ok_or(Error::SiteChanged)
    }

    async fn credentials_for_connection(&self, connection_id: &str) -> Result<AccessToken> {
        let sessions = self.sessions.lock().await;
        sessions.iter().find(|s| s.connection_id() == connection_id).map(Credentials::access_token).ok_or(Error::NotSignedIn)
    }
}

pub async fn json_or_error<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    let status = res.status();
    if status.is_success() {
        return Ok(res.json().await?);
    }
    // Not `String::truncate`, which panics when byte 300 falls inside a character.
    let message: String = res.text().await.unwrap_or_default().chars().take(300).collect();
    Err(Error::Api { status: status.as_u16(), message })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn credentials() -> Credentials {
        Credentials {
            email: "ann@acme.com".into(),
            token: "secret-token".into(),
            expires_on: "2027-10-30".into(),
            site: Site { cloud_id: "c1".into(), name: "acme.atlassian.net".into(), url: "https://acme.atlassian.net".into() },
            me: Account { account_id: "u1".into(), name: "Ann".into(), avatar_url: None },
        }
    }

    #[test]
    fn a_saved_token_names_its_connection_after_the_site_and_the_account() {
        let c = credentials();
        assert_eq!(c.connection().id, "jira:c1:u1");
        assert_eq!(c.connection().display_name, "acme.atlassian.net");
        assert_eq!(c.scope(), Scope { connection_id: "jira:c1:u1".into(), account_id: "u1".into() });
        assert_eq!(c.site_scope(), SiteScope { cloud_id: "c1".into(), account_id: "u1".into() });
    }

    fn restore_everything() -> (bool, usize) {
        let http = reqwest::Client::new();
        let auth = Auth::load(http.clone());
        let signed_in = !auth.sessions.try_lock().unwrap().is_empty();
        (signed_in, GithubAuth::new(http).logins().len())
    }

    #[test]
    fn a_normal_launch_reads_the_keychain_once_and_writes_nothing() {
        let fake = secrets::fake::Fake::default();
        let _installed = secrets::fake::install(&fake);
        secrets::save(&token_key("jira:c1:u1"), &credentials()).unwrap();
        secrets::save("github-logins", &vec!["ann", "bob"]).unwrap();
        restore_everything();

        let _relaunched = secrets::fake::install(&fake);
        fake.reset_counts();
        assert_eq!(restore_everything(), (true, 2));
        assert_eq!((fake.reads(), fake.writes(), fake.removes()), (1, 0, 0));
    }

    #[test]
    fn launching_with_only_the_old_atlassian_sign_in_starts_signed_out_and_forgets_it() {
        let fake = secrets::fake::Fake::default();
        let _installed = secrets::fake::install(&fake);
        let old = r#"{"tokens":{"access_token":"a","refresh_token":"r","expires_at":5},"site":{"cloudId":"c1","name":"Acme","url":"https://acme.atlassian.net"},"me":{"accountId":"u1","name":"Ann","avatarUrl":null}}"#;
        fake.put("session", old);
        fake.put("oauth-app", r#"{"client_id":"id","client_secret":"secret"}"#);
        fake.put("github-logins", r#"["ann"]"#);
        fake.put("github:ann", "{}");
        assert_eq!(restore_everything(), (false, 1));
        for retired in ["session", "oauth-app"] {
            assert_eq!(fake.get(retired), None);
            assert!(secrets::load::<Value>(retired).unwrap().is_none());
        }

        let _relaunched = secrets::fake::install(&fake);
        fake.reset_counts();
        assert_eq!(restore_everything(), (false, 1));
        assert_eq!((fake.reads(), fake.writes()), (1, 0));
    }

    #[test]
    fn a_denied_keychain_starts_signed_out_and_is_asked_once() {
        let fake = secrets::fake::Fake::default();
        fake.deny_reads_of("vault");
        let _installed = secrets::fake::install(&fake);
        assert_eq!(restore_everything(), (false, 0));
        assert_eq!(fake.reads(), 1);
    }

    /// Knows only `ann@acme.com`, answers after `answer_after`, and keeps no state.
    struct Slow {
        answer_after: Duration,
    }

    #[async_trait]
    impl Authenticator for Slow {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, _: &TokenSignIn) -> Result<Credentials> {
            Ok(credentials())
        }
        async fn whoami(&self, token: &AccessToken) -> Result<Account> {
            tokio::time::sleep(self.answer_after).await;
            if token.token == "secret-token" {
                Ok(credentials().me)
            } else {
                Err(Error::Api { status: 401, message: "revoked".into() })
            }
        }
    }

    #[tokio::test]
    async fn jira_not_answering_in_time_is_none_and_leaves_the_session_as_it_was() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let auth = Auth::with_authenticator(Arc::new(Slow { answer_after: Duration::from_secs(30) }), credentials());
        assert!(auth.whoami("jira:c1:u1", Duration::from_millis(30)).await.is_none());
        assert!(auth.identity().await.is_some());
        assert_eq!(fake.writes(), 0);
    }

    #[tokio::test]
    async fn connecting_keeps_the_token_in_the_keychain_and_replaces_the_earlier_session() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let auth = Auth::with_authenticator(Arc::new(Slow { answer_after: Duration::ZERO }), Credentials { token: "old".into(), ..credentials() });
        let input = TokenSignIn { site: "acme".into(), cloud_id: None, email: "ann@acme.com".into(), token: "secret-token".into(), expires_on: "2027-10-30".into() };
        assert_eq!(auth.connect(&input).await.unwrap().id, "jira:c1:u1");
        assert_eq!(secrets::load::<Credentials>(&token_key("jira:c1:u1")).unwrap().unwrap().token, "secret-token");
        assert_eq!(auth.credentials_for(&credentials().site_scope()).await.unwrap().token, "secret-token");
    }

    struct Refusing;

    #[async_trait]
    impl Authenticator for Refusing {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, _: &TokenSignIn) -> Result<Credentials> {
            Err(Error::Auth("Jira didn't accept that email and token.".into()))
        }
        async fn whoami(&self, _: &AccessToken) -> Result<Account> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn a_token_that_does_not_work_leaves_the_earlier_session_and_the_keychain_alone() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        secrets::save(&token_key("jira:c1:u1"), &credentials()).unwrap();
        let auth = Auth::with_authenticator(Arc::new(Refusing), credentials());
        let input = TokenSignIn { site: "acme".into(), cloud_id: None, email: "x".into(), token: "bad".into(), expires_on: "2027-10-30".into() };
        assert!(auth.connect(&input).await.is_err());
        assert!(auth.add(&input).await.is_err());
        assert_eq!(auth.credentials_for(&credentials().site_scope()).await.unwrap().token, "secret-token");
        assert_eq!(secrets::load::<Credentials>(&token_key("jira:c1:u1")).unwrap().unwrap().token, "secret-token");
    }

    #[tokio::test]
    async fn disconnecting_the_only_account_forgets_its_token() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        secrets::save(&token_key("jira:c1:u1"), &credentials()).unwrap();
        let auth = Auth::with_authenticator(Arc::new(Refusing), credentials());
        auth.disconnect("jira:c1:u1").await.unwrap();
        assert!(matches!(auth.credentials_for(&credentials().site_scope()).await, Err(Error::NotSignedIn)));
        assert!(secrets::load::<Credentials>(&token_key("jira:c1:u1")).unwrap().is_none());
    }

    #[tokio::test]
    async fn the_expiry_day_is_what_the_person_said() {
        let auth = Auth::with_authenticator(Arc::new(Refusing), credentials());
        assert_eq!(auth.expires_on("jira:c1:u1").await, NaiveDate::from_ymd_opt(2027, 10, 30));
    }

    fn account(site: &str, account: &str, token: &str) -> Credentials {
        Credentials {
            email: format!("{account}@example.com"),
            token: token.into(),
            expires_on: format!("2027-1{}-01", token.len() % 3),
            site: Site { cloud_id: site.into(), name: format!("{site}.atlassian.net"), url: format!("https://{site}.atlassian.net") },
            me: Account { account_id: account.into(), name: account.into(), avatar_url: None },
        }
    }

    fn sign_in_as(c: &Credentials) -> TokenSignIn {
        TokenSignIn { site: c.site.name.clone(), cloud_id: None, email: c.email.clone(), token: c.token.clone(), expires_on: c.expires_on.clone() }
    }

    /// Signs in as whichever of `known` has the token it is given.
    struct Roster(Vec<Credentials>);

    #[async_trait]
    impl Authenticator for Roster {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, input: &TokenSignIn) -> Result<Credentials> {
            self.0.iter().find(|c| c.token == input.token).cloned().ok_or_else(|| Error::Auth("no".into()))
        }
        async fn whoami(&self, token: &AccessToken) -> Result<Account> {
            self.0.iter().find(|c| c.token == token.token).map(|c| c.me.clone()).ok_or(Error::Api { status: 401, message: "revoked".into() })
        }
    }

    fn two_on_acme_one_on_globex() -> [Credentials; 3] {
        [account("acme", "ann", "t-ann"), account("acme", "bob", "t-bob"), account("globex", "ann2", "t-ann2")]
    }

    #[tokio::test]
    async fn two_accounts_on_one_site_and_one_on_another_each_get_their_own_credentials() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![])), vec![]);
        auth.sessions.lock().await.push(ann.clone());
        auth.sessions.lock().await.push(bob.clone());
        auth.sessions.lock().await.push(globex.clone());

        for c in [&ann, &bob, &globex] {
            let token = auth.credentials_for(&c.site_scope()).await.unwrap();
            assert_eq!((token.token.as_str(), token.email.as_str()), (c.token.as_str(), c.email.as_str()));
        }
        let unknown = account("acme", "cy", "t").site_scope();
        assert!(matches!(auth.credentials_for(&unknown).await, Err(Error::SiteChanged)));
    }

    #[tokio::test]
    async fn adding_accounts_keeps_each_in_the_keychain_and_status_reports_the_first() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![ann.clone(), bob.clone(), globex.clone()])), vec![]);
        for c in [&ann, &bob, &globex] {
            assert_eq!(auth.add(&sign_in_as(c)).await.unwrap().id, c.connection_id());
        }

        assert_eq!(secrets::keys_with_prefix(TOKEN_PREFIX).unwrap(), ["jira-token:jira:acme:ann", "jira-token:jira:acme:bob", "jira-token:jira:globex:ann2"]);
        assert_eq!(auth.status().await.unwrap().me.unwrap().account_id, "ann");
        assert_eq!(auth.connection().await.unwrap().id, "jira:acme:ann");
        assert_eq!(auth.identity().await.unwrap().0.account_id, "ann");
    }

    #[tokio::test]
    async fn adding_an_account_that_is_already_there_replaces_its_token_and_keeps_its_place() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, _] = two_on_acme_one_on_globex();
        let renewed = Credentials { token: "t-ann-new".into(), ..ann.clone() };
        let auth = Auth::with_sessions(Arc::new(Roster(vec![renewed.clone()])), vec![ann, bob]);
        auth.add(&sign_in_as(&renewed)).await.unwrap();

        assert_eq!(auth.sessions.lock().await.len(), 2);
        assert_eq!(auth.credentials_for(&renewed.site_scope()).await.unwrap().token, "t-ann-new");
        assert_eq!(auth.connection().await.unwrap().id, "jira:acme:ann");
    }

    #[tokio::test]
    async fn disconnecting_one_account_leaves_the_others_signed_in_and_saved() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        for c in [&ann, &bob, &globex] {
            secrets::save(&token_key(&c.connection_id()), c).unwrap();
        }
        let auth = Auth::with_sessions(Arc::new(Refusing), vec![ann.clone(), bob.clone(), globex.clone()]);
        auth.disconnect(&ann.connection_id()).await.unwrap();

        assert!(matches!(auth.credentials_for(&ann.site_scope()).await, Err(Error::SiteChanged)));
        assert_eq!(auth.credentials_for(&bob.site_scope()).await.unwrap().token, "t-bob");
        assert_eq!(auth.credentials_for(&globex.site_scope()).await.unwrap().token, "t-ann2");
        assert_eq!(auth.connection().await.unwrap().id, "jira:acme:bob");
        assert_eq!(secrets::keys_with_prefix(TOKEN_PREFIX).unwrap(), ["jira-token:jira:acme:bob", "jira-token:jira:globex:ann2"]);
    }

    #[tokio::test]
    async fn whoami_and_the_expiry_day_are_asked_per_connection() {
        let [ann, bob, _] = two_on_acme_one_on_globex();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![ann.clone(), bob.clone()])), vec![ann.clone(), bob.clone()]);

        let within = Duration::from_secs(5);
        assert_eq!(auth.whoami("jira:acme:bob", within).await.unwrap().unwrap().account_id, "bob");
        assert_eq!(auth.whoami("jira:acme:ann", within).await.unwrap().unwrap().account_id, "ann");
        assert!(matches!(auth.whoami("jira:acme:cy", within).await, Some(Err(Error::NotSignedIn))));
        assert_eq!(auth.expires_on("jira:acme:ann").await, NaiveDate::parse_from_str(&ann.expires_on, "%Y-%m-%d").ok());
        assert_eq!(auth.expires_on("jira:acme:bob").await, NaiveDate::parse_from_str(&bob.expires_on, "%Y-%m-%d").ok());
        assert_eq!(auth.expires_on("jira:acme:cy").await, None);
    }

    #[tokio::test]
    async fn connect_replaces_every_earlier_session_and_removes_their_tokens_in_one_write() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        for c in [&ann, &bob] {
            secrets::save(&token_key(&c.connection_id()), c).unwrap();
        }
        let auth = Auth::with_sessions(Arc::new(Roster(vec![globex.clone()])), vec![ann.clone(), bob.clone()]);
        fake.reset_counts();
        assert_eq!(auth.connect(&sign_in_as(&globex)).await.unwrap().id, "jira:globex:ann2");

        assert_eq!(fake.writes(), 1);
        assert_eq!(auth.sessions.lock().await.len(), 1);
        assert_eq!(secrets::keys_with_prefix(TOKEN_PREFIX).unwrap(), ["jira-token:jira:globex:ann2"]);
    }

    #[test]
    fn every_saved_account_is_restored_by_listing_the_prefix() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        for c in [&ann, &bob, &globex] {
            secrets::save(&token_key(&c.connection_id()), c).unwrap();
        }
        let _relaunched = secrets::fake::install(&fake);
        let (sessions, failed) = restore_sessions();
        assert_eq!((sessions.iter().map(Credentials::connection_id).collect::<Vec<_>>(), failed), (["jira:acme:ann", "jira:acme:bob", "jira:globex:ann2"].map(String::from).to_vec(), false));
    }

    fn launch_with_old_token_only(fake: &secrets::fake::Fake) -> secrets::fake::Installed {
        let earlier_launch = secrets::fake::install(fake);
        secrets::save(TOKEN_KEY, &credentials()).unwrap();
        drop(earlier_launch);
        secrets::fake::install(fake)
    }

    fn vault_holds(key: &str) -> bool {
        secrets::load::<Credentials>(key).unwrap().is_some()
    }

    #[test]
    fn the_old_token_moves_to_its_connections_key_in_one_write() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        fake.reset_counts();
        let (sessions, failed) = restore_sessions();

        assert_eq!((sessions.len(), failed), (1, false));
        assert_eq!(fake.writes(), 1);
        assert!(vault_holds(&token_key("jira:c1:u1")) && !vault_holds(TOKEN_KEY));
    }

    #[test]
    fn the_move_runs_twice_without_changing_anything_the_second_time() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        restore_sessions();
        let _relaunched = secrets::fake::install(&fake);
        fake.reset_counts();
        let (sessions, failed) = restore_sessions();

        assert_eq!((sessions.len(), failed, fake.writes()), (1, false, 0));
        assert!(vault_holds(&token_key("jira:c1:u1")) && !vault_holds(TOKEN_KEY));
    }

    #[test]
    fn nothing_moves_while_the_vault_cant_be_read() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        fake.deny_reads_of("vault");
        let _relaunched = secrets::fake::install(&fake);
        fake.reset_counts();
        let (sessions, failed) = restore_sessions();

        assert_eq!((sessions.len(), failed, fake.writes()), (0, true, 0));
        fake.deny_reads_of("none");
        let _readable = secrets::fake::install(&fake);
        assert!(vault_holds(TOKEN_KEY) && !vault_holds(&token_key("jira:c1:u1")));
    }

    #[test]
    fn a_failed_write_keeps_the_old_layout_and_the_session_works_until_the_move_runs_again() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        fake.deny_writes(true);
        let _relaunched = secrets::fake::install(&fake);
        let (sessions, failed) = restore_sessions();
        assert_eq!((sessions.len(), failed), (1, false));
        assert!(vault_holds(TOKEN_KEY) && !vault_holds(&token_key("jira:c1:u1")));

        fake.deny_writes(false);
        let _next_launch = secrets::fake::install(&fake);
        let (sessions, _) = restore_sessions();
        assert_eq!(sessions.len(), 1);
        assert!(vault_holds(&token_key("jira:c1:u1")) && !vault_holds(TOKEN_KEY));
    }

    #[test]
    fn the_old_token_is_not_restored_beside_accounts_that_already_have_keys_and_is_forgotten() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let other = account("globex", "ann2", "t-ann2");
        secrets::save(&token_key(&other.connection_id()), &other).unwrap();
        let _relaunched = secrets::fake::install(&fake);
        let (sessions, _) = restore_sessions();

        assert_eq!(sessions.iter().map(Credentials::connection_id).collect::<Vec<_>>(), ["jira:globex:ann2"]);
        assert!(!vault_holds(TOKEN_KEY) && !vault_holds(&token_key("jira:c1:u1")));
    }

    #[test]
    fn the_old_token_is_kept_while_a_saved_token_cant_be_read() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let other = account("globex", "ann2", "t-ann2");
        secrets::save(&token_key(&other.connection_id()), &other).unwrap();
        secrets::save(&token_key("jira:c1:u1"), &"not credentials").unwrap();
        let _relaunched = secrets::fake::install(&fake);
        let (sessions, failed) = restore_sessions();

        assert_eq!((sessions.len(), failed), (1, true));
        assert!(vault_holds(TOKEN_KEY));
    }

    #[test]
    fn a_key_the_connection_already_has_is_never_overwritten() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let newer = Credentials { token: "newer".into(), ..credentials() };
        secrets::save(&token_key("jira:c1:u1"), &newer).unwrap();
        let _relaunched = secrets::fake::install(&fake);
        let (sessions, _) = restore_sessions();

        assert_eq!((sessions.len(), sessions[0].token.as_str()), (1, "newer"));
        assert_eq!(secrets::load::<Credentials>(&token_key("jira:c1:u1")).unwrap().unwrap().token, "newer");
        assert!(!vault_holds(TOKEN_KEY));
    }

    fn relaunch_after_a_failed_move(fake: &secrets::fake::Fake) -> (secrets::fake::Installed, Auth) {
        fake.deny_writes(true);
        let vault = secrets::fake::install(fake);
        let (sessions, _) = restore_sessions();
        fake.deny_writes(false);
        (vault, Auth::with_sessions(Arc::new(Roster(vec![account("globex", "ann2", "t-ann2")])), sessions))
    }

    #[tokio::test]
    async fn signing_out_after_a_failed_move_stays_signed_out_on_the_next_launch() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let (_launch, auth) = relaunch_after_a_failed_move(&fake);
        auth.disconnect("jira:c1:u1").await.unwrap();

        assert!(!vault_holds(TOKEN_KEY));
        let _next_launch = secrets::fake::install(&fake);
        assert_eq!(restore_sessions().0.len(), 0);
    }

    #[tokio::test]
    async fn connecting_another_account_after_a_failed_move_leaves_one_session_on_the_next_launch() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let (_launch, auth) = relaunch_after_a_failed_move(&fake);
        let globex = account("globex", "ann2", "t-ann2");
        auth.connect(&sign_in_as(&globex)).await.unwrap();

        assert!(!vault_holds(TOKEN_KEY));
        let _next_launch = secrets::fake::install(&fake);
        let (sessions, _) = restore_sessions();
        assert_eq!(sessions.iter().map(Credentials::connection_id).collect::<Vec<_>>(), ["jira:globex:ann2"]);
    }

    #[tokio::test]
    async fn disconnecting_another_account_keeps_the_old_token_that_was_not_moved() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let (_launch, auth) = relaunch_after_a_failed_move(&fake);
        auth.disconnect("jira:globex:ann2").await.unwrap();

        assert!(vault_holds(TOKEN_KEY));
    }

    #[tokio::test]
    async fn adding_an_account_after_a_failed_move_keeps_the_old_one_on_the_next_launch() {
        let fake = secrets::fake::Fake::default();
        let _vault = launch_with_old_token_only(&fake);
        let (_launch, auth) = relaunch_after_a_failed_move(&fake);
        auth.add(&sign_in_as(&account("globex", "ann2", "t-ann2"))).await.unwrap();

        assert!(!vault_holds(TOKEN_KEY));
        let _next_launch = secrets::fake::install(&fake);
        let ids: Vec<_> = restore_sessions().0.iter().map(Credentials::connection_id).collect();
        assert_eq!(ids, ["jira:c1:u1", "jira:globex:ann2"]);
    }

    #[tokio::test]
    async fn adding_an_account_whose_saved_key_is_unreadable_replaces_it() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let globex = account("globex", "ann2", "t-ann2");
        secrets::save(&token_key(&globex.connection_id()), &"not credentials").unwrap();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![globex.clone()])), vec![]);
        auth.add(&sign_in_as(&globex)).await.unwrap();

        assert_eq!(restore_sessions().0.len(), 1);
    }

    #[tokio::test]
    async fn an_unreadable_old_token_does_not_block_signing_out() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let globex = account("globex", "ann2", "t-ann2");
        secrets::save(&token_key(&globex.connection_id()), &globex).unwrap();
        secrets::save(TOKEN_KEY, &"not credentials").unwrap();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![])), vec![globex.clone()]);
        auth.disconnect(&globex.connection_id()).await.unwrap();

        assert!(secrets::keys_with_prefix(TOKEN_PREFIX).unwrap().is_empty());
    }

    #[tokio::test]
    async fn connect_removes_tokens_the_vault_holds_that_this_run_never_loaded() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        secrets::save(&token_key(&ann.connection_id()), &ann).unwrap();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![bob.clone(), globex])), vec![]);
        auth.connect(&sign_in_as(&bob)).await.unwrap();

        assert_eq!(secrets::keys_with_prefix(TOKEN_PREFIX).unwrap(), ["jira-token:jira:acme:bob"]);
    }

    #[tokio::test]
    async fn the_primary_is_the_account_added_first_after_a_relaunch() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let [ann, bob, globex] = two_on_acme_one_on_globex();
        let auth = Auth::with_sessions(Arc::new(Roster(vec![ann.clone(), bob.clone(), globex.clone()])), vec![]);
        for c in [&globex, &bob, &ann] {
            auth.add(&sign_in_as(c)).await.unwrap();
        }
        auth.add(&sign_in_as(&bob)).await.unwrap();
        assert_eq!(auth.connection().await.unwrap().id, "jira:globex:ann2");

        let _relaunched = secrets::fake::install(&fake);
        let (sessions, _) = restore_sessions();
        assert_eq!(sessions.iter().map(Credentials::connection_id).collect::<Vec<_>>(), ["jira:globex:ann2", "jira:acme:bob", "jira:acme:ann"]);
    }
}
