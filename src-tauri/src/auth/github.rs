//! GitHub accounts. `gh` holds the sign-in and Gossamr asks it for the token each time (see `gh.rs`). The Keychain
//! holds only what an earlier build saved: a token per login and an index of the logins.

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::header::ACCEPT;
use serde::Deserialize;

use super::gh::{gh_token, path_dirs, CredentialSource, GhCredentials};
use crate::codehost::github::{error_message, API_BASE};
use crate::codehost::CodeAccount;
use crate::error::{Error, Result};
use crate::secrets;
use crate::tracker::Connection;

const INDEX_KEY: &str = "github-logins";
const HOST: &str = "github.com";

/// A GitHub account Gossamr is connected to.
#[derive(Clone, Debug)]
pub struct GithubSession {
    pub login: String,
    pub name: Option<String>,
}

impl GithubSession {
    pub fn connection(&self) -> Connection {
        Connection::github(&self.login, &self.login)
    }
}

fn entry(login: &str) -> String {
    format!("github:{}", login.to_ascii_lowercase())
}

pub struct GithubAuth {
    http: reqwest::Client,
    api: String,
    gh_dirs: Vec<PathBuf>,
}

impl GithubAuth {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, api: API_BASE.into(), gh_dirs: path_dirs() }
    }

    #[cfg(test)]
    pub fn for_test(http: reqwest::Client, base: &str, gh_dirs: Vec<PathBuf>) -> Self {
        Self { http, api: base.into(), gh_dirs }
    }

    pub fn gh_dirs(&self) -> &[PathBuf] {
        &self.gh_dirs
    }

    /// Where requests for `login` get their token.
    pub fn credentials(&self, login: &str) -> Arc<dyn CredentialSource> {
        Arc::new(GhCredentials::new(&self.gh_dirs, HOST, login))
    }

    /// Asks GitHub who `token` belongs to, which also proves it works.
    pub async fn validate(&self, token: &str) -> Result<CodeAccount> {
        let res = self.http.get(format!("{}/user", self.api)).bearer_auth(token).header(ACCEPT, "application/vnd.github+json").send().await?;
        let status = res.status();
        let h = res.headers().clone();
        let scopes = h
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect());
        let body = res.text().await?;
        if !status.is_success() {
            return Err(crate::codehost::github::http::error_for(status.as_u16(), &h, &body, chrono::Utc::now().timestamp()));
        }
        #[derive(Deserialize)]
        struct User {
            login: String,
            name: Option<String>,
            avatar_url: Option<String>,
        }
        let user: User = serde_json::from_str(&body).map_err(|_| Error::Auth(error_message(&body)))?;
        Ok(CodeAccount { login: user.login, name: user.name, avatar_url: user.avatar_url, scopes })
    }

    /// Reads `gh`'s token for `login` (the active account when none is named) and checks GitHub accepts it. The token is
    /// dropped; later requests ask `gh` again.
    pub async fn connect(&self, login: Option<&str>) -> Result<GithubSession> {
        let token = gh_token(&self.gh_dirs, HOST, login).await?;
        let account = self.validate(&token).await?;
        Ok(GithubSession { login: account.login, name: account.name })
    }

    /// The logins an earlier build saved a token for, in the order they were first signed in. An unreadable index is an
    /// error, not an empty list.
    pub fn try_logins(&self) -> Result<Vec<String>> {
        Ok(secrets::load(INDEX_KEY)?.unwrap_or_default())
    }

    /// The saved logins, or none when the index can't be read.
    pub fn logins(&self) -> Vec<String> {
        self.try_logins().unwrap_or_else(|e| {
            eprintln!("couldn't read the saved GitHub sign-ins: {e}");
            Vec::new()
        })
    }

    /// Deletes the token an earlier build saved for `login`. It does nothing when there is none.
    pub fn forget_saved_token(&self, login: &str) -> Result<()> {
        let mut logins = self.try_logins()?;
        if !logins.iter().any(|l| l.eq_ignore_ascii_case(login)) {
            return Ok(());
        }
        secrets::delete(&entry(login))?;
        logins.retain(|l| !l.eq_ignore_ascii_case(login));
        secrets::save(INDEX_KEY, &logins)
    }
}

#[cfg(test)]
mod tests {
    use super::super::gh::fake_gh;
    use super::*;
    use crate::codehost::github::testserver::{serve, Reply, Server};

    const USER: &str = include_str!("../codehost/github/fixtures/user.json");

    fn auth(server: &Server, token: &str) -> GithubAuth {
        GithubAuth::for_test(reqwest::Client::new(), &server.base, fake_gh(token))
    }

    #[tokio::test]
    async fn connecting_reads_the_token_from_gh_and_names_the_account_github_says_it_belongs_to() {
        let server = serve(vec![("/user", vec![Reply::ok(USER)])]).await;
        let session = auth(&server, "gho_fromgh").connect(Some("ann")).await.unwrap();
        assert_eq!((session.login.as_str(), session.name.as_deref()), ("ann", Some("Ann Example")));
        assert_eq!(session.connection().id, "github:ann");
        assert_eq!(server.header_of(0, "authorization").as_deref(), Some("Bearer gho_fromgh"));
    }

    #[tokio::test]
    async fn a_token_github_refuses_connects_nothing() {
        let server = serve(vec![("/user", vec![Reply::status(401, "{\"message\":\"Bad credentials\"}")])]).await;
        let err = auth(&server, "gho_old").connect(None).await.unwrap_err();
        assert!(err.is_unauthorized() && err.to_string().contains("didn't accept the token"), "{err}");
    }

    #[tokio::test]
    async fn an_sso_enforced_token_is_told_to_authorise_the_organisation() {
        let reply = Reply::status(403, "{\"message\":\"Resource protected by organization SAML enforcement.\"}").header("x-github-sso", "required; url=https://github.com/orgs/acme/sso?authorization_request=x");
        let server = serve(vec![("/user", vec![reply])]).await;
        let err = auth(&server, "gho_x").connect(None).await.unwrap_err().to_string();
        assert!(err.contains("https://github.com/orgs/acme/sso") && err.contains("authorise"), "{err}");
    }

    #[tokio::test]
    async fn gh_having_no_token_connects_nothing_and_never_reaches_github() {
        let server = serve(vec![]).await;
        let silent = GithubAuth::for_test(reqwest::Client::new(), &server.base, fake_gh("unused"));
        std::fs::write(silent.gh_dirs()[0].join("gh"), "#!/bin/sh\nexit 1\n").unwrap();
        let err = silent.connect(Some("ann")).await.unwrap_err();
        assert!(err.is_unauthorized() && err.to_string().contains("gh auth login -h github.com"), "{err}");
        assert!(server.targets().is_empty());
    }

    #[test]
    fn forgetting_a_saved_token_removes_its_entry_and_its_place_in_the_index_and_nothing_else() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        secrets::save(INDEX_KEY, &vec!["Ann".to_string(), "bob".into()]).unwrap();
        fake.put("github:ann", "{}");
        fake.put("github:bob", "{}");
        let auth = GithubAuth::new(reqwest::Client::new());
        auth.forget_saved_token("ANN").unwrap();
        assert_eq!(auth.logins(), ["bob"]);
        assert_eq!((fake.get("github:ann"), fake.get("github:bob").is_some()), (None, true));

        fake.reset_counts();
        auth.forget_saved_token("ann").unwrap();
        assert_eq!((fake.writes(), fake.removes()), (0, 0), "a login with no saved token costs no write");
    }
}
