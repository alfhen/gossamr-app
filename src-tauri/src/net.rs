//! The one HTTP client constructor, so every service gets the same timeouts.

use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Shorter than the idle limits of typical NATs and proxies, so a connection that went quiet during sleep or a network
/// change is dropped from the pool instead of reused.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const TCP_KEEPALIVE: Duration = Duration::from_secs(30);

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("gossamr/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .pool_idle_timeout(POOL_IDLE_TIMEOUT)
        .tcp_keepalive(TCP_KEEPALIVE)
        .build()
        .expect("static client configuration")
}
