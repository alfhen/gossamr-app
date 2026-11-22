//! `harness run --provider mock`: one session in-process, its events printed as JSON lines. The mock's script holds
//! what its recorded client did, and `run` does the same where the mock waits: it sends the recorded prompt (the
//! command line's prompt first), answers as `--answer` says or else as recorded, posts the recorded tool result and
//! cancels where the recording cancelled.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, watch};

use crate::error::{Error, Result};
use crate::event::{Body, Decision, Event};
use crate::mock::{ClientAction, Mock, Script};
use crate::session::{DEFAULT_TURN_LIMIT, Harness, Open};
use crate::store::{Store, default_dir};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunArgs {
    pub script: PathBuf,
    pub data: Option<PathBuf>,
    pub answers: Vec<Decision>,
    pub prompt: Option<String>,
}

/// Runs the session to its end. True when no event was a failure.
pub async fn run(args: RunArgs) -> Result<bool> {
    let script = Script::load(&args.script).map_err(Error::Driver)?;
    let dir = args.data.or_else(default_dir).ok_or_else(|| Error::Driver("no data folder: set HARNESS_DATA".into()))?;
    let mock = Mock::new(script);
    let harness = Harness::new(Store::open(&dir)?, vec![("mock".into(), Arc::new(mock.clone()))], DEFAULT_TURN_LIMIT);
    let client = mock.client();
    let cwd = std::env::current_dir()?;
    let (id, events) = harness.open(Open { provider: "mock".into(), locked: false, cwd, model: None })?;
    let mut ok = true;
    drive(&harness, &id, events, client, args.answers, args.prompt, |event| {
        println!("{}", serde_json::to_string(event).expect("an event always serializes"));
        ok &= !matches!(event.body, Body::Failed { .. });
    })
    .await;
    Ok(ok)
}

/// Acts as the mock's recorded client until the session closes, and hands every event to `seen`. `answers` come
/// before the recorded ones, and `prompt` before the first recorded prompt.
pub async fn drive(
    harness: &Harness,
    id: &str,
    mut events: broadcast::Receiver<Event>,
    mut client: watch::Receiver<Option<ClientAction>>,
    answers: Vec<Decision>,
    mut prompt: Option<String>,
    mut seen: impl FnMut(&Event),
) {
    let mut answers = answers.into_iter();
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    seen(&event);
                    if event.body == Body::Closed {
                        return;
                    }
                }
                Err(RecvError::Lagged(missed)) => eprintln!("harness: {missed} events missed"),
                Err(RecvError::Closed) => return,
            },
            Ok(()) = client.changed() => {
                let action = client.borrow_and_update().clone();
                let done = match action {
                    Some(ClientAction::Prompt(recorded)) => match prompt.take().or(recorded) {
                        Some(text) => harness.send(id, text),
                        None => harness.close(id),
                    },
                    Some(ClientAction::Answer { id: request, decision }) => {
                        harness.answer(id, &request, answers.next().or(decision).unwrap_or(Decision::Deny))
                    }
                    Some(ClientAction::ToolResult { id: call, output }) => {
                        harness.tool_result(id, &call, output.unwrap_or(Value::Null), false)
                    }
                    Some(ClientAction::Cancel) => harness.cancel(id),
                    None => Ok(()),
                };
                if let Err(e) = done {
                    eprintln!("harness: {e}");
                }
            }
        }
    }
}
