//! Gossamr's agent harness: a program beside the app that starts, watches and stops agent sessions. See
//! `docs/harness-proposal.md`. So far it only says which build it is.

/// The crate's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Which build this is; `build.rs` says how it is chosen.
pub const BUILD_ID: &str = env!("HARNESS_BUILD_ID");

/// What `harness --version` prints.
pub fn version_line() -> String {
    format!("harness {VERSION} (build {BUILD_ID})")
}

/// What the command line asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Version,
    /// Anything else, which gets the usage line and a failing exit code.
    Usage,
}

pub const USAGE: &str = "usage: harness --version";

pub fn request(args: &[String]) -> Request {
    match args {
        [only] if only == "--version" || only == "-V" => Request::Version,
        _ => Request::Usage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn version_and_its_short_form_ask_for_the_version_and_nothing_else_does() {
        assert_eq!(request(&args(&["--version"])), Request::Version);
        assert_eq!(request(&args(&["-V"])), Request::Version);
        for other in [&[][..], &["serve"], &["--version", "extra"], &["--help"]] {
            assert_eq!(request(&args(other)), Request::Usage, "{other:?}");
        }
    }

    #[test]
    fn the_version_line_names_the_crate_version_and_a_build_id() {
        assert_eq!(version_line(), format!("harness {} (build {BUILD_ID})", env!("CARGO_PKG_VERSION")));
        assert!(!BUILD_ID.is_empty() && !BUILD_ID.contains(char::is_whitespace), "{BUILD_ID:?}");
    }
}
