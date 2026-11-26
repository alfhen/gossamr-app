//! A harness served in the test's own process, from a temp data folder, on the mock provider.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use harness::api::Op;
use harness::auth::Token;
use harness::client::Client;
use harness::driver::Driver;
use harness::mock::{Mock, Script};
use harness::server::Server;
use harness::session::Settings;

use super::Connect;

pub const WAIT: Duration = Duration::from_secs(20);

pub struct Served {
    pub _tmp: tempfile::TempDir,
    pub dir: PathBuf,
    pub token: Token,
    task: Option<tokio::task::JoinHandle<harness::error::Result<()>>>,
    /// The provider, kept over a restart as a real one keeps its sessions, so a session can be resumed.
    mock: Option<Mock>,
}

impl Served {
    pub fn new(script: &str, turn_limit: usize) -> Served {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("h");
        let token = Token::random();
        let mut served = Served { _tmp: tmp, dir, token, task: None, mock: None };
        served.serve(script, turn_limit);
        served
    }

    /// Serves the data folder, again after a shutdown.
    /// Serves the data folder, again after a shutdown with the same provider, so its sessions can be resumed.
    pub fn serve(&mut self, script: &str, turn_limit: usize) {
        let mock = self.mock.get_or_insert_with(|| Mock::new(Script::parse(script).unwrap())).clone();
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        // Once its lock is free: just after a shutdown, a child another test's thread is starting holds a copy of the
        // lock's descriptor until it execs.
        let given = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let server = loop {
            let first = self.token.clone();
            match Server::bind(&self.dir, move || Some(first), drivers.clone(), Settings { turn_limit, ..Settings::default() }) {
                Err(harness::error::Error::InUse(_)) if std::time::Instant::now() < given => std::thread::sleep(std::time::Duration::from_millis(10)),
                bound => break bound.unwrap(),
            }
        };
        self.task = Some(tokio::spawn(server.run()));
    }

    /// Serves with what the harness knows of the machine: a home folder and a shell, for sessions that name a repo.
    pub fn serve_on(&mut self, script: &str, turn_limit: usize, setup: harness::work::Setup) {
        self.serve_as(script, turn_limit, setup, "mock");
    }

    /// `serve_on`, with the mock under `provider`'s name, so the app opens it as it opens that provider.
    pub fn serve_as(&mut self, script: &str, turn_limit: usize, setup: harness::work::Setup, provider: &str) {
        let mock = Mock::new(Script::parse(script).unwrap());
        self.mock = Some(mock.clone());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![(provider.into(), Arc::new(mock))];
        let first = self.token.clone();
        let server = Server::bind_with(&self.dir, move || Some(first), drivers, Settings { turn_limit, ..Settings::default() }, setup).unwrap();
        self.task = Some(tokio::spawn(server.run()));
    }

    /// Not serving yet, for `serve_on`.
    pub fn idle() -> Served {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("h");
        Served { _tmp: tmp, dir, token: Token::random(), task: None, mock: None }
    }

    pub async fn client(&self) -> Client {
        Client::connect(&self.dir, &self.token).await.unwrap()
    }

    /// Stops the harness through its own `shutdown` and waits until it has freed the data folder.
    pub async fn shut_down(&mut self) {
        let mut client = self.client().await;
        client.call(Op::Shutdown).await.unwrap();
        tokio::time::timeout(WAIT, self.task.take().unwrap()).await.unwrap().unwrap().unwrap();
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Connects with the test's token.
pub struct Direct {
    pub dir: PathBuf,
    pub token: Token,
}

#[async_trait]
impl Connect for Direct {
    async fn connect(&self) -> Result<Client, String> {
        Client::connect(&self.dir, &self.token).await.map_err(|e| e.to_string())
    }
}

