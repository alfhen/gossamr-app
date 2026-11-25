use std::future::Future;
use std::process::ExitCode;

use harness::{Request, USAGE, request, version_line};

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    match request(&args) {
        Request::Version => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Request::Run(args) => block_on(harness::run::run(args)),
        Request::Serve { data, mock_script } => {
            if std::env::var_os(harness::cli::TOKEN_VARIABLE).is_some() {
                let variable = harness::cli::TOKEN_VARIABLE;
                eprintln!("harness: {variable} is set, so serve does not start: any program of yours, an agent too, can read the environment a process started with. Unset it and give the first token on stdin.");
                return ExitCode::FAILURE;
            }
            let served = runtime().block_on(serve(data, mock_script));
            match served {
                Err(e) if harness::server::unknown_token(&e) => {
                    eprintln!("harness: {e}");
                    ExitCode::from(harness::server::UNKNOWN_TOKEN_EXIT)
                }
                served => exit(served),
            }
        }
        Request::Client { command, data, token_stdin } => block_on(harness::cli::execute(command, data, token_stdin)),
        Request::Usage => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn block_on(work: impl Future<Output = harness::error::Result<bool>>) -> ExitCode {
    exit(runtime().block_on(work))
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime starts")
}

fn exit(result: harness::error::Result<bool>) -> ExitCode {
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("harness: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(data: Option<std::path::PathBuf>, mock_script: Option<std::path::PathBuf>) -> harness::error::Result<bool> {
    use harness::error::Error;
    let dir = data.or_else(harness::store::default_dir).ok_or_else(|| Error::Refused("no data folder: set HARNESS_DATA".into()))?;
    let script = mock_script.map(|path| harness::mock::Script::load(&path)).transpose().map_err(Error::Driver)?;
    // A token on a pipe is read on every start, the pipe swapped for /dev/null, so none waits behind fd 0 while the
    // harness runs. A terminal is never read: a token typed there stays on the screen, and no prompt holds up a start.
    // SAFETY: isatty has no preconditions.
    let handed = if unsafe { libc::isatty(libc::STDIN_FILENO) } == 1 { None } else { drain_stdin()? };
    let first_token = move || handed;
    let setup = harness::work::Setup::of_this_machine(dir.clone());
    // The mock provider is there only when a script is given. Claude is found where `providers` looks, at each open.
    let drivers = harness::serve_drivers(script, harness::claude::driver::ClaudeDriver::found(setup.places().clone()));
    let server = harness::server::Server::bind_with(&dir, first_token, drivers, harness::session::Settings::default(), setup)?;
    eprintln!("harness: serving {}", dir.join(harness::api::SOCKET).display());
    server.run().await?;
    Ok(true)
}

/// The token on stdin, read to its first newline or the end, with `/dev/null` put in its place. An empty stdin gives
/// no token; a line that is not one stops the start, as one the store does not know does.
fn drain_stdin() -> harness::error::Result<Option<harness::auth::Token>> {
    use harness::error::Error;
    let mut line = Vec::new();
    let read = std::io::BufRead::read_until(&mut std::io::stdin().lock(), b'\n', &mut line);
    // SAFETY: open, dup2 and close have no preconditions.
    let swapped = unsafe {
        let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY);
        let swapped = null == libc::STDIN_FILENO || (null > libc::STDIN_FILENO && libc::dup2(null, libc::STDIN_FILENO) != -1);
        if null > libc::STDIN_FILENO {
            libc::close(null);
        }
        swapped
    };
    if !swapped {
        return Err(Error::Refused("couldn't put /dev/null in place of stdin, so the harness does not start".into()));
    }
    read.map_err(|e| Error::Refused(format!("couldn't read stdin: {e}")))?;
    let line = String::from_utf8_lossy(&line);
    if line.trim().is_empty() {
        return Ok(None);
    }
    harness::auth::Token::parse(&line).map(Some).ok_or_else(|| Error::Refused("the line on stdin is not a client token".into()))
}
