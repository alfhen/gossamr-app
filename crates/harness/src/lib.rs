//! Gossamr's agent harness: a program beside the app that starts, watches and stops agent sessions. See
//! `docs/harness-proposal.md`. So far it runs sessions in-process, on the mock provider only.

use std::ffi::OsString;
use std::path::PathBuf;

pub mod api;
pub mod ask;
pub mod auth;
pub mod binary;
pub mod claude;
pub mod cli;
pub mod codex;
pub mod client;
pub mod codex_models;
pub mod driver;
pub mod env;
pub mod error;
pub mod event;
pub mod fresh;
pub mod mcp;
pub mod mock;
pub mod process;
pub mod provider;
pub mod provider_env;
pub mod provider_folder;
pub mod provider_probe;
pub mod providers;
pub mod redact;
pub mod repo;
pub mod run;
pub mod schema;
pub mod server;
pub mod session;
pub mod store;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
pub mod tools;
pub mod work;

use event::Decision;
use run::RunArgs;

/// The crate's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Which build this is; `build.rs` says how it is chosen.
pub const BUILD_ID: &str = env!("HARNESS_BUILD_ID");

/// The providers `harness serve` offers: the mock when a script is given, and Claude and Codex, whose CLIs each open
/// looks for in `places`.
pub fn serve_drivers(script: Option<mock::Script>, places: &binary::CliPlaces) -> Vec<(String, std::sync::Arc<dyn driver::Driver>)> {
    let mock = script.map(|script| ("mock".to_owned(), std::sync::Arc::new(mock::Mock::new(script)) as std::sync::Arc<dyn driver::Driver>));
    let claude = ("claude".to_owned(), std::sync::Arc::new(claude::driver::ClaudeDriver::found(places.clone())) as std::sync::Arc<dyn driver::Driver>);
    let codex = ("codex".to_owned(), std::sync::Arc::new(codex::driver::CodexDriver::found(places.clone())) as std::sync::Arc<dyn driver::Driver>);
    mock.into_iter().chain([claude, codex]).collect()
}

/// The runtime `harness serve` runs on. A driver's open starts a process and can block, so it takes several threads:
/// one slow open stalls no client and no other session. Set here, so `TOKIO_WORKER_THREADS=1` cannot make it one.
pub fn serve_runtime() -> std::io::Result<tokio::runtime::Runtime> {
    let available = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    tokio::runtime::Builder::new_multi_thread().worker_threads(serve_workers(available)).enable_all().build()
}

/// At least two, whatever the machine has.
fn serve_workers(available: usize) -> usize {
    available.max(2)
}

/// What `harness --version` prints.
pub fn version_line() -> String {
    format!("harness {VERSION} (build {BUILD_ID})")
}

/// What the command line asks for.
#[derive(Debug, PartialEq)]
pub enum Request {
    Version,
    Run(RunArgs),
    /// `turn_limit`: how many turns run at once, past which a session waits; left out, the harness's own.
    Serve { data: Option<PathBuf>, mock_script: Option<PathBuf>, turn_limit: Option<usize> },
    Client { command: cli::Command, data: Option<PathBuf>, token_stdin: bool },
    /// Anything else, which gets the usage line and a failing exit code.
    Usage,
}

pub const USAGE: &str = "usage: harness --version
       harness run --provider mock --script <file> [--data <folder>] [--answer allow|deny]... [<prompt>]
       harness serve [--data <folder>] [--mock-script <file>] [--turn-limit <n>]   (the first client token on stdin)
  against the harness serving --data <folder>, with the client token on stdin (--token-stdin):
       harness run --provider <name> [--answer allow|deny]... [--ends-with-client] <prompt>
       harness sessions | shutdown | token list | token revoke <id>
       harness providers [--login <provider>=<folder>]...   (without --token-stdin it asks the CLIs itself)
       harness events <session> [--after <seq>] [--follow]
       harness send <session> <text>
       harness resume <session> [--carry-on <text>] | take-back <session>
       harness answer <session> <request> allow|deny [--message <text>]
       harness answer <session> <question> --text <answer>
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
    let (mut data, mut mock_script, mut turn_limit) = (None, None, None);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.to_str()? {
            "--data" => data = Some(args.next()?.into()),
            "--mock-script" => mock_script = Some(args.next()?.into()),
            "--turn-limit" => turn_limit = Some(args.next()?.to_str()?.parse().ok().filter(|n| *n > 0)?),
            _ => return None,
        }
    }
    Some(Request::Serve { data, mock_script, turn_limit })
}

fn run_args(args: &[OsString]) -> Option<RunArgs> {
    let mut args = args.iter().map(|arg| arg.to_str());
    let (mut provider, mut script, mut data, mut answers, mut prompt) = (None, None, None, vec![], None);
    while let Some(arg) = args.next() {
        match arg? {
            "--provider" => provider = Some(value(&mut args)?),
            "--script" => script = Some(value(&mut args)?.into()),
            "--data" => data = Some(value(&mut args)?.into()),
            "--answer" => answers.push(match value(&mut args)? {
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

/// A flag's value, which is never another flag: a path that starts with `-` is given as `./-…`.
fn value<'a>(args: &mut impl Iterator<Item = Option<&'a str>>) -> Option<&'a str> {
    args.next().flatten().filter(|value| !value.starts_with('-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_offers_the_mock_with_a_script_and_claude_and_codex_always() {
        let names = |drivers: Vec<(String, std::sync::Arc<dyn driver::Driver>)>| drivers.into_iter().map(|(name, _)| name).collect::<Vec<_>>();
        let places = binary::CliPlaces::none();
        assert_eq!(names(serve_drivers(None, &places)), ["claude", "codex"], "found at open, so one on the shell's PATH counts");
        let script = mock::Script::parse("{\"prompt\": null}\n{\"end\": \"done\"}").unwrap();
        assert_eq!(names(serve_drivers(Some(script), &places)), ["mock", "claude", "codex"]);
    }

    #[test]
    fn serve_runs_on_a_runtime_of_several_threads() {
        let runtime = serve_runtime().unwrap();
        assert_eq!(runtime.handle().runtime_flavor(), tokio::runtime::RuntimeFlavor::MultiThread);
        let available = std::thread::available_parallelism().unwrap().get();
        assert_eq!(runtime.metrics().num_workers(), serve_workers(available), "its workers are set, not left to the environment");
        assert_eq!(serve_workers(1), 2, "two on a machine of one core");
    }

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
        let missing_values = [&["run", "--provider", "mock", "--script", "--data", "d"][..], &["run", "--provider", "mock", "--script", "s", "--data", "--answer", "allow"]];
        for wrong in [&["run", "--provider", "mock", "--script", "s", "one", "two"][..], &["run", "--provider", "mock", "--script"], &["run", "--provider", "mock", "--script", "s", "--model", "x"]].into_iter().chain(missing_values) {
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
