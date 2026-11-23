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
            // SAFETY: no other thread runs yet. The harness's agents inherit its environment, and a client token in it
            // would open the client API to them.
            unsafe { std::env::remove_var(harness::cli::TOKEN_VARIABLE) };
            block_on(serve(data, mock_script))
        }
        Request::Client { command, data } => block_on(harness::cli::execute(command, data)),
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
    let first_token = || {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok()?;
        harness::auth::Token::parse(&line)
    };
    let server = harness::server::Server::bind(&dir, first_token, drivers, harness::session::Settings::default())?;
    eprintln!("harness: serving {}", dir.join(harness::api::SOCKET).display());
    server.run().await?;
    Ok(true)
}
