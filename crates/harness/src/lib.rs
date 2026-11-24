//! Gossamr's agent harness: a program beside the app that starts, watches and stops agent sessions. See
//! `docs/harness-proposal.md`. So far it runs sessions in-process, on the mock provider only.

use std::ffi::OsString;
use std::path::PathBuf;

pub mod api;
pub mod auth;
pub mod cli;
pub mod client;
pub mod driver;
pub mod error;
pub mod event;
pub mod mock;
pub mod redact;
pub mod run;
pub mod server;
pub mod session;
pub mod store;
pub mod tools;

use event::Decision;
use run::RunArgs;

/// The crate's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Which build this is; `build.rs` says how it is chosen.
pub const BUILD_ID: &str = env!("HARNESS_BUILD_ID");

/// What `harness --version` prints.
pub fn version_line() -> String {
    format!("harness {VERSION} (build {BUILD_ID})")
}

/// What the command line asks for.
#[derive(Debug, PartialEq)]
pub enum Request {
    Version,
    Run(RunArgs),
    Serve { data: Option<PathBuf>, mock_script: Option<PathBuf> },
    Client { command: cli::Command, data: Option<PathBuf>, token_stdin: bool },
    /// Anything else, which gets the usage line and a failing exit code.
    Usage,
}

pub const USAGE: &str = "usage: harness --version
       harness run --provider mock --script <file> [--data <folder>] [--answer allow|deny]... [<prompt>]
       harness serve [--data <folder>] [--mock-script <file>]   (the first client token on stdin)
  against the harness serving --data <folder>, with the client token on stdin (--token-stdin):
       harness run --provider <name> [--answer allow|deny]... [--ends-with-client] <prompt>
       harness sessions | shutdown | token list | token revoke <id>
       harness events <session> [--after <seq>] [--follow]
       harness send <session> <text>
       harness answer <session> <request> allow|deny [--message <text>]
       harness token new
  One place to keep the token is a Keychain item that trusts no app; check that reading it asks you first:
       security add-generic-password -s gossamr-harness -a client -T \"\" -w     (paste the token when asked)
       security find-generic-password -s gossamr-harness -a client -w | harness sessions --token-stdin";

/// An argument that is not UTF-8 is never one the harness knows, so it gets the usage line like any other.
pub fn request(args: &[OsString]) -> Request {
    match args {
        [only] if only == "--version" || only == "-V" => Request::Version,
        [first, rest @ ..] if first == "run" && rest.iter().any(|arg| arg == "--script") => run_args(rest).map_or(Request::Usage, Request::Run),
        [first, rest @ ..] if first == "serve" => serve_args(rest).unwrap_or(Request::Usage),
        [first, rest @ ..] => {
            let (Some(first), Some(rest)) = (first.to_str(), rest.iter().map(|arg| arg.to_str()).collect::<Option<Vec<_>>>()) else { return Request::Usage };
            let (mut data, mut token_stdin) = (None, false);
            cli::parse(first, &rest, &mut data, &mut token_stdin).map_or(Request::Usage, |command| Request::Client { command, data, token_stdin })
        }
        _ => Request::Usage,
    }
}

fn serve_args(args: &[OsString]) -> Option<Request> {
    let (mut data, mut mock_script) = (None, None);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.to_str()? {
            "--data" => data = Some(args.next()?.into()),
            "--mock-script" => mock_script = Some(args.next()?.into()),
            _ => return None,
        }
    }
    Some(Request::Serve { data, mock_script })
}

fn run_args(args: &[OsString]) -> Option<RunArgs> {
    let mut args = args.iter().map(|arg| arg.to_str());
    let (mut provider, mut script, mut data, mut answers, mut prompt) = (None, None, None, vec![], None);
    while let Some(arg) = args.next() {
        match arg? {
            "--provider" => provider = Some(args.next()??),
            "--script" => script = Some(args.next()??.into()),
            "--data" => data = Some(args.next()??.into()),
            "--answer" => answers.push(match args.next()?? {
                "allow" => Decision::Allow,
                "deny" => Decision::Deny,
                _ => return None,
            }),
            flag if flag.starts_with('-') => return None,
            text if prompt.is_none() => prompt = Some(text.to_owned()),
            _ => return None,
        }
    }
    (provider? == "mock").then_some(RunArgs { script: script?, data, answers, prompt })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn version_and_its_short_form_ask_for_the_version_and_nothing_else_does() {
        assert_eq!(request(&args(&["--version"])), Request::Version);
        assert_eq!(request(&args(&["-V"])), Request::Version);
        for other in [&[][..], &["serve", "extra"], &["--version", "extra"], &["--help"]] {
            assert_eq!(request(&args(other)), Request::Usage, "{other:?}");
        }
    }

    #[test]
    fn run_takes_its_flags_in_any_order_and_one_prompt() {
        let parsed = request(&args(&["run", "hello", "--answer", "deny", "--script", "s.jsonl", "--provider", "mock", "--answer", "allow"]));
        let expected = RunArgs { script: "s.jsonl".into(), data: None, answers: vec![Decision::Deny, Decision::Allow], prompt: Some("hello".into()) };
        assert_eq!(parsed, Request::Run(expected));
        for wrong in [&["run", "--provider", "mock", "--script", "s", "one", "two"][..], &["run", "--provider", "mock", "--script"], &["run", "--provider", "mock", "--script", "s", "--model", "x"]] {
            assert_eq!(request(&args(wrong)), Request::Usage, "{wrong:?}");
        }
    }

    #[test]
    fn an_argument_that_is_not_utf8_asks_for_nothing() {
        use std::os::unix::ffi::OsStringExt;
        assert_eq!(request(&[OsString::from_vec(vec![0xff])]), Request::Usage);
    }

    #[test]
    fn the_version_line_names_the_crate_version_and_a_build_id() {
        assert_eq!(version_line(), format!("harness {} (build {BUILD_ID})", env!("CARGO_PKG_VERSION")));
        assert!(!BUILD_ID.is_empty() && !BUILD_ID.contains(char::is_whitespace), "build.rs makes it one word: {BUILD_ID:?}");
    }
}
