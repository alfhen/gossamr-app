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
            block_on(serve(data, mock_script))
        }
        Request::Client { command, data, token_stdin } => block_on(harness::cli::execute(command, data, token_stdin)),
        Request::Usage => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn block_on(work: impl Future<Output = harness::error::Result<bool>>) -> ExitCode {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime starts");
    match runtime.block_on(work) {
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
    // The mock provider is there only when a script is given.
    let drivers: Vec<(String, std::sync::Arc<dyn harness::driver::Driver>)> =
        script.map(|script| ("mock".to_owned(), std::sync::Arc::new(harness::mock::Mock::new(script)) as _)).into_iter().collect();
    // A token on a pipe is read on every start, the pipe swapped for /dev/null, so none waits behind fd 0 while the
    // harness runs. A terminal holds nothing to read, so one is asked only when the store has no token yet.
    // SAFETY: isatty has no preconditions.
    let handed = (unsafe { libc::isatty(libc::STDIN_FILENO) } != 1).then(|| {
        let line = read_token();
        // SAFETY: open, dup2 and close have no preconditions; a failure leaves fd 0 on the drained pipe.
        unsafe {
            let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY);
            if null > libc::STDIN_FILENO {
                libc::dup2(null, libc::STDIN_FILENO);
                libc::close(null);
            }
        }
        line
    });
    let first_token = move || handed.unwrap_or_else(read_token);
    let setup = harness::work::Setup::of_this_machine(dir.clone());
    let server = harness::server::Server::bind_with(&dir, first_token, drivers, harness::session::Settings::default(), setup)?;
    eprintln!("harness: serving {}", dir.join(harness::api::SOCKET).display());
    server.run().await?;
    Ok(true)
}

/// The line on stdin, to its first newline or the end.
fn read_token() -> Option<harness::auth::Token> {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok()?;
    harness::auth::Token::parse(&line)
}
