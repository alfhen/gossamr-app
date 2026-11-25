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
}

impl Served {
    pub fn new(script: &str, turn_limit: usize) -> Served {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("h");
        let token = Token::random();
        let mut served = Served { _tmp: tmp, dir, token, task: None };
        served.serve(script, turn_limit);
        served
    }

    /// Serves the data folder, again after a shutdown.
    pub fn serve(&mut self, script: &str, turn_limit: usize) {
        let mock = Mock::new(Script::parse(script).unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let first = self.token.clone();
        let server = Server::bind(&self.dir, move || Some(first), drivers, Settings { turn_limit, ..Settings::default() }).unwrap();
        self.task = Some(tokio::spawn(server.run()));
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

