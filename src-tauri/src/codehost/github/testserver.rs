//! A local HTTP server for tests: replies are scripted per request target and every request is recorded.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn ok(body: &str) -> Self {
        Self { status: 200, headers: vec![], body: body.into() }
    }

    pub fn status(status: u16, body: &str) -> Self {
        Self { status, headers: vec![], body: body.into() }
    }

    /// Closes the connection after reading the request, answering nothing.
    pub fn hang_up() -> Self {
        Self::status(0, "")
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

type Route = (String, Vec<Reply>, usize);

pub struct Server {
    pub base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    pub fn targets(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|s| s.target.clone()).collect()
    }

    pub fn header_of(&self, n: usize, name: &str) -> Option<String> {
        self.seen.lock().unwrap().get(n).and_then(|s| s.headers.get(name).cloned())
    }
}

/// Serves the replies registered for a request target (path and query), in order, repeating the last. A target with
/// no entry falls back to its path alone, then to 404.
pub async fn serve(routes: Vec<(&str, Vec<Reply>)>) -> Server {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let routes: Arc<Mutex<Vec<Route>>> = Arc::new(Mutex::new(routes.into_iter().map(|(t, r)| (t.to_string(), r, 0)).collect()));
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let body_start = loop {
                let n = stream.read(&mut chunk).await.unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
                if n == 0 {
                    break buf.len();
                }
            };
            let head = String::from_utf8_lossy(&buf[..body_start]).to_string();
            let length = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                .unwrap_or(0);
            while buf.len() < body_start + length {
                let n = stream.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let mut lines = head.lines();
            let mut first = lines.next().unwrap_or("").split_whitespace();
            let (method, target) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
            let headers = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
                .collect();
            log.lock().unwrap().push(Seen { method, target: target.clone(), headers, body: String::from_utf8_lossy(&buf[body_start..]).to_string() });
            let reply = {
                let mut routes = routes.lock().unwrap();
                let path = target.split('?').next().unwrap_or("").to_string();
                let index = routes.iter().position(|(t, _, _)| *t == target).or_else(|| routes.iter().position(|(t, _, _)| *t == path));
                index.map(|i| {
                    let (_, replies, used) = &mut routes[i];
                    let r = replies[(*used).min(replies.len() - 1)].clone();
                    *used += 1;
                    r
                })
            }
            .unwrap_or_else(|| Reply::status(404, "{\"message\":\"Not Found\"}"));
            if reply.status == 0 {
                continue;
            }
            let mut response = format!("HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, reply.body.len());
            for (k, v) in &reply.headers {
                response.push_str(&format!("{k}: {v}\r\n"));
            }
            response.push_str("\r\n");
            response.push_str(&reply.body);
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    Server { base, seen }
}
