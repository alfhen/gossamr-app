//! `harness run --provider mock`: one session in-process, its events printed as JSON lines. The mock's script holds
//! what its recorded client did, and `run` does the same where the mock waits: it sends the recorded prompt (the
//! command line's prompt first), answers as `--answer` says or else as recorded, posts the recorded tool result and
//! cancels where the recording cancelled. The mock knows only its own request ids, so `run` answers the request and
//! the tool call it last saw in the session's events.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, watch};

use crate::error::{Error, Result};
use crate::event::{Body, Decision, Event};
use crate::mock::{ClientAction, Mock, Script};
use crate::session::{Harness, Open, Settings};
use crate::driver::random_hex;
use crate::store::Store;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunArgs {
    pub script: PathBuf,
    pub data: Option<PathBuf>,
    pub answers: Vec<Decision>,
    pub prompt: Option<String>,
}

/// Runs the session to its end. True when no event was a failure and its client did what the recording's did. With no
/// data folder given, the session's store is a temporary folder, removed after.
pub async fn run(args: RunArgs) -> Result<bool> {
    let script = Script::load(&args.script).map_err(Error::Script)?;
    let Some(dir) = args.data.clone() else {
        let dir = std::env::temp_dir().join(format!("harness-run-{}", random_hex(8)));
        let ran = play(script, &dir, args).await;
        let _ = std::fs::remove_dir_all(&dir);
        return ran;
    };
    play(script, &dir, args).await
}

async fn play(script: Script, dir: &std::path::Path, args: RunArgs) -> Result<bool> {
    let mock = Mock::new(script);
    let harness = Harness::new(Store::open(dir)?, vec![("mock".into(), Arc::new(mock.clone()))], Settings::default());
    let client = mock.client();
    let cwd = std::env::current_dir()?;
    let (id, events) = harness.open(Open { provider: "mock".into(), locked: false, cwd, model: None }).await?;
    let mut ok = true;
    let followed = drive(&harness, &id, events, client, args.answers, args.prompt, |event| {
        println!("{}", serde_json::to_string(event).expect("an event always serializes"));
        ok &= !matches!(event.body, Body::Failed { .. });
    })
    .await;
    Ok(ok && followed)
}

/// Acts as the mock's recorded client until the session closes, and hands every event to `seen`. `answers` come
/// before the recorded ones, and `prompt` before the first recorded prompt. False when it could not: a request with no
/// answer to give, which closes the session, or events it missed.
pub async fn drive(
    harness: &Harness,
    id: &str,
    mut events: broadcast::Receiver<Event>,
    mut client: watch::Receiver<Option<ClientAction>>,
    answers: Vec<Decision>,
    mut prompt: Option<String>,
    mut seen: impl FnMut(&Event),
) -> bool {
    let mut answers = answers.into_iter();
    // What the recorded client is to do, and the request or call it is for, which may come in either order.
    let (mut asked, mut called): (Option<String>, Option<String>) = (None, None);
    let (mut answer, mut result): (Option<Decision>, Option<Value>) = (None, None);
    let (mut followed, mut ended) = (true, false);
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    seen(&event);
                    match &event.body {
                        Body::Closed => return followed,
                        Body::TurnEnded { .. } => ended = true,
                        Body::Permission { id, .. } => asked = Some(id.clone()),
                        Body::ClientToolCall { id, .. } => called = Some(id.clone()),
                        _ => {}
                    }
                }
                Err(RecvError::Lagged(missed)) => {
                    eprintln!("harness: {missed} events missed");
                    followed = false;
                }
                Err(RecvError::Closed) => return followed,
            },
            Ok(()) = client.changed() => {
                let action = client.borrow_and_update().clone();
                let done = match action {
                    Some(ClientAction::Prompt(recorded)) => match prompt.take().or(recorded) {
                        Some(text) => harness.send(id, text),
                        // After a turn, a script that waits for one more prompt has played to its end.
                        None => {
                            if !ended {
                                eprintln!("harness: the script waits for a prompt; give one on the command line");
                                followed = false;
                            }
                            harness.close(id)
                        }
                    },
                    Some(ClientAction::Answer(recorded)) => match answers.next().or(recorded) {
                        Some(decision) => {
                            answer = Some(decision);
                            Ok(())
                        }
                        None => {
                            eprintln!("harness: the recording has no answer to this request; give one with --answer");
                            followed = false;
                            harness.close(id)
                        }
                    },
                    Some(ClientAction::ToolResult(recorded)) => {
                        result = Some(recorded.unwrap_or(Value::Null));
                        Ok(())
                    }
                    Some(ClientAction::Cancel) => harness.cancel(id),
                    None => Ok(()),
                };
                if let Err(e) = done {
                    eprintln!("harness: {e}");
                }
            }
        }
        if let (Some(request), Some(decision)) = (&asked, answer) {
            if let Err(e) = harness.answer(id, request, decision, None) {
                eprintln!("harness: {e}");
            }
            (asked, answer) = (None, None);
        }
        if let (Some(call), Some(output)) = (&called, &result) {
            if let Err(e) = harness.tool_result(id, call, output.clone(), false) {
                eprintln!("harness: {e}");
            }
            (called, result) = (None, None);
        }
    }
}
