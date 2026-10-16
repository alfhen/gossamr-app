//! Answering a run's permission prompt from Gossamr: Deny, delivered to the session, and Allow once, which the person
//! gives in Terminal.
//!
//! Read from `claude --help` and the help of `claude agents`, `attach`, `logs`, `respawn` and `stop` (Claude Code
//! 2.1.296), nothing launched: there is no supported way to answer a pending permission prompt of a background session
//! from outside it. `agents` only lists (`--json`) or opens its own screen, `attach` is interactive, `logs` only reads,
//! `respawn` restarts, and `--permission-prompt-tool` and `--permission-prompts` apply only with `--print`. An allow
//! rule on resume can't be used either: any flag on `--bg --resume` makes `claude` start a copy, and a copy is a new
//! job without the run's saved flags (see `runs/answer.rs`), so `--allowedTools` is never passed there.
//!
//! - **Deny** is delivered for real, exactly as an answer is: the session is stopped and woken in place with a fixed
//!   message (`DENIED_MESSAGE`) that tells the agent the person did not allow the request, that it must not run it or
//!   anything that does the same, and that it carries on without it. Stopping the session drops the pending prompt,
//!   so the request is never run. Deny is offered for every prompt, read-only runs included.
//! - **Allow once** can't be delivered by Gossamr. Choosing it checks the policy below, records the person's choice
//!   with the exact command, and opens the session in Terminal (`claude attach`), where the person picks Claude Code's
//!   own one-time "Yes" for exactly that command. Gossamr never stops or resumes the session for it, and it never
//!   writes an allow rule anywhere.
//!
//! The policy (`offer`): Allow is offered only for the exact tool and command the agent asked for, never a pattern,
//! and only when the request reached Gossamr whole. A read-only run never gets it: Claude Code refuses anything that
//! isn't on its exact allow list, and the deny list beats that. A Build gets it except for what Gossamr itself forbids
//! a Build: pushing anything but its own branch, opening a pull request that isn't a draft, merging, readying,
//! reviewing or closing one or any other write to GitHub, changing git's settings, remotes or hooks, Gossamr's own
//! tools and another server's. The check is conservative, since Gossamr reads the command as text and the shell does
//! not: a command that mentions git and push in any spelling is a push, and only the whole command `git push origin
//! <its branch>` is allowed; a command whose words Gossamr can't read as the shell will (a command inside it, code
//! for an interpreter, `eval`, a program named by a variable, an escape) isn't offered Allow at all. Beyond those
//! rules a Build's Bash command is offered Allow only when it is plain (`plain`): every command in it one of a short list
//! of programs that run nothing else, with nothing the shell would read differently from Gossamr and paths that stay
//! inside the checkout. A file tool gets it only for a path inside the checkout, and any other tool (a fetch, a
//! search) is `Unchecked` too. Anything else is `Unchecked`, answered in Terminal: a list of what to refuse can always be
//! talked around, a list of what to allow can't. Allow and Deny
//! are the person's alone: Pip has no tool for them, and nothing that runs on its own answers a prompt.

use chrono::Utc;
use serde::Serialize;

use super::answer::back_at_work;
use super::cli::is_uuid;
use super::service::{belongs_to, RunService};
use crate::domain::{PermissionAllowed, Run, RunEvent, RunKind, RunState};
use crate::error::{Error, Result};

/// What a read-only run's prompt says instead of Allow.
pub const READ_ONLY_REFUSES: &str = "This run is read-only: Claude Code refuses this.";
/// Why Allow isn't offered for a request Gossamr may not have whole.
pub const NOT_EXACT: &str = "Gossamr can't show this request whole, so it doesn't offer Allow. Open it in Terminal to read it there.";
pub const HAS_COMMAND_INSIDE: &str = "This command has a command inside it, so Gossamr can't check what it runs: Gossamr doesn't allow this.";
pub const PUSH_NOT_APPROVED: &str = "This Build wasn't approved to push: Gossamr doesn't allow this.";
pub const DRAFT_PR_ONLY: &str = "A Build opens only a draft pull request, with --draft: Gossamr doesn't allow this.";
pub const NEVER_MERGES: &str = "A Build never merges, readies, reviews or closes its pull request: Gossamr doesn't allow this.";
pub const NO_GOSSAMR_TOOLS: &str = "A run never uses Gossamr's own tools: Gossamr doesn't allow this.";
pub const NO_OTHER_SERVERS: &str = "Gossamr can't check what another server's tool does, such as a write to GitHub or Jira: Gossamr doesn't allow this.";
pub const GITHUB_READS_ONLY: &str = "A Build only reads GitHub, besides opening its draft pull request: Gossamr doesn't allow this.";
pub const NO_GIT_SETTINGS: &str = "A Build never changes its repository's git settings, remotes or hooks: Gossamr doesn't allow this.";
pub const HAS_ESCAPES: &str = "This command has escaped characters, so Gossamr can't check what it runs: Gossamr doesn't allow this.";
/// Why Allow isn't offered for a Build's command that isn't one of the plain ones Gossamr can check.
pub const UNCHECKED: &str = "Gossamr offers Allow once only for commands it can check are safe, such as git status or ls inside the run's folder. It can't check this one. Open the run in Terminal to read it and answer it there.";

/// Why a push other than the Build's own branch, or a force push, is refused: the whole rule, naming the branch.
pub fn own_branch_only(name: &str) -> String {
    format!("A Build may push only its own branch, worktree-{name}, to origin, without force: Gossamr doesn't allow this push.")
}

/// What the agent asked to run: `approve <Tool>: <command>`, as the listing words it (`permissionRequest` in
/// `agentsLogic.ts` reads it the same way).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PermissionAsk {
    pub tool: String,
    pub command: String,
}

/// Whether Allow once is offered for a run's prompt, and if not, why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "reason", rename_all = "camelCase")]
pub enum Allow {
    Offered,
    /// A read-only run: Claude Code refuses it whatever the person says.
    ReadOnly,
    /// A Build asking for something Gossamr forbids it, with the rule.
    Forbidden(String),
    /// The request can't be read whole: it was cut, masked or isn't in the usual form.
    NotExact,
    /// A Build's command that isn't one Gossamr can check (`plain`): answered in Terminal, where the person reads it.
    Unchecked,
}

impl Allow {
    pub fn kind(&self) -> &'static str {
        match self {
            Allow::Offered => "offered",
            Allow::ReadOnly => "readOnly",
            Allow::Forbidden(_) => "forbidden",
            Allow::NotExact => "notExact",
            Allow::Unchecked => "unchecked",
        }
    }

    /// What the person is told when Allow isn't offered; `None` when it is.
    pub fn refusal(&self) -> Option<String> {
        match self {
            Allow::Offered => None,
            Allow::ReadOnly => Some(READ_ONLY_REFUSES.into()),
            Allow::Forbidden(why) => Some(why.clone()),
            Allow::NotExact => Some(NOT_EXACT.into()),
            Allow::Unchecked => Some(UNCHECKED.into()),
        }
    }
}

/// `approve <Tool>: <command>`: "approve" in any case, a tool name with no space or colon, then the command. `None`
/// for any other text.
pub fn parse(needs: &str) -> Option<PermissionAsk> {
    let text = needs.trim();
    let head = text.get(..7).filter(|h| h.eq_ignore_ascii_case("approve"))?;
    let rest = &text[head.len()..];
    let after = rest.trim_start();
    if after.len() == rest.len() {
        return None;
    }
    let colon = after.find(':')?;
    let tool = &after[..colon];
    if tool.is_empty() || tool.chars().any(char::is_whitespace) {
        return None;
    }
    let command = after[colon + 1..].trim_start();
    Some(PermissionAsk { tool: tool.to_owned(), command: command.to_owned() })
}

/// What the person must have read to answer: the command, or the whole request when it isn't in the usual form.
fn read_as(needs: &str) -> String {
    parse(needs).map(|a| a.command).unwrap_or_else(|| needs.trim().to_owned())
}

/// A request that may not be what the agent asked: masked by redaction, cut at the length the tracker keeps, holding a
/// NUL, or with no command.
fn not_whole(needs: &str, ask: &PermissionAsk) -> bool {
    needs.contains(super::redact::MASK) || needs.chars().count() >= super::tracker::NEEDS_KEPT || needs.contains('\0') || ask.command.trim().is_empty()
}

/// Whether Allow once is offered for the run's prompt, with the request as Gossamr reads it. Pure: the same run always
/// gives the same answer. A read-only run comes first, so its prompt always says why it is refused.
pub fn offer(run: &Run) -> (Option<PermissionAsk>, Allow) {
    let needs = run.needs.as_deref().unwrap_or_default();
    let ask = parse(needs);
    if run.spec.kind.read_only() || run.read_only.is_some() {
        return (ask, Allow::ReadOnly);
    }
    let Some(ask) = ask else { return (None, Allow::NotExact) };
    if not_whole(needs, &ask) {
        return (Some(ask), Allow::NotExact);
    }
    let allow = match forbidden(run, &ask) {
        Some(why) => Allow::Forbidden(why),
        None if !checkable(run, &ask) => Allow::Unchecked,
        None => Allow::Offered,
    };
    (Some(ask), allow)
}

/// What Gossamr forbids a Build. `None` when it may be allowed. Tool names are read in any case, as Claude Code's are.
fn forbidden(run: &Run, ask: &PermissionAsk) -> Option<String> {
    debug_assert_eq!(run.spec.kind, RunKind::Build);
    let tool = ask.tool.to_ascii_lowercase();
    if tool.starts_with("mcp__gossamr") {
        return Some(NO_GOSSAMR_TOOLS.into());
    }
    if tool.starts_with("mcp__") {
        return Some(NO_OTHER_SERVERS.into());
    }
    if FILE_TOOLS.contains(&tool.as_str()) {
        return git_path(&ask.command).then(|| NO_GIT_SETTINGS.into());
    }
    if tool != "bash" {
        return None;
    }
    let command = ask.command.as_str();
    if ["$(", "`", "<(", ">("].iter().any(|s| command.contains(s)) {
        return Some(HAS_COMMAND_INSIDE.into());
    }
    let unquoted = unquoted(command);
    let plain = unquoted.to_lowercase();
    let segments: Vec<Vec<&str>> = unquoted.split(['&', '|', ';', '\n']).map(|segment| segment.split_whitespace().map(bare).filter(|w| !w.is_empty()).collect()).collect();
    // Settings first: a push redirected by them would read as the Build's own.
    let settings = plain.contains(".git/") || plain.contains(".gitconfig") || plain.contains("/git/config") || plain.contains("hookspath") || plain.split_whitespace().any(|w| git_path(bare(w)));
    if settings || segments.iter().any(|words| words.iter().position(|w| program(w) == "git").is_some_and(|at| git_settings(&words[at + 1..]))) {
        return Some(NO_GIT_SETTINGS.into());
    }
    // A push in any spelling, or a word git may be made to read as one, through a variable, a glob or braces.
    if plain.contains("git") && (plain.contains("push") || command.contains(['$', '*', '?', '[', '{'])) {
        if !run.spec.allow_push {
            return Some(PUSH_NOT_APPROVED.into());
        }
        let tokens: Vec<&str> = command.split_whitespace().collect();
        return (!own_branch_push(&tokens, &run.spec.name)).then(|| own_branch_only(&run.spec.name));
    }
    if let Some(why) = segments.iter().find_map(|words| forbidden_segment(run, words)) {
        return Some(why);
    }
    command.match_indices('\\').any(|(at, _)| !command[at + 1..].starts_with('\n')).then(|| HAS_ESCAPES.into())
}

/// `text` as the shell joins its words: quotes and backslashes taken out, so `pu''sh` and `g\it` read as `push` and `git`.
fn unquoted(text: &str) -> String {
    text.chars().filter(|c| !matches!(c, '\'' | '"' | '\\')).collect()
}

/// A path inside a repository's `.git`, or git's own settings file.
fn git_path(path: &str) -> bool {
    let path = path.trim().to_lowercase().replace('\\', "/");
    path.split('/').any(|part| part == ".git" || part == ".gitconfig") || path.contains("/git/config")
}

/// A word of a command with the brackets around it taken off, so `(git` and `{gh` read as `git` and `gh`.
fn bare(token: &str) -> &str {
    token.trim_matches(|c: char| matches!(c, '(' | ')' | '{' | '}'))
}

/// The program a word names, in any case: `/usr/bin/GH` names `gh`.
fn program(word: &str) -> String {
    word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase()
}

/// Shells and interpreters, which run whatever code they are given.
const INTERPRETERS: [&str; 19] = ["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "python", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "pwsh", "osascript"];
/// Programs that run the program named after them.
const WRAPPERS: [&str; 15] = ["xargs", "env", "exec", "command", "builtin", "sudo", "doas", "nohup", "nice", "time", "timeout", "watch", "parallel", "-exec", "-execdir"];

/// A shell or interpreter, with or without its version: `python3.12` is `python`.
fn interpreter(name: &str) -> bool {
    INTERPRETERS.contains(&name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.'))
}

/// What Gossamr forbids in one command of a Bash line, by its unquoted words: GitHub writes and code it can't read.
fn forbidden_segment(run: &Run, words: &[&str]) -> Option<String> {
    let at = words.iter().position(|w| program(w) == "gh");
    at.and_then(|at| github(run, &words[at + 1..])).or_else(|| runs_code(words).then(|| HAS_COMMAND_INSIDE.into()))
}

/// `gh` with `rest` after it: only the draft pull request the Build may open and reads. Anything else, `gh api`
/// included whatever its method, writes or may write to GitHub.
fn github(run: &Run, rest: &[&str]) -> Option<String> {
    let (group, verb) = (rest.first().copied().unwrap_or_default(), rest.get(1).copied().unwrap_or_default());
    if group == "api" {
        return Some(if rest.iter().any(|w| w.to_lowercase().contains("merge")) { NEVER_MERGES } else { GITHUB_READS_ONLY }.into());
    }
    if group == "pr" && matches!(verb, "merge" | "ready" | "review" | "close") {
        return Some(NEVER_MERGES.into());
    }
    if group == "pr" && verb == "create" {
        if !run.spec.allow_push {
            return Some(PUSH_NOT_APPROVED.into());
        }
        return (!rest.contains(&"--draft")).then(|| DRAFT_PR_ONLY.into());
    }
    let reads = matches!(
        (group, verb),
        ("pr" | "issue", "view" | "list" | "status" | "diff" | "checks") | ("run", "view" | "list" | "watch") | ("repo" | "release" | "workflow", "view" | "list") | ("auth", "status") | ("version" | "--version", _)
    );
    (!reads).then(|| GITHUB_READS_ONLY.into())
}

/// `git` with `rest` after it changing its settings or remotes: `-c` and `--config-env` for the one command, `config`
/// unless it only reads, and `remote` unless it only shows.
fn git_settings(rest: &[&str]) -> bool {
    let mut at = 0;
    while let Some(word) = rest.get(at).filter(|w| w.starts_with('-')) {
        if *word == "-c" || word.starts_with("--config-env") {
            return true;
        }
        at += if *word == "-C" { 2 } else { 1 };
    }
    let after = &rest[at.min(rest.len())..];
    match after.first().copied() {
        Some("config") => {
            let reads = ["--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list"];
            !(after[1..].iter().any(|w| reads.contains(w)) && !after[1..].iter().any(|w| matches!(*w, "--add" | "--unset" | "--unset-all" | "--replace-all" | "--rename-section" | "--remove-section" | "--edit" | "-e" | "set" | "unset" | "edit")))
        }
        Some("remote") => !matches!(after.get(1).copied(), None | Some("-v" | "--verbose" | "show" | "get-url")),
        _ => false,
    }
}

/// Whether a command runs code Gossamr can't read: `eval` or `source`, a shell or interpreter given code inline or on
/// its input rather than a script file, awk told to run a command, or a program named by a variable or a glob. Where a program is named is the
/// first word that isn't `NAME=value`, and every word after a program that runs another.
fn runs_code(words: &[&str]) -> bool {
    let first = words.iter().position(|w| !assignment(w));
    let wrapped = words.iter().position(|w| WRAPPERS.contains(&program(w).as_str()));
    let named = |at: usize| Some(at) == first || wrapped.is_some_and(|w| at > w);
    words.iter().enumerate().filter(|(at, _)| named(*at)).any(|(at, word)| {
        let name = program(word);
        let inline = words.get(at + 1).is_none_or(|next| next.starts_with('-') || next.starts_with('<'));
        let awk = matches!(name.as_str(), "awk" | "gawk" | "mawk" | "nawk") && words.iter().any(|w| w.contains("system") || w.contains("getline"));
        matches!(name.as_str(), "eval" | "source" | ".") || (interpreter(&name) && inline) || awk || word.contains(['$', '*', '?', '['])
    })
}

/// `NAME=value` before a command, which sets a variable rather than naming a program.
fn assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// `git push [-u|--set-upstream] origin <worktree-name | HEAD:worktree-name>`, word for word. A bare `git push` and
/// `origin HEAD` are left out: both push wherever the checked-out branch tracks or is, which need not be the Build's.
fn own_branch_push(tokens: &[&str], name: &str) -> bool {
    let branch = format!("worktree-{name}");
    let to = format!("HEAD:{branch}");
    let rest = match tokens {
        ["git", "push", "-u" | "--set-upstream", rest @ ..] | ["git", "push", rest @ ..] => rest,
        _ => return false,
    };
    matches!(rest, ["origin", target] if *target == branch || *target == to)
}

/// Claude Code's tools that write the file they name.
const FILE_TOOLS: [&str; 4] = ["edit", "write", "multiedit", "notebookedit"];

/// Whether Gossamr can check a Build's request whole once nothing forbids it: a plain Bash command or the Build's own
/// push, or a file tool writing inside the checkout. Any other tool (a fetch, a search, another server's) can't be read
/// for what it does, so it is answered in Terminal.
fn checkable(run: &Run, ask: &PermissionAsk) -> bool {
    let tool = ask.tool.to_ascii_lowercase();
    if tool == "bash" {
        return plain(&ask.command) || own_branch_push(&ask.command.split_whitespace().collect::<Vec<_>>(), &run.spec.name);
    }
    FILE_TOOLS.contains(&tool.as_str()) && inside_checkout(&ask.command, &run.expected_worktree.to_string_lossy())
}

/// A path a file tool writes that stays in the checkout: relative, or under the run's worktree, with no `..` and no home
/// directory.
fn inside_checkout(path: &str, worktree: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path.starts_with('~') || path.split(['/', '\\']).any(|part| part == "..") {
        return false;
    }
    if !path.starts_with('/') {
        return true;
    }
    let root = worktree.trim_end_matches('/');
    !root.is_empty() && path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

/// Programs a Build's Bash command may be offered Allow for: ones that do what their words say and run nothing else,
/// given the checks in `plain_segment`. Anything else (a script, a package manager, an interpreter, `sed`, `awk`,
/// `xargs`, or `sort` and `uniq`, which write a file their words name) is answered in Terminal.
const PLAIN: [&str; 30] = [
    "ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "echo", "printf", "mkdir", "touch", "cp", "mv", "rm", "diff", "cut", "tr", "basename", "dirname", "stat", "file", "true", "false", "which", "date", "cd", "find", "git", "gh",
];
/// Programs that write or move where later commands write: their paths stay inside the checkout.
const WRITERS: [&str; 6] = ["mkdir", "touch", "cp", "mv", "rm", "cd"];
/// git commands that only read, or change the checkout and its history, and never its settings or another repository.
const GIT_PLAIN: [&str; 16] = ["status", "diff", "log", "show", "add", "commit", "branch", "checkout", "switch", "restore", "fetch", "stash", "rev-parse", "ls-files", "blame", "merge-base"];
/// Options that make an otherwise plain program run another: `rg --pre`, `sort --compress-program`, `find -exec`, and
/// git's transport, diff and output hooks.
const RUNS_ANOTHER: [&str; 16] = ["--pre", "--compress-program", "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fls", "--upload-pack", "--receive-pack", "--exec", "--ext-diff", "--output", "--config", "-c"];

/// Whether a Build's Bash command is one Gossamr can check whole, so Allow once may be offered for it: every command in
/// it a `PLAIN` program named by its first word, with nothing the shell would read differently from Gossamr. Outside
/// quotes that is no variable, glob, brace, redirect, subshell, escape or home directory; inside double quotes no
/// variable, command or escape; single quotes keep everything as it is. A `NAME=value` before a command isn't plain.
/// Conservative by design: anything else is answered in Terminal.
fn plain(command: &str) -> bool {
    shell_words(command).is_some_and(|segments| segments.iter().filter(|words| !words.is_empty()).all(|words| plain_segment(words)))
}

/// The commands of a Bash line and each one's words as the shell reads them, quotes joined: `None` when the line has
/// anything `plain` doesn't read, or a quote left open.
fn shell_words(command: &str) -> Option<Vec<Vec<String>>> {
    let (mut segments, mut words, mut word, mut quoted) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                quoted = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => word.push(c),
                    }
                }
            }
            '"' => {
                quoted = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '$' | '`' | '\\' => return None,
                        c => word.push(c),
                    }
                }
            }
            '$' | '`' | '\\' | '<' | '>' | '*' | '?' | '[' | ']' | '{' | '}' | '(' | ')' | '~' | '#' => return None,
            '&' | '|' | ';' | '\n' | ' ' | '\t' => {
                if quoted || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                    quoted = false;
                }
                if c != ' ' && c != '\t' {
                    segments.push(std::mem::take(&mut words));
                }
            }
            c => word.push(c),
        }
    }
    if quoted || !word.is_empty() {
        words.push(word);
    }
    segments.push(words);
    Some(segments)
}

/// One command of a plain Bash line, by its unquoted words.
fn plain_segment(words: &[String]) -> bool {
    let name = words[0].as_str();
    if !PLAIN.contains(&name) || words.iter().any(|w| RUNS_ANOTHER.iter().any(|o| w.starts_with(o)) || w.contains("::")) {
        return false;
    }
    if name == "git" && !words.get(1).is_some_and(|sub| GIT_PLAIN.contains(&sub.as_str())) {
        return false;
    }
    // A writer's paths are relative and stay below where the run is: no absolute path, no `..`, and `cd` goes somewhere
    // named, never home or back.
    let below = |w: &String| !w.is_empty() && !w.starts_with('/') && !w.contains("=/") && w != "-" && !w.split('/').any(|part| part == "..");
    !WRITERS.contains(&name) || (words[1..].iter().all(below) && (name != "cd" || words.len() == 2))
}

/// What a denied run is woken with, after the reminder. Fixed text with nothing of the request in it: the command is the
/// agent's own words, so quoting it would put agent text in the person's voice. The agent knows what it asked.
pub const DENIED_MESSAGE: &str = "The person did not allow the request you just asked permission for. Don't run it or anything that does the same. Carry on without it; if the work can't be finished without it, say so in your answer.";

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// The run must still ask what the person read.
fn read_check(run: &Run, command: &str) -> Result<()> {
    if run.state != RunState::NeedsPermission {
        return Err(refuse(format!("This run is {}, so it isn't asking permission.", run.state.as_str())));
    }
    if read_as(run.needs.as_deref().unwrap_or_default()) != command {
        return Err(refuse("The request changed after you read it. Read it again."));
    }
    Ok(())
}

fn event(run: &Run, text: &str, command: &str) -> RunEvent {
    RunEvent { run_id: run.id.clone(), seq: 0, at: Utc::now(), kind: "permission".into(), text: text.into(), detail: Some(command.to_owned()) }
}

impl RunService {
    /// The person's Deny for the prompt they read as `command`: the session is stopped, which drops the prompt, and
    /// woken in place with `DENIED_MESSAGE`, so the agent carries on without it. The denial is recorded, with the exact
    /// command, once the session has been stopped, since that is what refuses the request. As with an answer, a failure
    /// once the session has been stopped leaves the run `Stopped` with the denial kept to send again.
    pub async fn deny_permission(&self, run_id: &str, command: &str) -> Result<Run> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        read_check(&run, command)?;
        let id = run.short_id.clone().ok_or_else(|| refuse("This run has no session to answer."))?;
        let session = run.session_id.clone().filter(|s| is_uuid(s)).ok_or_else(|| refuse("This run has no session to answer."))?;
        let tc = self.toolchain().await?;
        let listed = tc.cli.agents(true).await?;
        let asking = listed.iter().find(|e| belongs_to(e, &run)).is_some_and(|e| e.status.as_deref() == Some("waiting") && e.waiting_for.as_deref() == Some("permission prompt"));
        if !asking {
            return Err(refuse("It isn't asking permission any more. Look again in a moment."));
        }
        let denial = DENIED_MESSAGE.to_owned();
        tc.cli.stop(&id).await?;
        Self::stopped(&mut run);
        if let Err(e) = self.index.mark_terminal(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.reset_counts(&run.id);
        // Saved before the wake, so an app that quits between the two still has the denial to send again.
        run.unsent_answer = Some(denial.clone());
        self.store(&run).await?;
        // The prompt went with the stop, so the request is refused here, whatever the wake does: recorded now, with the
        // exact command, and not again when a failed wake's denial is sent again.
        if let Err(e) = self.core.append_run_events(&run.id, &[event(&run, "You denied this request", command)]).await {
            eprintln!("couldn't record the denial: {e}");
        }
        self.note_person(&run, "permission_denied", Some(command.to_owned())).await;

        match self.wake(&tc, &mut run, &id, &session, &denial, true).await {
            None => {
                back_at_work(&mut run, Utc::now());
                self.remember(&run);
                self.store(&run).await?;
                if let Err(e) = self.core.report_stale(&run.id).await {
                    eprintln!("couldn't mark the report of run {} as older than your denial: {e}", run.id);
                }
                Ok(run)
            }
            Some(why) => {
                run.error = Some(why.clone());
                self.store(&run).await?;
                Err(Error::Claude(format!("{why} Your denial is kept on the run, to send again.")))
            }
        }
    }

    /// The person's Allow once for the prompt they read as `command`, which only Claude Code itself can grant: when
    /// `offer` allows it, Terminal is opened on the session for them to answer Yes there, and the choice is recorded
    /// with the exact command. The session is neither stopped nor resumed. If Terminal can't be opened, nothing is
    /// recorded.
    pub async fn allow_permission_once(&self, run_id: &str, command: &str) -> Result<Run> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        let run = self.load(run_id).await?;
        read_check(&run, command)?;
        if let Some(why) = offer(&run).1.refusal() {
            return Err(refuse(why));
        }
        self.attach(run_id).await?;
        let mut run = self.load(run_id).await?;
        if let Err(e) = self.core.append_run_events(&run.id, &[event(&run, "You chose Allow once, in Terminal", command)]).await {
            eprintln!("couldn't record the choice: {e}");
        }
        self.note_person(&run, "permission_allowed_in_terminal", Some(command.to_owned())).await;
        run.permission_allowed = Some(PermissionAllowed { command: command.to_owned(), at: Utc::now() });
        self.store(&run).await?;
        Ok(run)
    }
}

#[cfg(test)]
mod tests;
