import { stepOf } from "../lib/roles";
import type { Run } from "../types";
import { byQueue } from "../lib/workstreamStage";
import type { MockWorkstreams } from "./mockWorkstreams";
import type { MockRuns } from "./mockRuns";
import type { MockProposals } from "./mockProposals";

/**
 * The supervisor's decisions as the sample backend makes them, mirroring src-tauri/src/agent/supervisor.rs.
 * `eventLine` is `event_line`. Both sides run src/backend/supervisor.fixtures.json.
 */

/** What a run did that wakes Pip. */
export type WakeState = "done" | "failed" | "stopped" | "needsAnswer" | "needsPermission" | "systemBlocked" | "pullRequest";

/** One thing that happened to a run, as Pip is told it: ids, roles, states, counts and parsed flags only. */
export interface WakeFact {
  run: string;
  role: string;
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
  needsAnswer: "Needs an answer",
  needsPermission: "Needs permission",
  systemBlocked: "Blocked on sign-in",
  pullRequest: "Pull request found",
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
  let line = `[Event] ${id ? `run ${id}` : "a run"} (${f.role}) ${STATE_WORDS[f.state]}`;
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

export function oneQuestionEach(questions: readonly string[]): string[] {
  return questions.flatMap((q) => q.trim().split(/(?<=\?)\s+(?=\p{Lu})/u)).filter((q) => q !== "");
}

/** A description is thin when it is a single non-empty line of fewer than `THIN_LIMIT` characters: the one deliberately vague kind of ticket the sample's Triage recognises. */
export const THIN_LIMIT = 40;

export function thinDescription(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t !== "" && !t.includes("\n") && t.length < THIN_LIMIT;
}

/** The open questions a sample triage lists; the first holds two, which every reader lists one each (`oneQuestionEach`). */
const unclearQuestions = (key: string) => [`What does done look like for ${key}? Which behaviour or number should change?`, "What is in scope and what is out?", "Who asked for this, and who is waiting on it?"];

/** What a sample triage of a ticket with a thin description finishes with: it can't size the work, says `Ready to plan: no` and lists what it would need to know. */
export function unclearTriageResult(key: string): string {
  return [
    `${key}'s description is one short line, so I can't size it with any confidence.`,
    "",
    "Ready to plan: no",
    "Open questions:",
    ...unclearQuestions(key).map((q) => `- ${q}`),
    "",
    "Plan recommended: yes",
    "",
    "For Jira:",
    "The ticket cannot be sized yet: the description is one line. Before it can be planned it needs an answer on what done looks like, what is in and out of scope, and who asked for it and who is waiting on it.",
  ].join("\n");
}

const COUNTED = ["no", "one", "two", "three", "four", "five", "six"];

/** The summary of that triage: it counts the questions as they are listed (one each), so it never says three over four bullets. */
export const unclearTriageSummary = (key: string) => {
  const n = oneQuestionEach(unclearQuestions(key)).length;
  return `Triage complete: the ticket isn't clear enough to size, ${COUNTED[n] ?? n} ${n === 1 ? "question" : "questions"} open`;
};

const KEY_STATE: Record<WakeState, string> = {
  done: "done",
  failed: "failed",
  stopped: "stopped",
  needsAnswer: "needs_answer",
  needsPermission: "needs_permission",
  systemBlocked: "system_blocked",
  pullRequest: "pr_found",
};

const secs = (at: string) => Math.floor(Date.parse(at) / 1000);

/** The state part of the `(workstream, run, state)` key, as `mark`: a finish after the person carried on, or a question, by when. */
export function factKey(run: Pick<Run, "continuedAt" | "lastProgressAt">, state: WakeState): string {
  const base = KEY_STATE[state];
  if (state === "done" || state === "stopped") return run.continuedAt ? `${base}@${secs(run.continuedAt)}` : base;
  if (state === "failed" || state === "pullRequest") return base;
  return `${base}@${secs(run.lastProgressAt)}`;
}

/** What `run` did that wakes Pip, if it is at rest or waiting on the person; null while it is under way. */
export function wakeStateOf(run: Pick<Run, "state">): WakeState | null {
  switch (run.state) {
    case "done":
    case "failed":
    case "stopped":
    case "needsAnswer":
    case "needsPermission":
    case "systemBlocked":
      return run.state;
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
    const fact: KeyedFact = { run: run.id, role: run.spec.role, state, key: factKey(run, state) };
    if (state !== "done") return fact;
    fact.drafts = this.parts.runs.draftsWaitingFrom(run.id);
    if (stepOf(run.spec.role) === "build" && this.parts.runs.pullHeadOf(run.id) === null) fact.waitingForPr = true;
    return fact;
  }

  /** Notes the ticket of workstream `id` drifting, then wakes Pip for what it wasn't woken for yet, as `handle`. */
  private handle(id: string) {
    const { runs, workstreams } = this.parts;
    const ws = workstreams.get(id)?.workstream;
    if (!ws || ws.closedAt || ws.pausedReason) return;
    workstreams.noteBasisDrift(id);
    const linked = runs.list({ workstream: id });
    const events = workstreams.events(id);
    const woken = new Set(events.filter((e) => e.actor === "supervisor" && e.action === "wake").map((e) => `${e.runId}|${e.detail}`));
    const stoppedByPerson = (run: Run) => events.some((e) => e.actor === "person" && e.action === "run_stopped" && e.runId === run.id && (!run.continuedAt || e.at >= run.continuedAt));
    const toldWaiting = (run: Run, key: string) => events.some((e) => e.actor === "supervisor" && e.action === "waiting_for_pr" && e.runId === run.id && e.detail === key);
    const fresh: KeyedFact[] = [];
    for (const run of [...linked].sort(byQueue)) {
      const state = wakeStateOf(run);
      if (!state || (state === "stopped" && stoppedByPerson(run))) continue;
      const fact = this.factOf(run, state);
      if (!woken.has(`${fact.run}|${fact.key}`)) fresh.push(fact);
      const found: KeyedFact = { run: run.id, role: run.spec.role, state: "pullRequest", key: factKey(run, "pullRequest") };
      if (state === "done" && woken.has(`${fact.run}|${fact.key}`) && !woken.has(`${found.run}|${found.key}`) && toldWaiting(run, fact.key) && runs.pullHeadOf(run.id) !== null) fresh.push(found);
    }
    if (!fresh.length) return;
    if (!workstreams.admitWake(id, fresh)) {
      if (workstreams.get(id)?.workstream.pausedReason) this.parts.cancelWakes?.(id);
      return;
    }
    this.parts.wake(id, fresh.map(({ key: _, ...f }) => f));
  }
}
