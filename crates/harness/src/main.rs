use std::process::ExitCode;

use harness::{request, version_line, Request, USAGE};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match request(&args) {
        Request::Version => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Request::Usage => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
