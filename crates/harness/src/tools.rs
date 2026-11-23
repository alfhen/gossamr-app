//! The session's tools endpoint, in-process. H5a serves it over HTTP on loopback with the same token rule; until then
//! the mock calls it here. A call of a client tool becomes a `client_tool_call` event that the client answers, and the
//! session cuts it at the provider's tool-call limit, as the provider would.

use std::fmt;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

pub struct Endpoint {
    token: String,
    calls: UnboundedSender<ToolCall>,
}

pub(crate) struct ToolCall {
    pub name: String,
    pub input: Value,
    pub reply: oneshot::Sender<Result<Reply, String>>,
}

/// What the client posted for a call.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub output: Value,
    pub error: bool,
}

impl Endpoint {
    pub(crate) fn new(token: &str, calls: UnboundedSender<ToolCall>) -> Endpoint {
        Endpoint { token: token.to_owned(), calls }
    }

    /// An endpoint that belongs to no session: every call fails. For driving a driver on its own.
    pub fn unattached(token: &str) -> Endpoint {
        Endpoint::new(token, tokio::sync::mpsc::unbounded_channel().0)
    }

    /// Calls a tool the client declared, as the agent would. It returns when the client posts the result, or with an
    /// error when the call is cut at the tool-call limit, the session ends, or `token` is not this start's.
    pub async fn call(&self, token: &str, name: &str, input: Value) -> Result<Reply, String> {
        if token != self.token {
            return Err("this token does not open this session's tools".into());
        }
        let (reply, answer) = oneshot::channel();
        let ended = || "the session has ended".to_owned();
        self.calls.send(ToolCall { name: name.to_owned(), input, reply }).map_err(|_| ended())?;
        answer.await.unwrap_or_else(|_| Err(ended()))
    }
}

impl fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Endpoint(..)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tools_a_call_with_another_token_is_refused_and_one_with_no_session_fails() {
        let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
        let endpoint = Endpoint::new("this-start", calls);
        // A call that got through would wait for a client that never answers.
        let refused = tokio::time::timeout(std::time::Duration::from_secs(1), endpoint.call("an-old-start", "ask", Value::Null))
            .await
            .expect("a refused call returns at once");
        assert_eq!(refused, Err("this token does not open this session's tools".to_owned()));
        assert!(received.try_recv().is_err(), "a refused call reaches nobody");
        let unattached = Endpoint::unattached("t").call("t", "ask", Value::Null).await;
        assert_eq!(unattached, Err("the session has ended".to_owned()));
    }
}
