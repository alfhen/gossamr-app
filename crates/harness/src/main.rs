use std::process::ExitCode;

use harness::{Request, USAGE, request, version_line};

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    match request(&args) {
        Request::Version => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Request::Run(args) => {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().expect("a runtime starts");
            match runtime.block_on(harness::run::run(args)) {
                Ok(true) => ExitCode::SUCCESS,
                Ok(false) => ExitCode::FAILURE,
                Err(e) => {
                    eprintln!("harness: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Request::Usage => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
