import { relativeTime } from "../lib/views";
import type { Run, RunKind, RunState } from "../types";

export const QUIET_MINUTES = 30;
const MINUTE = 60_000;

export const LANE_IDS = ["needs", "running", "done", "bad", "earlier"] as const;
export type LaneId = (typeof LANE_IDS)[number];

export const LANES: Record<LaneId, { title: string; why: string }> = {
  needs: { title: "Needs you", why: "Waiting on an answer or a permission" },
  running: { title: "Running", why: "Working in the background" },
  done: { title: "Done, ready to review", why: "Look over what it found" },
  bad: { title: "Failed or stuck", why: "Not going anywhere without you" },
  earlier: { title: "Earlier", why: "Stopped by you or from Terminal" },
};

const NEEDS: readonly RunState[] = ["needsAnswer", "needsPermission", "systemBlocked"];

export const needsPerson = (run: Pick<Run, "state">) => NEEDS.includes(run.state);

/** Minutes without progress once a working run has been quiet for `QUIET_MINUTES` or more; null otherwise. */
export function quietMinutes(run: Pick<Run, "state" | "lastProgressAt">, now: number): number | null {
  if (run.state !== "working") return null;
  const since = Date.parse(run.lastProgressAt);
  if (Number.isNaN(since)) return null;
  const minutes = Math.floor((now - since) / MINUTE);
  return minutes >= QUIET_MINUTES ? minutes : null;
}

export function laneOf(run: Run, now: number): LaneId {
  switch (run.state) {
    case "needsAnswer":
    case "needsPermission":
    case "systemBlocked":
      return "needs";
    case "queued":
    case "launching":
      return "running";
    case "working":
      return quietMinutes(run, now) === null ? "running" : "bad";
    case "done":
      return "done";
    case "failed":
    case "unknown":
      return "bad";
    case "stopped":
      return "earlier";
  }
}

export type Tone = "pip" | "accent" | "done" | "warn" | "blocked" | "muted";
export type RunIcon = "hand" | "spark" | "check" | "clock" | "alert" | "stop" | "lock" | "help";

export interface StateView {
  label: string;
  tone: Tone;
  icon: RunIcon;
  /** Shows the pulsing dot. */
  live: boolean;
}

const VIEWS: Record<RunState, StateView> = {
  queued: { label: "Queued", tone: "accent", icon: "clock", live: false },
  launching: { label: "Launching", tone: "accent", icon: "spark", live: true },
  working: { label: "Working", tone: "accent", icon: "spark", live: true },
  needsAnswer: { label: "Needs an answer", tone: "pip", icon: "hand", live: false },
  needsPermission: { label: "Needs permission", tone: "pip", icon: "hand", live: false },
  systemBlocked: { label: "Sign-in needed", tone: "pip", icon: "lock", live: false },
  done: { label: "Ready to review", tone: "done", icon: "check", live: false },
  failed: { label: "Failed", tone: "blocked", icon: "alert", live: false },
  stopped: { label: "Stopped", tone: "muted", icon: "stop", live: false },
  unknown: { label: "Unknown", tone: "warn", icon: "help", live: false },
};

/** What a run is called and coloured, with the quiet colour taking over from the working one. */
export function stateView(run: Pick<Run, "state" | "lastProgressAt">, now: number): StateView {
  const view = VIEWS[run.state];
  return quietMinutes(run, now) === null ? view : { ...view, tone: "warn", live: false };
}

export const KIND_LABEL: Record<RunKind, string> = { investigate: "Investigate", triage: "Triage", build: "Build", review: "Review", verify: "Verify" };

export function quietText(minutes: number): string {
  if (minutes < 120) return `Quiet for ${minutes} min`;
  return `Quiet for ${Math.floor(minutes / 60)} h`;
}

/** "578k tokens", "1.2M tokens"; null when the count isn't known. Never a price. */
export function formatTokens(tokens: number | null): string | null {
  if (tokens === null || tokens < 0 || !Number.isFinite(tokens)) return null;
  if (tokens < 1000) return `${Math.round(tokens)} ${Math.round(tokens) === 1 ? "token" : "tokens"}`;
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${thousands}k tokens`;
  const millions = Math.round(tokens / 100_000) / 10;
  return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M tokens`;
}

/** When the run's age counts from: the moment it ended, otherwise the moment it was queued. */
export const ageSince = (run: Pick<Run, "endedAt" | "queuedAt">): string => run.endedAt ?? run.queuedAt;

export const ageText = (run: Pick<Run, "endedAt" | "queuedAt">, now: number) => relativeTime(ageSince(run), new Date(now));

export const repoName = (repo: string) => repo.split("/").pop() ?? repo;

export const branchOf = (run: Pick<Run, "branch" | "spec">) => run.branch ?? `worktree-${run.spec.name}`;

/** The ticket's own title when it is cached; for an investigation with no ticket, the person's question; otherwise what the run is for, from the kind and the key. */
export function runTitle(run: Pick<Run, "item" | "spec">, ticketTitle: string | null | undefined): string {
  if (ticketTitle?.trim()) return ticketTitle.trim();
  const question = !run.item && run.spec.project ? run.spec.instruction.trim().replace(/\s+/g, " ") : "";
  if (question) return question.length > 90 ? `${question.slice(0, 89).trimEnd()}…` : question;
  const kind = KIND_LABEL[run.spec.kind] ?? "Run";
  return run.item ? `${kind} ${run.item.key}` : `${kind} ${repoName(run.spec.repo)}`;
}

/** `approve Bash: git push` as `{ tool: "Bash", command: "git push" }`; anything else is shown whole. */
export function permissionRequest(needs: string | null): { tool: string | null; command: string } | null {
  const text = needs?.trim();
  if (!text) return null;
  const m = /^approve\s+([^:\s]+):\s*([\s\S]*)$/i.exec(text);
  return m ? { tool: m[1], command: m[2] } : { tool: null, command: text };
}

/** The first line or sentence of a result, for the card; the full text is for the run sheet. */
export function resultHeadline(result: string | null): string | null {
  const first = result?.trim().split(/\n+/)[0]?.trim();
  if (!first) return null;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}

/** What a run is doing right now, in the person's words, for working and waiting runs. */
export function progressText(run: Pick<Run, "state" | "lastDetail">): string {
  if (run.lastDetail?.trim()) return run.lastDetail.trim();
  if (run.state === "queued") return "Waiting to start";
  if (run.state === "launching") return "Starting up";
  return "Working";
}

export interface AgentFilters {
  lane: LaneId | "all";
  repo: string;
  ticket: string;
}

export const ALL = "all";
export const NO_FILTERS: AgentFilters = { lane: ALL, repo: ALL, ticket: ALL };

export const isFiltered = (f: AgentFilters) => f.lane !== ALL || f.repo !== ALL || f.ticket !== ALL;

export function applyFilters(runs: readonly Run[], f: AgentFilters, now: number): Run[] {
  return runs.filter((r) => (f.lane === ALL || laneOf(r, now) === f.lane) && (f.repo === ALL || r.spec.repo === f.repo) && (f.ticket === ALL || r.item?.key === f.ticket));
}

/** The repos and ticket keys the filters can offer, from every run rather than the filtered ones. */
export function filterOptions(runs: readonly Run[]): { repos: string[]; tickets: string[] } {
  const repos = new Set<string>();
  const tickets = new Set<string>();
  for (const r of runs) {
    repos.add(r.spec.repo);
    if (r.item) tickets.add(r.item.key);
  }
  const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return { repos: [...repos].sort(byText), tickets: [...tickets].sort(byText) };
}

/** Newest activity first: a run that ended counts from its end, one still going from when it was queued. */
export function sortRuns(runs: readonly Run[]): Run[] {
  return [...runs].sort((a, b) => ageSince(b).localeCompare(ageSince(a)) || a.id.localeCompare(b.id));
}

export interface LaneGroup {
  lane: LaneId;
  title: string;
  why: string;
  runs: Run[];
}

/** The lanes that have runs, in lane order, each sorted. */
export function groupRuns(runs: readonly Run[], filters: AgentFilters, now: number): LaneGroup[] {
  const shown = applyFilters(runs, filters, now);
  return LANE_IDS.map((lane) => ({ lane, ...LANES[lane], runs: sortRuns(shown.filter((r) => laneOf(r, now) === lane)) })).filter((g) => g.runs.length > 0);
}

/** Whether a lane shows its runs: Earlier is folded away until it is opened or something is filtered. */
export const laneIsFolded = (lane: LaneId, earlierOpen: boolean, filters: AgentFilters) => lane === "earlier" && !earlierOpen && !isFiltered(filters);

/** Run ids in the order j and k walk them: every lane, minus a folded one. */
export function navOrder(groups: readonly LaneGroup[], earlierOpen: boolean, filters: AgentFilters): string[] {
  return groups.filter((g) => !laneIsFolded(g.lane, earlierOpen, filters)).flatMap((g) => g.runs.map((r) => r.id));
}

/** Where j (1) or k (-1) goes from `current`; with nothing current j starts at the first and k at the last. */
export function stepRun(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (!order.length) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return delta === 1 ? order[0] : order[order.length - 1];
  return order[Math.min(order.length - 1, Math.max(0, at + delta))];
}

/** Runs that need the person, plus failed ones they haven't looked at yet. Quiet runs never count. */
export function attentionCount(runs: readonly Run[], seenFailed: ReadonlySet<string>): number {
  return runs.filter((r) => needsPerson(r) || (r.state === "failed" && !seenFailed.has(r.id))).length;
}

export function summaryLine(runs: readonly Run[], now: number): string {
  if (!runs.length) return "Nothing running";
  const count = (lane: LaneId) => runs.filter((r) => laneOf(r, now) === lane).length;
  const needs = count("needs");
  const quiet = runs.filter((r) => quietMinutes(r, now) !== null).length;
  const failed = runs.filter((r) => r.state === "failed").length;
  const unclear = runs.filter((r) => r.state === "unknown").length;
  const running = count("running");
  const done = count("done");
  return [needs && `${needs} ${needs === 1 ? "needs" : "need"} you`, running && `${running} running`, done && `${done} ready to review`, quiet && `${quiet} quiet`, failed && `${failed} failed`, unclear && `${unclear} unclear`]
    .filter(Boolean)
    .join(" · ") || "Nothing running";
}

/** Runs Stop all would reach in this account: the ones that can be stopped. */
export const stoppable = (runs: readonly Run[]): Run[] => runs.filter((r) => r.state === "working" || needsPerson(r));
