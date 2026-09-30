use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

use crate::error::{Error, Result};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// A connection that doesn't send its request line quickly is dropped, so it can't hold up the real redirect.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REQUEST_HEAD: usize = 8192;

/// A local listener for one browser sign-in's redirect.
pub struct Loopback {
    v4: TcpListener,
    v6: Option<TcpListener>,
    state: String,
}

impl Loopback {
    pub async fn bind(port: u16) -> Result<Self> {
        let state = random_state()?;
        let v4 = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| Error::Auth(format!("port {port} is busy ({e})")))?;
        // Browsers may resolve localhost to ::1 first, so listen there too when available.
        let v6 = TcpListener::bind(("::1", port)).await.ok();
        Ok(Self { v4, v6, state })
    }

    pub fn state(&self) -> &str {
        &self.state
    }

    pub async fn code(&self) -> Result<String> {
        tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(&self.v4, self.v6.as_ref(), &self.state))
            .await
            .map_err(|_| Error::Auth("timed out waiting for the browser".into()))?
    }
}

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    /// A response to this sign-in that ends it, e.g. the user declined.
    Failed(String),
    /// A request that isn't the redirect for this sign-in. Answer it and keep waiting.
    Rejected(String),
    Ignore,
}

/// Parses the request line of the redirect, e.g. `GET /callback?code=…&state=… HTTP/1.1`.
fn parse_callback(request_line: &str, expected_state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Callback::Ignore;
    };
    let Ok(url) = Url::parse(&format!("http://localhost{target}")) else {
        return Callback::Ignore;
    };
    if url.path() != "/callback" {
        return Callback::Ignore;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    // Only a response carrying this sign-in's state may end it; otherwise any local page could cancel the login.
    if param("state").as_deref() != Some(expected_state) {
        return Callback::Rejected("the sign-in response did not match this request".into());
    }
    if let Some(err) = param("error") {
        return Callback::Failed(param("error_description").unwrap_or(err));
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Failed("no authorisation code in the response".into()),
    }
}

/// Reads up to the end of the request headers, bounded in size and time.
async fn read_request_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let read = async {
        let mut chunk = [0u8; 1024];
        while buf.len() < MAX_REQUEST_HEAD && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    };
    tokio::time::timeout(REQUEST_TIMEOUT, read).await.ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

async fn wait_for_code(v4: &TcpListener, v6: Option<&TcpListener>, state: &str) -> Result<String> {
    loop {
        let mut stream = accept(v4, v6).await?;
        let Some(request) = read_request_head(&mut stream).await else { continue };
        let line = request.lines().next().unwrap_or_default();
        match parse_callback(line, state) {
            Callback::Ignore => respond(&mut stream, "404 Not Found", "Not found").await,
            Callback::Rejected(msg) => respond(&mut stream, "400 Bad Request", &msg).await,
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", "Signed in to Gossamr. You can close this tab.").await;
                return Ok(code);
            }
            Callback::Failed(msg) => {
                respond(&mut stream, "400 Bad Request", &format!("Sign-in failed: {msg}")).await;
                return Err(Error::Auth(msg));
            }
        }
    }
}

async fn accept(v4: &TcpListener, v6: Option<&TcpListener>) -> std::io::Result<TcpStream> {
    match v6 {
        Some(v6) => tokio::select! {
            r = v4.accept() => r.map(|(s, _)| s),
            r = v6.accept() => r.map(|(s, _)| s),
        },
        None => v4.accept().await.map(|(s, _)| s),
    }
}

async fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Gossamr</title>\
         <body style=\"font:15px system-ui;display:grid;place-items:center;height:90vh\">{}</body>",
        html_escape(message)
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn random_state() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| Error::Auth(format!("no randomness available: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_callback() {
        assert_eq!(
            parse_callback("GET /callback?code=c0de&state=st HTTP/1.1", "st"),
            Callback::Code("c0de".into())
        );
    }

    #[test]
    fn a_mismatched_state_is_rejected_without_ending_the_sign_in() {
        assert!(matches!(parse_callback("GET /callback?code=c&state=other HTTP/1.1", "st"), Callback::Rejected(_)));
        assert!(matches!(parse_callback("GET /callback?code=c HTTP/1.1", "st"), Callback::Rejected(_)));
        assert!(matches!(parse_callback("GET /callback?error=access_denied&state=other HTTP/1.1", "st"), Callback::Rejected(_)));
    }

    #[test]
    fn a_matching_response_without_a_code_fails() {
        assert!(matches!(parse_callback("GET /callback?state=st HTTP/1.1", "st"), Callback::Failed(_)));
    }

    #[test]
    fn reports_a_denied_consent() {
        assert_eq!(
            parse_callback("GET /callback?error=access_denied&error_description=User%20denied&state=st HTTP/1.1", "st"),
            Callback::Failed("User denied".into())
        );
    }

    #[test]
    fn ignores_other_requests() {
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", "st"), Callback::Ignore);
        assert_eq!(parse_callback("POST /callback HTTP/1.1", "st"), Callback::Ignore);
        assert_eq!(parse_callback("", "st"), Callback::Ignore);
    }

    #[tokio::test]
    async fn keeps_waiting_past_stray_and_silent_connections() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let waiter = tokio::spawn(async move { wait_for_code(&listener, None, "st").await });

        let _silent = TcpStream::connect(addr).await.unwrap();
        let mut stray = TcpStream::connect(addr).await.unwrap();
        stray.write_all(b"GET /callback?code=evil&state=nope HTTP/1.1\r\n\r\n").await.unwrap();
        let mut real = TcpStream::connect(addr).await.unwrap();
        // Sent in two pieces to check the head is accumulated before parsing.
        real.write_all(b"GET /callback?code=go").await.unwrap();
        real.write_all(b"od&state=st HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();

        let code = tokio::time::timeout(Duration::from_secs(15), waiter).await.unwrap().unwrap().unwrap();
        assert_eq!(code, "good");
    }

    #[test]
    fn state_is_random_hex() {
        let (a, b) = (random_state().unwrap(), random_state().unwrap());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
