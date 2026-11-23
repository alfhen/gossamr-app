//! The command line's client commands. Each connects to the harness serving the data folder (`--data`, else the
//! default) with the token in `HARNESS_TOKEN`, never one on the command line.

use std::path::PathBuf;

use serde_json::Value;

use crate::api::Op;
use crate::auth::{Token, encode};
use crate::client::{Client, Push};
use crate::error::{Error, Result};
use crate::event::{Body, Decision};
use crate::store::default_dir;

pub const TOKEN_VARIABLE: &str = "HARNESS_TOKEN";

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Prints the answer: a list one JSON line per item, anything else as one line, nothing for null.
    Call(Op),
    /// Prints the stored events after `after`; with `follow`, then the live ones until the session closes.
    Events { session: String, after: u64, follow: bool },
    /// Opens a session on the harness, sends the prompt, prints its events, answers its permission requests as
    /// `answers` say (and leaves the rest for `harness answer`), and closes it when its turn ends.
    Run { provider: String, answers: Vec<Decision>, prompt: String, ends_with_client: bool },
    /// Makes a token, adds it with a valid one, and prints it.
    TokenNew,
}

pub fn parse(command: &str, args: &[&str], data: &mut Option<PathBuf>) -> Option<Command> {
    let mut flags: Vec<(&str, Option<&str>)> = vec![];
    let mut words = vec![];
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        match arg {
            "--follow" | "--ends-with-client" | "--error" => flags.push((arg, None)),
            "--data" => *data = Some(args.next()?.into()),
            flag if flag.starts_with("--") => flags.push((flag, Some(args.next()?))),
            word => words.push(word.to_owned()),
        }
    }
    let flag = |name: &str| flags.iter().find(|(flag, _)| *flag == name).map(|(_, value)| *value);
    let decision = |word: &str| match word {
        "allow" => Some(Decision::Allow),
        "deny" => Some(Decision::Deny),
        _ => None,
    };
    let known = |names: &[&str]| flags.iter().all(|(flag, _)| names.contains(flag));
    let words: Vec<String> = words;
    let call = |op: Op| Some(Command::Call(op));
    match (command, words.as_slice()) {
        ("sessions", []) if known(&[]) => call(Op::Sessions),
        ("providers", []) if known(&[]) => call(Op::Providers),
        ("shutdown", []) if known(&[]) => call(Op::Shutdown),
        ("token", [new]) if new == "new" && known(&[]) => Some(Command::TokenNew),
        ("events", [session]) if known(&["--after", "--follow"]) => {
            let after = flag("--after").flatten().map_or(Some(0), |after| after.parse().ok())?;
            Some(Command::Events { session: session.clone(), after, follow: flag("--follow").is_some() })
        }
        ("send", [session, text]) if known(&[]) => call(Op::Send { session: session.clone(), text: text.clone() }),
        ("answer", [session, request, word]) if known(&["--message"]) => {
            let message = flag("--message").flatten().map(str::to_owned);
            call(Op::Answer { session: session.clone(), request: request.clone(), decision: decision(word)?, message })
        }
        ("answer-question", [session, question, text]) if known(&[]) => {
            call(Op::AnswerQuestion { session: session.clone(), question: question.clone(), text: text.clone() })
        }
        ("tool-result", [session, id, output]) if known(&["--error"]) => {
            let output = serde_json::from_str(output).ok()?;
            call(Op::ToolResult { session: session.clone(), call: id.clone(), output, error: flag("--error").is_some() })
        }
        ("cancel", [session]) if known(&[]) => call(Op::Cancel { session: session.clone() }),
        ("close", [session]) if known(&[]) => call(Op::Close { session: session.clone() }),
        ("hand-over", [session]) if known(&[]) => call(Op::HandOver { session: session.clone() }),
        ("clean-up", [session]) if known(&[]) => call(Op::CleanUp { session: session.clone() }),
        ("run", [prompt]) if known(&["--provider", "--answer", "--ends-with-client"]) => {
            let answers = flags.iter().filter(|(flag, _)| *flag == "--answer").map(|(_, word)| decision((*word)?)).collect::<Option<_>>()?;
            let provider = flag("--provider")??.to_owned();
            Some(Command::Run { provider, answers, prompt: prompt.clone(), ends_with_client: flag("--ends-with-client").is_some() })
        }
        _ => None,
    }
}

/// Runs the command. True when it did what it was asked; a session's failure makes `run` false.
pub async fn execute(command: Command, data: Option<PathBuf>) -> Result<bool> {
    let dir = data.or_else(default_dir).ok_or_else(|| Error::Refused("no data folder: set HARNESS_DATA".into()))?;
    let token = std::env::var(TOKEN_VARIABLE).ok().and_then(|text| Token::parse(&text));
    let token = token.ok_or_else(|| Error::Refused(format!("set {TOKEN_VARIABLE} to a client token")))?;
    let mut client = Client::connect(&dir, &token).await?;
    match command {
        Command::Call(op) => {
            match client.call(op).await? {
                Value::Null => {}
                Value::Array(items) => items.iter().for_each(|item| println!("{item}")),
                other => println!("{other}"),
            }
            Ok(true)
        }
        Command::TokenNew => {
            let new = Token::random();
            client.call(Op::TokenNew { stored_key: encode(&new.stored_key()) }).await?;
            println!("{}", new.hex());
            Ok(true)
        }
        Command::Events { session, after, follow: false } => {
            let events: Vec<crate::event::Event> = serde_json::from_value(client.call(Op::Events { session, after }).await?)?;
            for event in events {
                println!("{}", serde_json::to_string(&event)?);
            }
            Ok(true)
        }
        Command::Events { session, after, follow: true } => {
            client.call(Op::Watch { session, after }).await?;
            while let Some(Push::Event { event, .. }) = client.push().await? {
                println!("{}", serde_json::to_string(&event)?);
            }
            Ok(true)
        }
        Command::Run { provider, answers, prompt, ends_with_client } => run(&mut client, provider, answers, prompt, ends_with_client).await,
    }
}

async fn run(client: &mut Client, provider: String, answers: Vec<Decision>, prompt: String, ends_with_client: bool) -> Result<bool> {
    let cwd = std::env::current_dir()?;
    let opened = client.call(Op::Open { provider, cwd, locked: false, model: None, ends_with_client }).await?;
    let session = opened["session"].as_str().ok_or_else(|| Error::Protocol("`open` named no session".into()))?.to_owned();
    eprintln!("harness: session {session}");
    client.call(Op::Send { session: session.clone(), text: prompt }).await?;
    let (mut answers, mut ok) = (answers.into_iter(), true);
    while let Some(Push::Event { event, .. }) = client.push().await? {
        println!("{}", serde_json::to_string(&event)?);
        match event.body {
            Body::Permission { id, .. } => {
                if let Some(decision) = answers.next() {
                    client.call(Op::Answer { session: session.clone(), request: id, decision, message: None }).await?;
                }
            }
            body if body.ends_turn() => {
                ok &= !matches!(body, Body::Failed { .. });
                // A session that is already stopping refuses it, and its `closed` comes anyway.
                let _ = client.call(Op::Close { session: session.clone() }).await;
            }
            _ => {}
        }
    }
    Ok(ok)
}
