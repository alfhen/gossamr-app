import type { Run, RunKind, RunSpec } from "../types";

/**
 * A run's permission prompt as Gossamr reads it, and whether Allow once is offered for it: `runs/permission.rs`, kept in
 * step through the shared cases in `permission.fixtures.json`. Deny is offered for every prompt. Allow once only for the
 * exact tool and command the agent asked for, never on a read-only run, and never for what Gossamr forbids a Build. Only
 * the person answers: Pip has no tool for it and nothing that runs on its own does.
 */

/** What a read-only run's prompt says instead of Allow. */
export const READ_ONLY_REFUSES =
  "This run is read-only: Claude Code refuses this.";
/** Why Allow isn't offered for a request Gossamr may not have whole. */
export const NOT_EXACT =
  "Gossamr can't show this request whole, so it doesn't offer Allow. Open it in Terminal to read it there.";
export const HAS_COMMAND_INSIDE =
  "This command has a command inside it, so Gossamr can't check what it runs: Gossamr doesn't allow this.";
export const PUSH_NOT_APPROVED =
  "This Build wasn't approved to push: Gossamr doesn't allow this.";
export const DRAFT_PR_ONLY =
  "A Build opens only a draft pull request, with --draft: Gossamr doesn't allow this.";
export const NEVER_MERGES =
  "A Build never merges, readies, reviews or closes its pull request: Gossamr doesn't allow this.";
export const NO_GOSSAMR_TOOLS =
  "A run never uses Gossamr's own tools: Gossamr doesn't allow this.";
export const NO_OTHER_SERVERS =
  "Gossamr can't check what another server's tool does, such as a write to GitHub or Jira: Gossamr doesn't allow this.";
export const GITHUB_READS_ONLY =
  "A Build only reads GitHub, besides opening its draft pull request: Gossamr doesn't allow this.";
export const NO_GIT_SETTINGS =
  "A Build never changes its repository's git settings, remotes or hooks: Gossamr doesn't allow this.";
export const HAS_ESCAPES =
  "This command has escaped characters, so Gossamr can't check what it runs: Gossamr doesn't allow this.";
/** Why Allow isn't offered for a Build's command that isn't one of the plain ones Gossamr can check. */
export const UNCHECKED =
  "Gossamr offers Allow once only for plain commands it can check, such as git, ls or cat. Open the run in Terminal to read this one and answer it there.";

/** Why a push other than the Build's own branch is refused, naming the branch. */
export const ownBranchOnly = (name: string) =>
  `A Build pushes only its own branch, worktree-${name}, to origin: Gossamr doesn't allow this.`;

/** Masked text, as redaction leaves it (`MASK`). */
const MASK = "[redacted]";
/** How much of a request the tracker keeps (`NEEDS_KEPT`): one this long may have been cut. */
const NEEDS_KEPT = 500;
const READ_ONLY_KINDS: readonly RunKind[] = [
  "investigate",
  "triage",
  "plan",
  "review",
  "verify",
];

export interface PermissionAsk {
  tool: string;
  command: string;
}

export type AllowKind =
  | "offered"
  | "readOnly"
  | "forbidden"
  | "notExact"
  | "unchecked";

/** Whether Allow once is offered, the request as read (null when it isn't in the usual form), and, when it isn't offered, why. */
export interface PermissionOffer {
  ask: PermissionAsk | null;
  allow: AllowKind;
  reason: string | null;
}

/** `approve <Tool>: <command>`: "approve" in any case, a tool name with no space or colon, then the command. Null for any other text. */
export function parsePermission(
  needs: string | null | undefined,
): PermissionAsk | null {
  const m = /^approve\s+([^:\s]+):\s*([\s\S]*)$/i.exec(needs?.trim() ?? "");
  return m ? { tool: m[1], command: m[2] } : null;
}

/** What the person must have read to answer: the command, or the whole request when it isn't in the usual form. */
export const readAs = (needs: string | null | undefined): string =>
  parsePermission(needs)?.command ?? (needs ?? "").trim();

/** A request that may not be what the agent asked: masked, cut at the length the tracker keeps, holding a NUL, or with no command. */
const notWhole = (needs: string, ask: PermissionAsk) =>
  needs.includes(MASK) ||
  [...needs].length >= NEEDS_KEPT ||
  needs.includes("\0") ||
  !ask.command.trim();

const refusal = (allow: AllowKind, why: string | null): string | null =>
  allow === "offered"
    ? null
    : allow === "readOnly"
      ? READ_ONLY_REFUSES
      : allow === "notExact"
        ? NOT_EXACT
        : allow === "unchecked"
          ? UNCHECKED
          : why;

/** Whether Allow once is offered for the run's prompt. A read-only run comes first, so its prompt always says why it is refused. */
export function permissionOffer(
  run: Pick<Run, "needs" | "readOnly"> & {
    spec: Pick<RunSpec, "kind" | "allowPush" | "name">;
  },
): PermissionOffer {
  const needs = run.needs ?? "";
  const ask = parsePermission(needs);
  const say = (
    allow: AllowKind,
    a: PermissionAsk | null,
    why: string | null = null,
  ): PermissionOffer => ({ ask: a, allow, reason: refusal(allow, why) });
  if (READ_ONLY_KINDS.includes(run.spec.kind) || run.readOnly)
    return say("readOnly", ask);
  if (!ask) return say("notExact", null);
  if (notWhole(needs, ask)) return say("notExact", ask);
  const why = forbidden(run.spec, ask);
  if (why) return say("forbidden", ask, why);
  const unchecked =
    ask.tool.toLowerCase() === "bash" &&
    !plain(ask.command) &&
    !ownBranchPush(ask.command.split(/\s+/).filter(Boolean), run.spec.name);
  return say(unchecked ? "unchecked" : "offered", ask);
}

/**
 * What Gossamr forbids a Build. Null when it may be allowed. Tool names are read in any case. Conservative, as in
 * `runs/permission.rs`: git and push in any spelling is a push, allowed only as the whole command `git push origin
 * <its branch>`, and a command whose words Gossamr can't read as the shell will isn't offered Allow.
 */
function forbidden(
  spec: Pick<RunSpec, "allowPush" | "name">,
  ask: PermissionAsk,
): string | null {
  const tool = ask.tool.toLowerCase();
  if (tool.startsWith("mcp__gossamr")) return NO_GOSSAMR_TOOLS;
  if (tool.startsWith("mcp__")) return NO_OTHER_SERVERS;
  if (["edit", "write", "multiedit", "notebookedit"].includes(tool))
    return gitPath(ask.command) ? NO_GIT_SETTINGS : null;
  if (tool !== "bash") return null;
  const command = ask.command;
  if (["$(", "`", "<(", ">("].some((s) => command.includes(s)))
    return HAS_COMMAND_INSIDE;
  const plainCase = unquoted(command);
  const plain = plainCase.toLowerCase();
  const segments = plainCase
    .split(/[&|;\n]/)
    .map((segment) => segment.split(/\s+/).map(bare).filter(Boolean));
  // Settings first: a push redirected by them would read as the Build's own.
  const settings =
    [".git/", ".gitconfig", "/git/config", "hookspath"].some((s) =>
      plain.includes(s),
    ) || plain.split(/\s+/).some((w) => gitPath(bare(w)));
  if (
    settings ||
    segments.some((words) => {
      const at = words.findIndex((w) => program(w) === "git");
      return at >= 0 && gitSettings(words.slice(at + 1));
    })
  )
    return NO_GIT_SETTINGS;
  // A push in any spelling, or a word git may be made to read as one, through a variable, a glob or braces.
  if (
    plain.includes("git") &&
    (plain.includes("push") || /[$*?[{]/.test(command))
  ) {
    if (!spec.allowPush) return PUSH_NOT_APPROVED;
    return ownBranchPush(command.split(/\s+/).filter(Boolean), spec.name)
      ? null
      : ownBranchOnly(spec.name);
  }
  for (const words of segments) {
    const why = forbiddenSegment(spec, words);
    if (why) return why;
  }
  return /\\(?!\n)/.test(command) ? HAS_ESCAPES : null;
}

/** `text` as the shell joins its words: quotes and backslashes taken out, so `pu''sh` and `g\it` read as `push` and `git`. */
const unquoted = (text: string) => text.replace(/['"\\]/g, "");

/** A path inside a repository's `.git`, or git's own settings file. */
function gitPath(path: string): boolean {
  const p = path.trim().toLowerCase().replace(/\\/g, "/");
  return (
    p.split("/").some((part) => part === ".git" || part === ".gitconfig") ||
    p.includes("/git/config")
  );
}

/** A word of a command with the brackets around it taken off, so `(git` and `{gh` read as `git` and `gh`. */
const bare = (token: string) => token.replace(/^[(){}]+|[(){}]+$/g, "");

/** The program a word names, in any case: `/usr/bin/GH` names `gh`. */
const program = (word: string) =>
  word.slice(word.lastIndexOf("/") + 1).toLowerCase();

/** Shells and interpreters, which run whatever code they are given. */
const INTERPRETERS = [
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "python",
  "node",
  "nodejs",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "pwsh",
  "osascript",
];
/** Programs that run the program named after them. */
const WRAPPERS = [
  "xargs",
  "env",
  "exec",
  "command",
  "builtin",
  "sudo",
  "doas",
  "nohup",
  "nice",
  "time",
  "timeout",
  "watch",
  "parallel",
  "-exec",
  "-execdir",
];

/** A shell or interpreter, with or without its version: `python3.12` is `python`. */
const interpreter = (name: string) =>
  INTERPRETERS.includes(name.replace(/[\d.]+$/, ""));

/** What Gossamr forbids in one command of a Bash line, by its unquoted words: GitHub writes and code it can't read. */
function forbiddenSegment(
  spec: Pick<RunSpec, "allowPush" | "name">,
  words: readonly string[],
): string | null {
  const at = words.findIndex((w) => program(w) === "gh");
  return (
    (at >= 0 ? github(spec, words.slice(at + 1)) : null) ??
    (runsCode(words) ? HAS_COMMAND_INSIDE : null)
  );
}

/** `gh` with `rest` after it: only the draft pull request the Build may open and reads. `gh api` writes or may, whatever its method. */
function github(
  spec: Pick<RunSpec, "allowPush">,
  rest: readonly string[],
): string | null {
  const [group = "", verb = ""] = rest;
  if (group === "api")
    return rest.some((w) => w.toLowerCase().includes("merge"))
      ? NEVER_MERGES
      : GITHUB_READS_ONLY;
  if (group === "pr" && ["merge", "ready", "review", "close"].includes(verb))
    return NEVER_MERGES;
  if (group === "pr" && verb === "create") {
    if (!spec.allowPush) return PUSH_NOT_APPROVED;
    return rest.includes("--draft") ? null : DRAFT_PR_ONLY;
  }
  const reads =
    (["pr", "issue"].includes(group) &&
      ["view", "list", "status", "diff", "checks"].includes(verb)) ||
    (group === "run" && ["view", "list", "watch"].includes(verb)) ||
    (["repo", "release", "workflow"].includes(group) &&
      ["view", "list"].includes(verb)) ||
    (group === "auth" && verb === "status") ||
    ["version", "--version"].includes(group);
  return reads ? null : GITHUB_READS_ONLY;
}

/** `git` with `rest` after it changing its settings or remotes: `-c` and `--config-env`, `config` unless it only reads, `remote` unless it only shows. */
function gitSettings(rest: readonly string[]): boolean {
  let at = 0;
  while (at < rest.length && rest[at].startsWith("-")) {
    if (rest[at] === "-c" || rest[at].startsWith("--config-env")) return true;
    at += rest[at] === "-C" ? 2 : 1;
  }
  const after = rest.slice(at);
  if (after[0] === "config") {
    const args = after.slice(1);
    const reads = [
      "--get",
      "--get-all",
      "--get-regexp",
      "--list",
      "-l",
      "get",
      "list",
    ];
    const writes = [
      "--add",
      "--unset",
      "--unset-all",
      "--replace-all",
      "--rename-section",
      "--remove-section",
      "--edit",
      "-e",
      "set",
      "unset",
      "edit",
    ];
    return !(
      args.some((w) => reads.includes(w)) &&
      !args.some((w) => writes.includes(w))
    );
  }
  if (after[0] === "remote")
    return !(
      after[1] === undefined ||
      ["-v", "--verbose", "show", "get-url"].includes(after[1])
    );
  return false;
}

/**
 * Whether a command runs code Gossamr can't read: `eval` or `source`, a shell or interpreter given code inline or on its
 * input, awk told to run a command, or a program named by a variable or a glob. A program is named by the first word that
 * isn't `NAME=value`, and by every word after a program that runs another.
 */
function runsCode(words: readonly string[]): boolean {
  const first = words.findIndex((w) => !assignment(w));
  const wrapped = words.findIndex((w) => WRAPPERS.includes(program(w)));
  const named = (at: number) => at === first || (wrapped >= 0 && at > wrapped);
  return words.some((word, at) => {
    if (!named(at)) return false;
    const name = program(word);
    const next = words[at + 1];
    const inline =
      next === undefined || next.startsWith("-") || next.startsWith("<");
    const awk =
      ["awk", "gawk", "mawk", "nawk"].includes(name) &&
      words.some((w) => w.includes("system") || w.includes("getline"));
    return (
      ["eval", "source", "."].includes(name) ||
      (interpreter(name) && inline) ||
      awk ||
      /[$*?[]/.test(word)
    );
  });
}

/** `NAME=value` before a command, which sets a variable rather than naming a program. */
const assignment = (word: string) => /^[A-Za-z0-9_]+=/.test(word);

/** `git push [-u|--set-upstream] origin <worktree-name | HEAD:worktree-name>`, word for word. */
function ownBranchPush(tokens: readonly string[], name: string): boolean {
  if (tokens[0] !== "git" || tokens[1] !== "push") return false;
  const rest =
    tokens[2] === "-u" || tokens[2] === "--set-upstream"
      ? tokens.slice(3)
      : tokens.slice(2);
  const branch = `worktree-${name}`;
  return (
    rest.length === 2 &&
    rest[0] === "origin" &&
    (rest[1] === branch || rest[1] === `HEAD:${branch}`)
  );
}

/** Programs a Build's Bash command may be offered Allow for (`PLAIN`): ones that do what their words say and run nothing else. */
const PLAIN = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "pwd",
  "echo",
  "printf",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "rm",
  "diff",
  "cut",
  "sort",
  "uniq",
  "tr",
  "basename",
  "dirname",
  "stat",
  "file",
  "true",
  "false",
  "which",
  "date",
  "cd",
  "find",
  "git",
  "gh",
];
/** Programs that write or move where later commands write: their paths stay inside the checkout. */
const WRITERS = ["mkdir", "touch", "cp", "mv", "rm", "cd"];
/** git commands that only read, or change the checkout and its history, never its settings or another repository. */
const GIT_PLAIN = [
  "status",
  "diff",
  "log",
  "show",
  "add",
  "commit",
  "branch",
  "checkout",
  "switch",
  "restore",
  "fetch",
  "stash",
  "rev-parse",
  "ls-files",
  "blame",
  "merge-base",
];
/** Options that make an otherwise plain program run another. */
const RUNS_ANOTHER = [
  "--pre",
  "--compress-program",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fls",
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--ext-diff",
  "--output",
  "--config",
  "-c",
];

/**
 * Whether a Build's Bash command is one Gossamr can check whole (`plain` in `runs/permission.rs`): every command in it a
 * `PLAIN` program named by its first word, with nothing the shell would read differently. Conservative by design.
 */
function plain(command: string): boolean {
  const segments = shellWords(command);
  return (
    !!segments &&
    segments.filter((words) => words.length > 0).every(plainSegment)
  );
}

/** The commands of a Bash line and each one's words as the shell reads them, quotes joined: null when the line has anything `plain` doesn't read, or a quote left open. */
function shellWords(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "'" || c === '"') {
      quoted = true;
      for (i++; ; i++) {
        if (i >= chars.length) return null;
        if (chars[i] === c) break;
        if (c === '"' && "$`\\".includes(chars[i])) return null;
        word += chars[i];
      }
    } else if ("$`\\<>*?[]{}()~#".includes(c)) {
      return null;
    } else if ("&|;\n \t".includes(c)) {
      if (quoted || word) words.push(word);
      word = "";
      quoted = false;
      if (c !== " " && c !== "\t") {
        segments.push(words);
        words = [];
      }
    } else word += c;
  }
  if (quoted || word) words.push(word);
  segments.push(words);
  return segments;
}

/** One command of a plain Bash line, by its words. */
function plainSegment(words: readonly string[]): boolean {
  const name = words[0];
  if (
    !PLAIN.includes(name) ||
    words.some(
      (w) => RUNS_ANOTHER.some((o) => w.startsWith(o)) || w.includes("::"),
    )
  )
    return false;
  if (name === "git" && !GIT_PLAIN.includes(words[1] ?? "")) return false;
  // A writer's paths are relative and stay below where the run is; `cd` goes somewhere named, never home or back.
  const below = (w: string) =>
    w !== "" &&
    !w.startsWith("/") &&
    !w.includes("=/") &&
    w !== "-" &&
    !w.split("/").includes("..");
  return (
    !WRITERS.includes(name) ||
    (words.slice(1).every(below) && (name !== "cd" || words.length === 2))
  );
}

/** What a denied run is woken with, after the reminder (`DENIED_MESSAGE`): fixed text quoting nothing of the agent's request. */
export const DENIED_MESSAGE =
  "The person did not allow the request you just asked permission for. Don't run it or anything that does the same. Carry on without it; if the work can't be finished without it, say so in your answer.";
