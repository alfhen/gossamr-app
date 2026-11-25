//! Pip's Claude Code: the person's installed `claude` run headlessly with Pip's MCP tools and nothing else. The app
//! runs it; this builds its flags, its environment and the message it reads on stdin.

use std::path::PathBuf;

use serde_json::json;
use tokio::process::Command;

use crate::provider_env::ProviderEnv;

/// Claude may use the gossamr MCP server and no built-in tool. Ticket text is untrusted, so anything that reaches
/// files, a shell or the network would let it exfiltrate; loosening a flag here re-opens that.
pub const ALLOWED: &str = "mcp__gossamr";

/// Where and as whom a turn runs. Pip always passes a model: without `--model` the CLI would use its own default, which
/// may be a slower, costlier one.
#[derive(Debug)]
pub struct Launch {
    pub binary: PathBuf,
    pub env: ProviderEnv,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// One turn of Pip's, as the flags and the stdin message need it.
#[derive(Debug)]
pub struct Turn {
    pub launch: Launch,
    pub system: String,
    pub mcp_url: String,
    pub mcp_token: String,
    /// The working folder, which the app prepares.
    pub cwd: PathBuf,
    /// Continues an earlier session.
    pub session: Option<String>,
    pub images: Vec<Image>,
}

/// A screenshot sent with the prompt, inline: standard base64 with padding and no line breaks.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub media_type: String,
    pub data: String,
}

/// The token is named, not included: Claude expands `${...}` in header values from its own environment, and argv is
/// readable by every process of the same user through `ps`.
pub const TOKEN_ENV: &str = "GOSSAMR_MCP_TOKEN";

fn mcp_config(url: &str) -> String {
    json!({
        "mcpServers": {
            "gossamr": { "type": "http", "url": url, "headers": { "Authorization": format!("Bearer ${{{TOKEN_ENV}}}") } }
        }
    })
    .to_string()
}

pub fn args(turn: &Turn) -> Vec<String> {
    // Images can only ride in a structured user message, so the prompt is sent that way when there are any.
    // Kept ahead of `--mcp-config`, which takes every argument up to the next flag.
    let input: &[&str] = if turn.images.is_empty() { &[] } else { &["--input-format", "stream-json"] };
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .into_iter()
        .chain(input.iter().copied())
        .chain(turn.launch.model.iter().flat_map(|m| ["--model", m.as_str()]))
        .chain(turn.launch.effort.iter().flat_map(|e| ["--effort", e.as_str()]))
        // `--tools ""` removes every built-in tool, so `dontAsk` refuses whatever isn't in the allowlist.
        .chain(["--permission-mode", "dontAsk", "--tools", "", "--allowedTools", ALLOWED])
        // No user or project settings (hooks, plugins, CLAUDE.md rules, MCP servers) and no skills or slash commands.
        .chain(["--setting-sources", "", "--disable-slash-commands"])
        .chain(["--strict-mcp-config", "--mcp-config"])
        .map(String::from)
        .collect();
    a.extend([mcp_config(&turn.mcp_url), "--append-system-prompt".into(), turn.system.clone()]);
    if let Some(id) = &turn.session {
        a.extend(["--resume".into(), id.clone()]);
    }
    a
}

/// The one stdin line of a stream-json run: the prompt, then each image as an inline base64 block.
pub fn user_message(prompt: &str, images: &[Image]) -> String {
    let blocks: Vec<_> = std::iter::once(json!({ "type": "text", "text": prompt }))
        .chain(images.iter().map(|i| json!({ "type": "image", "source": { "type": "base64", "media_type": i.media_type, "data": i.data } })))
        .collect();
    format!("{}\n", json!({ "type": "user", "message": { "role": "user", "content": blocks } }))
}

pub fn command(turn: &Turn) -> Command {
    let mut cmd = Command::new(&turn.launch.binary);
    turn.launch.env.apply(&mut cmd);
    cmd.args(args(turn))
        .current_dir(&turn.cwd)
        // Launched from inside a Claude Code session, the child would otherwise think it's nested.
        .env_remove("CLAUDECODE")
        .env(TOKEN_ENV, &turn.mcp_token)
        // `--setting-sources` doesn't cover auto memory, which Claude would otherwise put in its prompt.
        .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    fn png() -> Image {
        Image { media_type: "image/png".into(), data: PNG.into() }
    }

    fn request(session: Option<&str>) -> Turn {
        Turn {
            system: "sys".into(),
            mcp_url: "http://127.0.0.1:1/mcp/r".into(),
            mcp_token: "tok".into(),
            cwd: std::env::temp_dir().join(format!("gossamr-claude-args-{}", std::process::id())),
            session: session.map(String::from),
            images: Vec::new(),
            launch: Launch { binary: PathBuf::from("claude"), env: ProviderEnv::none(), model: Some("sonnet".into()), effort: Some("medium".into()) },
        }
    }

    const BUILT_IN_TOOLS: [&str; 18] = [
        "Read", "Grep", "Glob", "Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent",
        "TodoWrite", "Skill", "SlashCommand", "KillShell", "BashOutput", "ExitPlanMode",
    ];

    /// An instance with its own folder: its folder variable set, and the key the shell holds removed.
    fn in_a_folder(mut req: Turn) -> Turn {
        req.launch.env = ProviderEnv::for_test(&[("CLAUDE_CONFIG_DIR", Some("/Users/x/.claude-work")), ("ANTHROPIC_API_KEY", None)]);
        req
    }

    #[test]
    fn claude_is_started_read_only_with_only_the_gossamr_mcp_server() {
        assert_locked_down(&args(&request(None)));
    }

    #[test]
    fn claude_is_started_read_only_for_an_instance_with_a_folder_and_a_model_of_its_own() {
        let mut req = in_a_folder(request(None));
        req.launch.model = Some("claude-opus-5-5[1m]".into());
        req.launch.effort = Some("max".into());
        assert_locked_down(&args(&req));
    }

    fn assert_locked_down(a: &[String]) {
        let after = |flag: &str| a[a.iter().position(|x| x == flag).unwrap() + 1].clone();
        assert_eq!(after("--permission-mode"), "dontAsk");
        assert_eq!(after("--tools"), "", "every built-in tool is off");
        assert_eq!(after("--allowedTools"), "mcp__gossamr");
        assert_eq!(ALLOWED, "mcp__gossamr");
        assert_eq!(after("--setting-sources"), "", "no user, project or local settings, hooks, plugins or memory files");
        assert!(a.contains(&"--disable-slash-commands".to_string()));
        assert!(a.contains(&"--strict-mcp-config".to_string()), "the user's own MCP servers stay out");
        assert!(!a.iter().any(|x| x == "--bg" || x == "--worktree"), "Pip never starts a background session");
        for loosened in ["--add-dir", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--disallowedTools", "--plugin-dir", "--settings", "--agents"] {
            assert!(!a.contains(&loosened.to_string()), "{loosened}");
        }
        let servers: serde_json::Value = serde_json::from_str(&after("--mcp-config")).unwrap();
        assert_eq!(servers["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["gossamr"]);
        assert_eq!(servers["mcpServers"]["gossamr"]["headers"]["Authorization"], "Bearer ${GOSSAMR_MCP_TOKEN}");
    }

    #[test]
    fn the_model_and_effort_come_from_the_launch_and_default_passes_neither() {
        let mut req = request(None);
        req.launch.model = Some("opus".into());
        req.launch.effort = Some("high".into());
        let a = args(&req);
        assert_eq!(a[a.iter().position(|x| x == "--model").unwrap() + 1], "opus");
        assert_eq!(a[a.iter().position(|x| x == "--effort").unwrap() + 1], "high");
        req.launch.model = None;
        req.launch.effort = None;
        let a = args(&req);
        assert!(!a.contains(&"--model".to_string()) && !a.contains(&"--effort".to_string()));
    }

    #[test]
    fn the_instances_login_variables_are_set_or_removed_and_the_rest_of_the_environment_is_the_apps() {
        let cmd = command(&in_a_folder(request(None)));
        let envs: Vec<_> = cmd.as_std().get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        assert!(envs.contains(&("CLAUDE_CONFIG_DIR".into(), Some("/Users/x/.claude-work".into()))));
        assert!(envs.contains(&("ANTHROPIC_API_KEY".into(), None)), "removed, so the app's own key can't override the folder");
        assert!(envs.iter().any(|(k, v)| k == TOKEN_ENV && v.is_some()));
        assert!(envs.iter().any(|(k, v)| k == "CLAUDE_CODE_DISABLE_AUTO_MEMORY" && v.is_some()));
        assert!(!envs.iter().any(|(k, _)| k == "PATH"), "nothing else of the environment is copied or cleared");
        assert_eq!(cmd.as_std().get_program(), "claude");
    }

    #[test]
    fn the_token_is_in_the_childs_environment_and_nowhere_in_its_arguments() {
        let mut req = request(Some("s-1"));
        req.mcp_token = "tok-7f3a91c2".into();
        req.images = vec![png()];
        let cmd = command(&req);
        let cmd = cmd.as_std();
        let argv: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!argv.iter().any(|a| a.contains("tok-7f3a91c2")), "the token must not reach ps");
        assert!(cmd.get_envs().any(|(k, v)| k == TOKEN_ENV && v == Some("tok-7f3a91c2".as_ref())));
        assert!(argv.iter().any(|a| a.contains("${GOSSAMR_MCP_TOKEN}")), "the config names the variable Claude expands");
    }

    #[test]
    fn images_change_only_how_the_prompt_is_sent() {
        let plain = args(&request(Some("s-1")));
        let mut with = request(Some("s-1"));
        with.images = vec![png()];
        let mut a = args(&with);
        let at = a.iter().position(|x| x == "--input-format").unwrap();
        assert_eq!(a[at + 1], "stream-json");
        a.drain(at..at + 2);
        assert_eq!(a, plain, "the lockdown flags, MCP config and system prompt are untouched");
        let mut full = args(&with);
        let mcp = full.iter().position(|x| x == "--mcp-config").unwrap();
        assert!(full.iter().position(|x| x == "--input-format").unwrap() < mcp, "the flag must not land between --mcp-config and its value");
        assert!(serde_json::from_str::<serde_json::Value>(&full.remove(mcp + 1)).is_ok());
        assert!(!plain.contains(&"--input-format".to_string()));
    }

    #[test]
    fn the_stream_json_message_is_the_text_then_inline_base64_images() {
        let line = user_message("What is this?", &[png()]);
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0], json!({ "type": "text", "text": "What is this?" }));
        assert_eq!(
            content[1],
            json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG } })
        );
    }

    #[test]
    fn it_runs_in_the_sandbox_with_auto_memory_off() {
        let req = request(None);
        let cmd = command(&req);
        let cmd = cmd.as_std();
        assert_eq!(cmd.get_current_dir(), Some(req.cwd.as_path()));
        assert!(cmd.get_envs().any(|(k, v)| k == "CLAUDE_CODE_DISABLE_AUTO_MEMORY" && v == Some("1".as_ref())));
    }

    #[test]
    fn no_built_in_tool_is_named_in_the_tool_flags() {
        let a = args(&request(None));
        for flag in ["--tools", "--allowedTools"] {
            let value = &a[a.iter().position(|x| x == flag).unwrap() + 1];
            for tool in BUILT_IN_TOOLS {
                assert!(!value.contains(tool), "{flag} names {tool}");
            }
        }
    }

    #[test]
    fn a_session_is_resumed_only_when_one_is_given() {
        assert!(!args(&request(None)).contains(&"--resume".to_string()));
        let a = args(&request(Some("s-1")));
        assert_eq!(a[a.iter().position(|x| x == "--resume").unwrap() + 1], "s-1");
    }

    /// The real CLI expands `${GOSSAMR_MCP_TOKEN}` from its environment into the Authorization header. Runs under a
    /// fresh, logged-out config dir, so nothing of the person's is used; the CLI connects to the MCP server and then
    /// stops at the missing login. `cargo test -- --ignored claude_code_sends_the_token_from_its_environment`.
    #[tokio::test]
    #[ignore]
    async fn claude_code_sends_the_token_from_its_environment() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await.unwrap_or(0);
                sink.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]).to_lowercase());
                let _ = sock.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
            }
        });
        let mut req = request(None);
        (req.mcp_url, req.mcp_token) = (format!("http://127.0.0.1:{port}/mcp/r"), "tok-probe-5d1e".into());
        let config = std::env::temp_dir().join(format!("gossamr-claude-token-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&config).unwrap();
        req.launch.binary = crate::binary::find_claude().expect("claude installed");
        let mut cmd = command(&req);
        let mut child = cmd.env("CLAUDE_CONFIG_DIR", &config).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn().unwrap();
        child.stdin.take().unwrap().write_all(b"hi").await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(60), child.wait()).await;
        let _ = child.kill().await;
        server.abort();
        let _ = std::fs::remove_dir_all(&config);
        assert!(seen.lock().unwrap().contains("authorization: bearer tok-probe-5d1e"));
    }
}
