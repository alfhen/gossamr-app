//! On its own in this file, because it sets variables of the test process before any thread starts.

mod common;

use std::sync::Arc;

use common::*;
use harness::cli::TOKEN_VARIABLE;
use harness::driver::Driver;
use harness::event::Body;
use harness::session::Harness;
use harness::store::Store;
use harness::work::Setup;

#[test]
fn env_an_agent_gets_what_the_login_shell_sets_and_nothing_the_harness_inherited() {
    // SAFETY: the only test in this binary, before its runtime or any other thread starts.
    unsafe {
        std::env::set_var("CLAUDECODE", "1");
        std::env::set_var("CLAUDE_CODE_ENTRYPOINT", "claude-desktop");
        std::env::set_var("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
        std::env::set_var("SSH_AUTH_SOCK", "/tmp/agent-for-the-test.sock");
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let (tmp, dir) = data_dir();
        // The person's start file exports one variable, and a client token by mistake.
        let body = format!("export FROM_START_FILE=yes {TOKEN_VARIABLE}=from-the-start-file; printf '\\0GOSSAMR_ENV_BEGIN\\0'; env -0");
        let shell = harness::testing::fake_cli(&tmp.path().join("bin/fakeshell"), &body);
        let setup = Setup::new(None, dir.clone()).with_shell_program(&shell.to_string_lossy());
        setup.capture().await.unwrap();
        let mock = mock("{\"prompt\": null}");
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
        let harness = Harness::with_setup(Store::open(&dir).unwrap(), drivers, settings(4), Arc::new(setup));
        let (_, mut events) = open(&harness, false).await;
        let Body::Started { provider_session, .. } = next(&mut events).await.body else { panic!("expected started") };
        let env = mock.env(&provider_session);
        let value = |name: &str| env.iter().find(|(key, _)| key == name).map(|(_, value)| value.to_string_lossy().into_owned());
        for inherited in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_BASE_URL"] {
            assert_eq!(value(inherited), None, "{inherited} came from the harness's own environment");
        }
        assert_eq!(value("FROM_START_FILE").as_deref(), Some("yes"), "what the start file sets reaches the agent");
        assert_eq!(value("SSH_AUTH_SOCK").as_deref(), Some("/tmp/agent-for-the-test.sock"), "git over SSH keeps the agent");
        assert_eq!(value(TOKEN_VARIABLE), None, "a client token never reaches the agent");
    });
}
