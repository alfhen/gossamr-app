//! Opens Terminal on a command for the person to read and run.

use tokio::process::Command;

use crate::error::{Error, Result};

/// The command is the last argument and a separate one, so no character in it can end the script.
fn osascript_args(command: &str) -> Vec<String> {
    let script = ["on run argv", "tell application \"Terminal\"", "activate", "do script (item 1 of argv)", "end tell", "end run"];
    script.iter().flat_map(|line| ["-e".to_string(), line.to_string()]).chain(["--".to_string(), command.to_string()]).collect()
}

pub async fn open(command: &str) -> Result<()> {
    let output = Command::new("/usr/bin/osascript").args(osascript_args(command)).kill_on_drop(true).output().await?;
    if output.status.success() {
        return Ok(());
    }
    Err(Error::Input("Gossamr couldn't open Terminal. Copy the command and run it there.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_reaches_osascript_as_its_own_argument_and_never_inside_the_script() {
        let command = "gh auth login -h x\"; do shell script \"rm -rf ~\"";
        let args = osascript_args(command);
        assert_eq!(args.last().map(String::as_str), Some(command));
        assert_eq!(args[args.len() - 2], "--");
        assert!(args[..args.len() - 2].iter().all(|a| !a.contains("rm -rf")));
    }
}
