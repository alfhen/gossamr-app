//! On its own in this file, because it sets a variable of the test process before any thread starts.

mod common;

use common::*;
use harness::cli::TOKEN_VARIABLE;
use harness::event::Body;

#[test]
fn env_an_agent_gets_the_harness_environment_without_a_client_token() {
    // SAFETY: the only test in this binary, before its runtime or any other thread starts.
    unsafe {
        std::env::set_var(TOKEN_VARIABLE, "a-client-token-the-agent-must-not-see");
        std::env::set_var("HARNESS_ENV_TEST_MARK", "kept");
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let (_tmp, dir) = data_dir();
        let mock = mock("{\"prompt\": null}");
        let harness = harness(&dir, &mock, 4);
        let (_, mut events) = open(&harness, false).await;
        let Body::Started { provider_session, .. } = next(&mut events).await.body else { panic!("expected started") };
        let env = mock.env(&provider_session);
        assert!(!env.iter().any(|(name, _)| name == TOKEN_VARIABLE), "no client token in the agent's environment");
        assert!(env.iter().any(|(name, value)| name == "HARNESS_ENV_TEST_MARK" && value == "kept"), "the rest is passed on");
    });
}
