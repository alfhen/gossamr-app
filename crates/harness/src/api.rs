//! The client API: JSON text messages on a WebSocket, over a Unix socket in the data folder. The harness speaks
//! first with a [`Hello`]; the client answers it ([`Proof`]) and then sends [`Call`]s. The harness answers each call
//! by its id, and pushes the events of the sessions the client opened or watches.
//!
//! Limits: a message is at most [`MAX_MESSAGE`] each way, and at most [`BEFORE_PROOF_MAX`] until the proof holds. The
//! client module refuses to send a larger call and the connection goes on; a larger message from another client closes
//! its connection with code 1009. An
//! event's body is at most `event::EVENT_MAX`; a larger one is cut and says by how much. `events` answers in pages of
//! about [`PAGE_BYTES`].
//!
//! At most `harness serve --turn-limit <n>` sessions are in a turn at once, across every client: a prompt past it
//! waits, and its session says `waiting` until a turn ends and frees a slot, first come first served. A turn the agent
//! starts unprompted counts at once, past the limit too: it has begun, and nothing holds it back.
//!
//! A start of a session ends with a `closed` event, whose `by` (`event::ClosedBy`) says why: `shutdown` (the harness
//! went down and stopped it, a turn it cut among them), `stop` (a client's `close`), `hand_over`, `agent` (the agent
//! exited or crashed by itself, a fault signal or a SIGKILL from outside among them, or its driver failed), `signal`
//! (SIGTERM, SIGHUP or SIGINT, which a logout or a restart sends first, ended the agent and the harness did not send it), `client_left` (it ended with its client), `harness` (the harness could not go on with it), or `harness_went` (the harness went without a shutdown, and the next one ended the start it left). `signal`
//! needs a driver that says how its agent ended (`Driver::open_reporting`); with one that does not, such an end reads
//! as `agent`. When more than one holds, a request the harness took (`stop`, `shutdown`, `hand_over`, `client_left`)
//! wins, even one the agent's going overtook, then `harness`, then `signal`, then `agent`. `harness_went` holds alone: only the next harness writes it, for a start that has no `closed`. A locked session's `closed`, and one the sweep reached, arrives as `withheld` with `of: "closed"` and
//! `kept.by`. A reader takes a value it does not know, or a `closed` from a harness that did not say, as `unknown`, so
//! a later value needs no new protocol. Some starts end with no stored `closed`: one a shutdown gave up on, whose last
//! event is `failed` with kind `stuck` (its agent may still run), and one whose harness was killed or crashed.
//! A start whose harness was killed or crashed gets its end later: when the next harness stops the agent it left, or
//! finds it and its group gone, it appends `failed` (kind `agent_stopped`) and `closed` with `by: harness` to that old
//! start's events, so a client reading them after a restart sees them arrive after events from before it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::event::{Decision, Event};

/// The largest message either side sends or takes. A client's call over it is refused before it is sent.
pub const MAX_MESSAGE: usize = 8 << 20;
/// The largest message a connection may send before its proof holds. A proof is about 80 bytes.
pub const BEFORE_PROOF_MAX: usize = 4096;
/// About how much one `events` answer holds: the stored payload of its events.
pub const PAGE_BYTES: usize = 4 << 20;

/// Changes when a client of the last protocol could no longer talk to this harness. The hello, the proof, the answer to
/// the proof (`client::not_proven` reads its refusal) and `shutdown`, still behind the proof, keep their shape in every
/// protocol, so an app of one protocol can stop a harness of another without killing a process it cannot prove is that
/// harness.
pub const PROTOCOL: u32 = 1;
pub const SOCKET: &str = "harness.sock";
/// The descriptor file beside the socket, while the harness serves.
pub const DESCRIPTOR: &str = "harness.json";
/// The bytes a Unix socket path may have, with its closing zero: `sun_path` is 104 bytes on macOS and 108 on Linux.
pub const SOCKET_PATH_MAX: usize = if cfg!(target_os = "macos") { 104 } else { 108 };

/// The socket's path in the data folder `dir`, or why the platform cannot take it.
pub fn socket_path(dir: &Path) -> Result<PathBuf> {
    let path = dir.join(SOCKET);
    let len = path.as_os_str().len();
    if len >= SOCKET_PATH_MAX {
        return Err(Error::SocketPathTooLong { path, len, max: SOCKET_PATH_MAX - 1 });
    }
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub build: String,
    /// 32 random bytes in hex, new for each connection.
    pub challenge: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    pub proof: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Descriptor {
    pub protocol: u32,
    pub build: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Answers `{"session": id}` once the agent has opened. The client gets the session's events from the first.
    /// Every field but `provider` may be left out. Before any agent starts, and before anything is cloned, the
    /// harness refuses with the reason: a provider it has no driver for; both `cwd` and `repo`, or neither; `base` or
    /// `branch` without `repo`; a `repo` that is not `owner/name` of letters, digits, `.`, `_` and `-` (`valid_repo`);
    /// a `base` or `branch` that is not one plain folder name (`work::valid_ref`: no slash, no `..`, not starting with
    /// `-` or `.`); a `login` its provider has no folder for, that breaks the folder rules of `provider_folder`, or
    /// that is not there; an `effort` that is not a lowercase word of at most 16 letters.
    Open {
        provider: String,
        /// The folder the agent works in, used as it is. Give this or `repo`.
        #[serde(default)]
        cwd: Option<PathBuf>,
        /// `owner/name` on GitHub. The harness clones it into its work root (`~/Gossamr/agents`), or fetches the clone
        /// there, and the agent works in a new worktree beside it. Give this or `cwd`.
        #[serde(default)]
        repo: Option<String>,
        /// With `repo`: the remote branch the worktree starts from. Left out, the remote's default branch.
        #[serde(default)]
        base: Option<String>,
        /// With `repo`: the new branch of the worktree. Left out, `harness-` and 8 hex digits. A branch or folder that
        /// is already there is refused. Clean-up removes both, never forcing: unpushed work stays, and so does the session.
        #[serde(default)]
        branch: Option<String>,
        #[serde(default)]
        locked: bool,
        #[serde(default)]
        model: Option<String>,
        /// The login folder, as typed (`~` allowed). Left out, the provider's usual setup, as the person's shell has it.
        #[serde(default)]
        login: Option<String>,
        /// Left out, the provider's own.
        #[serde(default)]
        effort: Option<String>,
        /// Who settles the agent's permission prompts first: `ask` (left out) sends each to the client; `auto` starts the
        /// provider's auto mode, where its driver has one (Claude's `--permission-mode auto`), on every start and
        /// resume, and only what that leaves comes to the client. A locked session ignores it.
        #[serde(default)]
        permissions: crate::driver::Permissions,
        /// The session is closed when this connection ends, and is never resumed.
        #[serde(default)]
        ends_with_client: bool,
        /// The tools this client offers the agent, on the session's tools endpoint. Each call is a `client_tool_call`
        /// event the client answers with `tool_result`; while no client listens to the session, a call fails at once.
        /// Refused: more than `tools::MAX_TOOLS`, a name that is not 1 to `tools::TOOL_NAME_MAX` (43) letters, digits, `_`
        /// and `-` (so the full name a provider sees stays within its 64), a name twice,
        /// `result` or `ask`, an input schema that is not an object.
        #[serde(default)]
        tools: Vec<crate::tools::ToolSpec>,
        /// A JSON Schema the session's `result` must fit; left out, any object. It is the input schema of the endpoint's
        /// `result` tool, so its top level is `"type": "object"`. The harness checks this part of JSON Schema (`schema`):
        /// `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, or a list of them),
        /// `properties`, `required`, `additionalProperties` (a boolean or a schema), `items` (one schema), `enum`,
        /// `const`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`; it reads `title`,
        /// `description`, `default`, `examples`, `$schema` and `$comment` as notes. Any other keyword is refused here,
        /// with where it is; `schema`'s first comment lists the forms it refuses that JSON Schema allows. A result that
        /// does not fit goes back to the agent with the reasons; one that fits is a `result` event. Each `result` the
        /// harness takes is an event, and the last one before the session ends is the one that counts. `result` is
        /// refused while a question is open: a `question` event no one has answered (an open permission request does
        /// not count). Text that looks like a secret is masked before it is kept, and a result that no longer fits once
        /// masked is refused with the reason. A session whose stored schema no longer passes the check is not resumed.
        #[serde(default)]
        result_schema: Option<Value>,
    },
    Send { session: String, text: String },
    Cancel { session: String },
    Answer {
        session: String,
        request: String,
        decision: Decision,
        #[serde(default)]
        message: Option<String>,
    },
    ToolResult {
        session: String,
        call: String,
        output: Value,
        #[serde(default)]
        error: bool,
    },
    /// Answers an open question, once: to the agent's `ask` call if the harness still holds it, else as the next prompt
    /// after the running turn. The question closes as its answer is delivered, so an answer still waiting when the
    /// harness shuts down leaves it open, to be answered again after the restart. A session that is not running is
    /// resumed first, with a new tools token. A question that Stop, a hand-over, the deny that ended the turn that
    /// asked it, a clean-up or a resume refused for good closed is refused.
    AnswerQuestion { session: String, question: String, text: String },
    Close { session: String },
    /// Closes the session as handed over to Terminal, keeping its provider id for a later resume. It answers once the
    /// hand-over is taken, even if the agent goes before the session reads it, but only the `handed_over` event
    /// confirms it: the session is marked as handed over, says `handed_over`, then closes `by: hand_over`. A `closed`
    /// with `by: harness` and no `handed_over` after an Ok answer means the store would not keep the mark, and it was
    /// not done. It is refused for a session already stopping.
    HandOver { session: String },
    /// Answers `{"session": id}` once a session that is not running has opened again, with a new tools token, and
    /// watches it on this connection from its next event, as `open` does, so a locked session's client misses none.
    /// Waits for the connection's shell first. The harness calls this after a restart (H10), or the app when the
    /// person asks. With `carry_on`, that text is the next prompt, checked and sent in one step of the session, so no
    /// question, permission request, stop or hand-over gets in between; a blank one is refused. Refused with the
    /// reason: a session cleaned up, one that ended with its client, one marked as one that cannot be resumed, one
    /// handed over and not taken back, one whose worktree another session holds, one given up on because its agent or
    /// a process it started may still run (each resume checks that agent again, and frees the session once it is gone;
    /// the reason names its process group, why, and what to do, and is the row's `given_up`), and every session while the harness could not check for agents an earlier harness left running
    /// (each resume checks again, and the reason is the rows' `held`); and with `carry_on`, one with an open question, or one whose last stop, deny-ended turn,
    /// cancelled turn or open permission request forbids it. A cancel forbids it because "carry on" would undo it;
    /// the next turn lifts each mark.
    Resume {
        session: String,
        #[serde(default)]
        carry_on: Option<String>,
    },
    /// Resumes a session handed over to Terminal, and watches it, as `resume` does. The app sends it only on the
    /// person's word that they took the session back from Terminal; until then `resume` refuses it. One never handed
    /// over is refused: resume it. Refused, as `resume` is, while the rows say `held` or the row says `given_up`.
    TakeBack { session: String },
    /// Refused while the session runs, for one given up on, whose agent may still work in its worktree (checked again
    /// first, as `resume` does), and, as `resume` is, while the rows say `held`.
    CleanUp { session: String },
    /// Answers the list of sessions (`store::Listed`). A row's `open_question` is the id of the question its agent
    /// asked through `ask` that is still open, or null, so a client that reconnects need not read the events for it.
    /// A row's `held`, left out when there is none, says why no session may be resumed now: the harness could not check
    /// for agents an earlier harness left running, so one may still run. It is the text `resume` refuses with. A row's
    /// `given_up`, left out when there is none, says why this session is not resumed, taken back or cleaned up: its
    /// agent or a process it started may still run, and why the harness could not stop it (a shutdown that stopped
    /// waiting, a group it may not signal, a process in it that works outside the worktree...), and what to do. It
    /// is the text `resume` refuses with; each of those calls checks again first.
    Sessions,
    /// Answers `{"drivers": [...], "logins": [...]}`: each driver's name and capabilities, and how each login stands
    /// (`providers::Standing`): the usual setup of every provider of the table, then each of `logins`. A login is
    /// checked with its CLI's own status command and the shell this connection captured.
    Providers {
        #[serde(default)]
        logins: Vec<crate::providers::Asked>,
    },
    /// Answers `{"events": [...], "more": bool}`: the stored events after `after`, about `PAGE_BYTES` of them. With
    /// `more`, ask again after the last one.
    Events { session: String, #[serde(default)] after: u64 },
    /// Pushes the stored events after `after`, then every live one until the session closes, then an end.
    Watch { session: String, #[serde(default)] after: u64 },
    /// Adds a token by its stored key, in hex. The client keeps the token; it never crosses the socket.
    TokenNew { stored_key: String },
    /// Answers each token's id and when it was made, and which one this connection proved: never a key.
    TokenList,
    /// Revokes a token; its connections are closed at their next call. The last token cannot be revoked.
    TokenRevoke { token: i64 },
    /// Stops every session and the harness, and frees the data folder; answers once that is done.
    Shutdown,
}

/// What the harness sends after the hello: an answer to a call (`id` with `ok` or `error`), an event of a session
/// (`session` with `event`), or the end of a watch (`session` with `end`). The answer to a proof has no id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<Event>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub end: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_a_call_keeps_its_own_id_whatever_its_op_holds() {
        // An op's field named `id` would collide with the call's own once flattened into it.
        for op in [Op::TokenRevoke { token: 5 }, Op::Answer { session: "s".into(), request: "p1".into(), decision: Decision::Allow, message: None }, Op::Sessions] {
            let call = Call { id: 7, op };
            let text = serde_json::to_string(&call).unwrap();
            assert_eq!(text.matches("\"id\"").count(), 1, "{text}");
            assert_eq!(serde_json::from_str::<Call>(&text).unwrap(), call);
        }
    }
}
