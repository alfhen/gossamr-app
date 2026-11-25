//! The command line's client commands. Each connects to the harness serving the data folder (`--data`, else the
//! default). It reads its client token from stdin, with `--token-stdin`: never from an environment variable, an
//! argument or a file, where an agent of the same user could read it without the person and approve its own requests.

use std::path::PathBuf;

use serde_json::Value;

use crate::api::Op;
use crate::auth::{Token, encode};
use crate::client::{Client, Push};
use crate::error::{Error, Result};
use crate::event::{Body, Decision};
use crate::providers::{Asked, Standing, check, line, with_usual};
use crate::store::default_dir;

/// The variable a client token must never be in. `serve` refuses to start while it is set: on macOS any program of
/// the same user can read the environment a process started with, even after the process unsets it.
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
    /// Prints how each login stands, one line each: the usual setup of every provider, then each of `logins`. With
    /// a token it asks the harness serving the data folder; without one it asks the CLIs itself.
    Providers { logins: Vec<Asked> },
}

/// A suggested place for the client token: a Keychain item that trusts no app. Whether reading it asks the person each
/// time is for them to check.
pub const KEYCHAIN_ADD: &str = r#"security add-generic-password -s gossamr-harness -a client -T "" -w"#;
pub const KEYCHAIN_READ: &str = "security find-generic-password -s gossamr-harness -a client -w";

/// `token_stdin` is set when the arguments hold `--token-stdin`.
pub fn parse(command: &str, args: &[&str], data: &mut Option<PathBuf>, token_stdin: &mut bool) -> Option<Command> {
    let mut flags: Vec<(&str, Option<&str>)> = vec![];
    let mut words = vec![];
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        match arg {
            "--follow" | "--ends-with-client" => flags.push((arg, None)),
            "--token-stdin" => *token_stdin = true,
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
        ("providers", []) if known(&["--login"]) => {
            let logins = flags.iter().map(|(_, value)| {
                let (provider, folder) = (*value)?.split_once('=')?;
                Some(Asked { provider: provider.into(), folder: Some(folder.into()).filter(|f: &String| !f.is_empty()) })
            });
            Some(Command::Providers { logins: logins.collect::<Option<_>>()? })
        }
        ("shutdown", []) if known(&[]) => call(Op::Shutdown),
        ("token", [new]) if new == "new" && known(&[]) => Some(Command::TokenNew),
        ("token", [list]) if list == "list" && known(&[]) => call(Op::TokenList),
        ("token", [revoke, id]) if revoke == "revoke" && known(&[]) => call(Op::TokenRevoke { token: id.parse().ok()? }),
        ("events", [session]) if known(&["--after", "--follow"]) => {
            let after = flag("--after").flatten().map_or(Some(0), |after| after.parse().ok())?;
            Some(Command::Events { session: session.clone(), after, follow: flag("--follow").is_some() })
        }
        ("send", [session, text]) if known(&[]) => call(Op::Send { session: session.clone(), text: text.clone() }),
        ("answer", [session, question]) if known(&["--text"]) => {
            let text = flag("--text")??.to_owned();
            call(Op::AnswerQuestion { session: session.clone(), question: question.clone(), text })
        }
        ("answer", [session, request, word]) if known(&["--message"]) => {
            let message = flag("--message").flatten().map(str::to_owned);
            call(Op::Answer { session: session.clone(), request: request.clone(), decision: decision(word)?, message })
        }
        ("run", [prompt]) if known(&["--provider", "--answer", "--ends-with-client"]) => {
            let answers = flags.iter().filter(|(flag, _)| *flag == "--answer").map(|(_, word)| decision((*word)?)).collect::<Option<_>>()?;
            let provider = flag("--provider")??.to_owned();
            Some(Command::Run { provider, answers, prompt: prompt.clone(), ends_with_client: flag("--ends-with-client").is_some() })
        }
        _ => None,
    }
}

/// Runs the command. True when it did what it was asked; a session's failure makes `run` false.
pub async fn execute(command: Command, data: Option<PathBuf>, token_stdin: bool) -> Result<bool> {
    let dir = data.or_else(default_dir).ok_or_else(|| Error::Refused("no data folder: set HARNESS_DATA".into()))?;
    if let (Command::Providers { logins }, false) = (&command, token_stdin) {
        let setup = crate::work::Setup::of_this_machine(dir);
        if let Err(why) = setup.capture().await {
            eprintln!("harness: {why}");
        }
        check(&setup, setup.places(), &with_usual(logins.clone())).await.iter().for_each(|standing| println!("{}", line(standing)));
        return Ok(true);
    }
    let token = read_token(token_stdin)?;
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
            client.events(&session, after, |event| println!("{}", serde_json::to_string(&event).expect("an event always serializes"))).await?;
            Ok(true)
        }
        Command::Events { session, after, follow: true } => {
            client.call(Op::Watch { session, after }).await?;
            while let Some(event) = next_event(&mut client).await? {
                println!("{}", serde_json::to_string(&event)?);
            }
            Ok(true)
        }
        Command::Run { provider, answers, prompt, ends_with_client } => run(&mut client, provider, answers, prompt, ends_with_client).await,
        Command::Providers { logins } => {
            let answer = client.call(Op::Providers { logins }).await?;
            let logins: Vec<Standing> = serde_json::from_value(answer["logins"].clone())?;
            logins.iter().for_each(|standing| println!("{}", line(standing)));
            Ok(true)
        }
    }
}

/// The next pushed event, None at the end of the watch; a watch that lost events is an error that says why.
async fn next_event(client: &mut Client) -> Result<Option<crate::event::Event>> {
    match client.push().await? {
        Some(Push::Event { event, .. }) => Ok(Some(event)),
        Some(Push::Lost { reason, .. }) => Err(Error::Said(reason)),
        Some(Push::End { .. }) | None => Ok(None),
    }
}

async fn run(client: &mut Client, provider: String, answers: Vec<Decision>, prompt: String, ends_with_client: bool) -> Result<bool> {
    let cwd = std::env::current_dir()?;
    let open = Op::Open { provider, cwd: Some(cwd), repo: None, base: None, branch: None, locked: false, model: None, login: None, effort: None, ends_with_client, tools: vec![], result_schema: None };
    let opened = client.call(open).await?;
    let session = opened["session"].as_str().ok_or_else(|| Error::Protocol("`open` named no session".into()))?.to_owned();
    eprintln!("harness: session {session}");
    client.call(Op::Send { session: session.clone(), text: prompt }).await?;
    // Done only once a turn has ended, and not in a failure: a connection that drops before then is not done.
    let (mut answers, mut ok, mut ended) = (answers.into_iter(), true, false);
    // A turn that ends while a question is open is not the end: the answer comes as the next prompt.
    let mut asking = std::collections::HashSet::new();
    while let Some(event) = next_event(client).await? {
        println!("{}", serde_json::to_string(&event)?);
        match event.body {
            Body::Question { id, .. } => {
                asking.insert(id);
            }
            Body::QuestionClosed { id, .. } => {
                asking.remove(&id);
            }
            Body::TurnEnded { .. } if !asking.is_empty() => {
                eprintln!("harness: the turn ended with a question open; answer it with `harness answer <session> <question> --text <answer>`");
            }
            Body::Permission { id, .. } => match answers.next() {
                // The harness refuses it, and the agent would wait on: the session is closed, and the run fails.
                Some(Decision::Allow) if event.cut.is_some() => {
                    eprintln!("harness: {id} was cut to fit, so not all it asks is shown and it can only be denied; closing the session");
                    ok = false;
                    let _ = client.call(Op::Close { session: session.clone() }).await;
                }
                Some(decision) => {
                    client.call(Op::Answer { session: session.clone(), request: id, decision, message: None }).await?;
                }
                None => {}
            },
            body if body.ends_turn() => {
                ended = true;
                ok &= !matches!(body, Body::Failed { .. });
                // A session that is already stopping refuses it, and its `closed` comes anyway.
                let _ = client.call(Op::Close { session: session.clone() }).await;
            }
            _ => {}
        }
    }
    Ok(ok && ended)
}

/// The client token, from the first line of stdin, which `--token-stdin` says holds it.
fn read_token(from_stdin: bool) -> Result<Token> {
    // SAFETY: isatty has no preconditions.
    let terminal = unsafe { libc::isatty(libc::STDIN_FILENO) } == 1;
    if !from_stdin || terminal {
        return Err(Error::Refused(format!("give the client token on stdin with --token-stdin, piped from where you keep it, for example: {KEYCHAIN_READ} | harness sessions --token-stdin")));
    }
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Token::parse(&line).ok_or_else(|| Error::Refused("that is not a client token, which is 64 hex digits".into()))
}
