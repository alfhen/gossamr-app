import type { Run, RunKind } from "../types";
import { byQueue } from "../lib/workstreamStage";
import { withoutMarkers } from "./mockRunKinds";
import { oneQuestionEach } from "./mockReadiness";
import type { MockWorkstreams } from "./mockWorkstreams";
import type { MockRuns } from "./mockRuns";
import type { MockProposals } from "./mockProposals";

/**
 * The supervisor's decisions as the sample backend makes them, mirroring src-tauri/src/agent/supervisor.rs: `eventLine`,
 * `planRecommended` and `readiness` are `event_line`, `plan_recommended` and `readiness` (src-tauri/src/runs/result.rs).
 * Both sides run src/backend/supervisor.fixtures.json.
 */

/** What a run did that wakes Pip. */
export type WakeState = "done" | "failed" | "stopped" | "limit" | "needsAnswer" | "needsPermission" | "systemBlocked";

/** One thing that happened to a run, as Pip is told it: ids, kinds, states, counts and parsed flags only. */
export interface WakeFact {
  run: string;
  kind: RunKind;
  state: WakeState;
  planRecommended?: boolean | null;
  /** A Triage that found its ticket not ready to plan: how many open questions it listed. Absent is ready, or no verdict. */
  openQuestions?: number | null;
  verdict?: "pass" | "blocking" | null;
  blocking?: number;
  drafts?: number;
  /** The build's review waits for its pull request. */
  waitingForPr?: boolean;
}

const STATE_WORDS: Record<WakeState, string> = {
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  limit: "Stopped at a limit",
  needsAnswer: "Needs an answer",
  needsPermission: "Needs permission",
  systemBlocked: "Blocked on sign-in",
};

/** Ticket keys such as `CA-412` in `text`, upper-cased, as `context::keys_in` finds them. */
export function keysIn(text: string): string[] {
  const out: string[] = [];
  for (const token of text.split(/[^A-Za-z0-9_-]/)) {
    const at = token.lastIndexOf("-");
    if (at < 0) continue;
    const [project, number] = [token.slice(0, at), token.slice(at + 1)];
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(project) && /^[0-9]+$/.test(number)) {
      const key = token.toUpperCase();
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

/** A run id as it may appear in a wake prompt: never anything `keysIn` takes for a ticket. */
function shownId(id: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(id) && keysIn(id).length === 0 ? id : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function factLine(f: WakeFact): string {
  const id = shownId(f.run);
  let line = `[Event] ${id ? `run ${id}` : "a run"} (${f.kind}) ${STATE_WORDS[f.state]}`;
  if (f.planRecommended != null) line += f.planRecommended ? "; plan recommended: yes" : "; plan recommended: no";
  if (f.openQuestions === 0) line += "; not ready to plan";
  else if (f.openQuestions != null) line += `; not ready to plan, ${plural(f.openQuestions, "open question", "open questions")}`;
  if (f.verdict) {
    line += `; verdict: ${f.verdict}`;
    if ((f.blocking ?? 0) > 0) line += `; ${plural(f.blocking ?? 0, "blocking finding", "blocking findings")}`;
  }
  if ((f.drafts ?? 0) > 0) line += `; ${plural(f.drafts ?? 0, "draft", "drafts")}`;
  if (f.waitingForPr) line += "; waiting for its pull request";
  return line;
}

/** The wake prompt's event lines, one per fact. */
export function eventLine(facts: WakeFact[]): string {
  return facts.map(factLine).join("\n");
}

/**
 * A Triage's `Plan recommended: yes|no` line in its written answer, as `plan_recommended` in runs/result.rs: read
 * case-insensitively and through headings, bullets and emphasis, never inside a code fence or a `>` quote, and lines that
 * disagree count as none.
 */
export function planRecommended(text: string): boolean | null {
  return yesNoLine(text, "plan recommended");
}

/** The `label: yes|no` lines of `text` as `plan_recommended` reads them: `null` when there is none or two disagree. */
function yesNoLine(text: string, label: string): boolean | null {
  let fence: { mark: string; len: number } | null = null;
  let said: boolean | null = null;
  for (const line of text.split("\n")) {
    const indent = line.length - line.replace(/^ +/, "").length;
    const t = line.slice(indent);
    const opener = indent <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(t) : null;
    if (fence) {
      if (opener && opener[1][0] === fence.mark && opener[1].length >= fence.len && opener[2].trim() === "") fence = null;
      continue;
    }
    if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
      fence = { mark: opener[1][0], len: opener[1].length };
      continue;
    }
    if (line.trimStart().startsWith(">")) continue;
    const bare = line.trim().replace(/^[#\-+*_`\s]+/, "");
    if (bare.slice(0, label.length).toLowerCase() !== label) continue;
    const rest = bare.slice(label.length).replace(/^[*_`\s]+/, "");
    if (!rest.startsWith(":")) continue;
    const word = (/^[A-Za-z]*/.exec(rest.slice(1).replace(/^[*_`\s]+/, ""))?.[0] ?? "").toLowerCase();
    if (word !== "yes" && word !== "no") continue;
    const now = word === "yes";
    if (said !== null && said !== now) return null;
    said = now;
  }
  return said;
}

/** A Triage's verdict on whether its ticket is clear enough to plan, as `Readiness` in runs/result.rs. */
export interface Readiness {
  ready: boolean;
  /** Empty when ready; a verdict of not ready may have none when the answer listed none. */
  questions: string[];
}

/** At most this many open questions are kept, each at most `QUESTION_LIMIT` characters (`QUESTIONS_MAX`, `QUESTION_LIMIT`). */
export const QUESTIONS_MAX = 8;
export const QUESTION_LIMIT = 300;

/** The text after a bullet or number on a list line, or null for any other line, as `list_marker`. */
function listMarker(line: string): string | null {
  const t = line.trimStart();
  const bullet = /^[-*+•][ \t]+/.exec(t);
  if (bullet) return t.slice(bullet[0].length);
  const numbered = /^\d{1,3}[.)][ \t]+/.exec(t);
  return numbered ? t.slice(numbered[0].length) : null;
}

/** What follows `open questions` on a line that is that heading, in any of the usual dressings, as `heading_rest`; null for any other line. */
function openQuestionsRest(line: string): string | null {
  const trimmed = line.trim();
  const bare = trimmed.replace(/^[#>]+/, "").replace(/^[*_`\s]+/, "");
  if (bare.slice(0, "open questions".length).toLowerCase() !== "open questions") return null;
  const rest = bare.slice("open questions".length).replace(/^[*_`\s]+/, "");
  if (rest.startsWith(":")) return rest.slice(1).replace(/^[*_`\s]+/, "");
  return trimmed.startsWith("#") && rest.trim() === "" ? "" : null;
}

/** `text` without what doesn't show and without data markers, as `scrub` does for what this needs. */
function scrubbed(text: string): string {
  const visible = Array.from(text)
    .filter((c) => c === "\n" || c === "\t" || !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(c))
    .join("");
  // Taking one kind of marker out can join the halves of the other, so both go until neither is left.
  let out = visible;
  for (;;) {
    let next = withoutMarkers(out);
    while (/<<<AGENT_OUTPUT|AGENT_OUTPUT>>>/.test(next)) next = next.replace(/<<<AGENT_OUTPUT|AGENT_OUTPUT>>>/g, "");
    if (next === out) return out;
    out = next;
  }
}

function cut(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("").trimEnd()}…`;
}

/**
 * A Triage's `Ready to plan: yes|no` line in its written answer, as `readiness` in runs/result.rs: read as the plan
 * recommendation is, and with a `no`, the list under its `Open questions:` heading (or the text after it on the same
 * line). Quoted lines, code fences and disagreeing lines count for nothing. The questions are one line each, cut, at most
 * `QUESTIONS_MAX`. Null without a verdict, which reads as ready. Both run `report` in src/backend/readiness.fixtures.json.
 */
export function readiness(result: string): Readiness | null {
  const clean = scrubbed(result);
  const ready = yesNoLine(clean, "ready to plan");
  if (ready === null) return null;
  if (ready) return { ready, questions: [] };
  // A quoted heading is somebody else's words, as for the verdict line.
  const lines = clean.split("\n").map((l) => (l.trimStart().startsWith(">") ? "" : l));
  const questions: string[] = [];
  let fence: { mark: string; len: number } | null = null;
  let start = -1;
  const fenced = (line: string): boolean => {
    const indent = line.length - line.replace(/^ +/, "").length;
    const opener = indent <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(line.slice(indent)) : null;
    if (fence) {
      if (opener && opener[1][0] === fence.mark && opener[1].length >= fence.len && opener[2].trim() === "") fence = null;
      return true;
    }
    if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
      fence = { mark: opener[1][0], len: opener[1].length };
      return true;
    }
    return false;
  };
  for (let i = 0; i < lines.length && start < 0; i++) {
    if (fenced(lines[i])) continue;
    const rest = openQuestionsRest(listMarker(lines[i]) ?? lines[i]);
    if (rest === null) continue;
    start = i;
    if (rest.trim()) questions.push(rest);
  }
  if (start >= 0) {
    fence = null;
    for (const line of lines.slice(start + 1)) {
      if (fenced(line) || !line.trim()) continue;
      const item = listMarker(line);
      if (item === null) break;
      questions.push(item);
    }
  }
  const flat = (q: string) =>
    q
      .replace(/^(\[[ xX]\])/, "")
      .replace(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*/g, "$1")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .replace(/^[*_`\s]+|[*_`\s]+$/g, "");
  return { ready, questions: oneQuestionEach(questions.map(flat).filter((q) => q !== "")).slice(0, QUESTIONS_MAX).map((q) => cut(q, QUESTION_LIMIT)) };
}

/** What a finished Triage on a ticket says about a plan, from its whole written answer, as `Resolved.plan_recommended`. */
function triagePlanRecommended(run: Run): boolean | null {
  return run.item && run.resultComplete !== false && run.result ? planRecommended(run.result) : null;
}

/** What a finished Triage on a ticket says about its ticket being ready to plan, from its whole written answer, as `Resolved.readiness`. */
export function triageReadiness(run: Run): Readiness | null {
  return run.spec.kind === "triage" && run.item && run.resultComplete !== false && run.result ? readiness(run.result) : null;
}

const KEY_STATE: Record<WakeState, string> = {
  done: "done",
  failed: "failed",
  stopped: "stopped",
  limit: "limit",
  needsAnswer: "needs_answer",
  needsPermission: "needs_permission",
  systemBlocked: "system_blocked",
};

const secs = (at: string) => Math.floor(Date.parse(at) / 1000);

/** The state part of the `(workstream, run, state)` key, as `mark`: a finish after the person carried on, or a question, by when. */
export function factKey(run: Pick<Run, "continuedAt" | "lastProgressAt">, state: WakeState): string {
  const base = KEY_STATE[state];
  if (state === "done" || state === "stopped" || state === "limit") return run.continuedAt ? `${base}@${secs(run.continuedAt)}` : base;
  if (state === "failed") return base;
  return `${base}@${secs(run.lastProgressAt)}`;
}

/** What `run` did that wakes Pip, if it is at rest or waiting on the person; null while it is under way. */
export function wakeStateOf(run: Pick<Run, "state" | "stoppedByLimit">): WakeState | null {
  switch (run.state) {
    case "done":
    case "failed":
    case "needsAnswer":
    case "needsPermission":
    case "systemBlocked":
      return run.state;
    case "stopped":
      return run.stoppedByLimit ? "limit" : "stopped";
    default:
      return null;
  }
}

/** A fact as the supervisor keeps it: the fact Pip is told, with its key. */
export type KeyedFact = WakeFact & { key: string };

/** What the sample supervisor works with: the sample backend's parts, and how it wakes Pip. */
export interface SupervisorParts {
  runs: MockRuns;
  workstreams: MockWorkstreams;
  proposals: MockProposals;
  /** Wakes Pip in workstream `workstream`'s conversation about `facts`. */
  wake(workstream: string, facts: WakeFact[]): void;
  /** Stops workstream `workstream`'s wakes, waiting or running, as a pause at the ceiling does. */
  cancelWakes?(workstream: string): void;
}

/**
 * The sample backend's supervisor, as src-tauri/src/agent/supervisor.rs runs in the app, minus the clock: whenever a run, a
 * draft or a workstream changes it looks at every open workstream that isn't paused and decides there and then. It notes
 * the ticket drifting from its basis, then wakes Pip once for each `(workstream, run, state)` it wasn't woken for, which the
 * audit's `wake` lines say, unless the workstream or Pip has had its ceiling of wakes in a day. Like the app's it starts
 * nothing and writes nothing to Jira: it has no tracker.
 */
export class MockSupervisor {
  private busy = false;
  private again = false;
  private readonly off: (() => void)[];

  constructor(private readonly parts: SupervisorParts) {
    const look = () => this.check();
    this.off = [parts.runs.onChanged(look), parts.proposals.onChanged(look), parts.workstreams.onChanged(look)];
  }

  /** Stops listening. */
  dispose() {
    this.off.forEach((off) => off());
  }

  /** Looks at every workstream; a change made while it looks makes it look once more after, never inside itself. */
  check() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      for (let pass = 0; pass < 8; pass++) {
        this.again = false;
        for (const view of this.parts.workstreams.list()) this.handle(view.workstream.id);
        if (!this.again) break;
      }
    } finally {
      this.busy = false;
    }
  }

  /** The fact `state` of `run`, with a Triage's plan recommendation, a Review's verdict and blocking count, and its drafts. */
  private factOf(run: Run, state: WakeState): KeyedFact {
    const fact: KeyedFact = { run: run.id, kind: run.spec.kind, state, key: factKey(run, state) };
    if (state !== "done") return fact;
    const resolved = this.parts.runs.resolvedOf(run.id);
    if (run.spec.kind === "triage") {
      fact.planRecommended = triagePlanRecommended(run);
      const found = triageReadiness(run);
      if (found && !found.ready) fact.openQuestions = found.questions.length;
    }
    if (run.spec.kind === "review" && resolved) {
      fact.verdict = resolved.verdict;
      fact.blocking = resolved.findings.filter((f) => f.severity === "blocking").length;
    }
    fact.drafts = this.parts.runs.draftsWaitingFrom(run.id);
    return fact;
  }

  /** Notes the ticket of workstream `id` drifting, then wakes Pip for what it wasn't woken for yet, as `handle`. */
  private handle(id: string) {
    const { runs, workstreams } = this.parts;
    const ws = workstreams.get(id)?.workstream;
    if (!ws || ws.closedAt || ws.pausedReason) return;
    workstreams.noteBasisDrift(id);
    const linked = runs.list({ workstream: id });
    const woken = new Set(workstreams.events(id).filter((e) => e.actor === "supervisor" && e.action === "wake").map((e) => `${e.runId}|${e.detail}`));
    const fresh: KeyedFact[] = [];
    for (const run of [...linked].sort(byQueue)) {
      const state = wakeStateOf(run);
      if (!state) continue;
      const fact = this.factOf(run, state);
      if (!woken.has(`${fact.run}|${fact.key}`)) fresh.push(fact);
    }
    if (!fresh.length) return;
    if (!workstreams.admitWake(id, fresh)) {
      if (workstreams.get(id)?.workstream.pausedReason) this.parts.cancelWakes?.(id);
      return;
    }
    this.parts.wake(id, fresh.map(({ key: _, ...f }) => f));
  }
}
