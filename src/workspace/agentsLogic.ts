import { humanDuration } from "../lib/runNames";
import { relativeTime } from "../lib/views";
import { roleLabel, stepOf } from "../lib/roles";
import { runLabels } from "../lib/workstreamStage";
import type { Proposal, Run, RunState, WorkstreamView } from "../types";

export const QUIET_MINUTES = 30;
const MINUTE = 60_000;

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

/** What a done run reads once its main draft was approved and applied: there is nothing left to review. */
export const APPROVED_LABEL = "Approved";

/** Drafts that only act on a run (start, send back, answer it); they are never what the run produced. */
const ACTS_ON_RUN: readonly Proposal["intent"]["type"][] = ["startRun", "followUp", "runAnswer"];

/**
 * Whether a done run's main draft was applied: a plan's description update, else the first draft its result made (a comment, a review's post).
 * A run whose draft is still open, skipped or replaced, or that made none, is still to review.
 */
export function runApproved(run: Pick<Run, "id" | "state"> & { spec: Pick<Run["spec"], "role"> }, proposals: Iterable<Proposal>): boolean {
  if (run.state !== "done") return false;
  let main: Proposal | null = null;
  const plan = stepOf(run.spec.role) === "plan";
  for (const p of proposals) {
    if (p.origin.type !== "run" || p.origin.runId !== run.id || ACTS_ON_RUN.includes(p.intent.type) || p.state.type === "retired") continue;
    // A plan's comment is not what it was made for: the description is.
    if (plan && p.intent.type !== "rewrite") continue;
    if (!main || p.createdAt < main.createdAt) main = p;
  }
  return main?.state.type === "applied";
}

/** What a run is called and coloured, with the quiet colour taking over from the working one. `approved` is `runApproved`: a done run reads "Approved" instead of "Ready to review". */
export function stateView(run: Pick<Run, "state" | "lastProgressAt" | "slotWaitSince">, now: number, approved = false): StateView {
  if (waitsForSlot(run)) return { ...VIEWS.queued, label: SLOT_WAIT };
  if (approved && run.state === "done") return { ...VIEWS.done, label: APPROVED_LABEL };
  const view = VIEWS[run.state];
  return quietMinutes(run, now) === null ? view : { ...view, tone: "warn", live: false };
}

/** What a stopped run says it was left at: that it may have carried on elsewhere, or where it stopped. */
export function stoppedText(run: Pick<Run, "error" | "lastDetail" | "possibleContinuations"> & Partial<Pick<Run, "launchedAt">>): string {
  // Stopped while it waited for a slot: it never had a session, and the reason says so.
  if (run.launchedAt === null && run.error?.trim()) return run.error.trim();
  return run.possibleContinuations?.length ? "May have continued in another session" : run.lastDetail?.trim() || "Stopped before it finished";
}

/** "Quiet for 40 min", "Quiet for 3 h", "Quiet for 10 days". */
export function quietText(minutes: number): string {
  return `Quiet for ${humanDuration(minutes)}`;
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

/** The ticket's own title when it is cached; for a run with no ticket, its brief; otherwise what the run is for, from the role and the key. */
export function runTitle(run: Pick<Run, "item" | "spec">, ticketTitle: string | null | undefined): string {
  if (ticketTitle?.trim()) return ticketTitle.trim();
  const brief = !run.item ? run.spec.brief.trim().replace(/\s+/g, " ") : "";
  if (brief) return brief.length > 90 ? `${brief.slice(0, 89).trimEnd()}…` : brief;
  const role = roleLabel(run.spec.role);
  return run.item ? `${role} ${run.item.key}` : `${role} ${repoName(run.spec.repo)}`;
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

export const SLOT_WAIT = "Waiting for a slot";

/** An approved run that stays queued only because as many agents as the settings allow are running. */
export const waitsForSlot = (run: Pick<Run, "state" | "slotWaitSince">) => run.state === "queued" && !!run.slotWaitSince;

/**
 * The runs that can be given a slot, as `launch_waiting` lines them up: none in a workstream that is paused or closed,
 * which waits for the person rather than for a slot. `workstreams` are the ones loaded; a run in any other stays in line.
 */
export function slotQueue<R extends Pick<Run, "spec">>(runs: readonly R[], workstreams: readonly WorkstreamView[]): readonly R[] {
  const stalled = new Set(workstreams.filter((v) => v.workstream.pausedReason || v.workstream.closedAt).map((v) => v.workstream.id));
  return stalled.size ? runs.filter((r) => !r.spec.workstream || !stalled.has(r.spec.workstream)) : runs;
}

/** Where `run` is in line for a slot, 1 for next, among the queued runs waiting for one in approval order; null when it isn't waiting. */
export function slotPosition(run: Pick<Run, "id" | "state" | "slotWaitSince">, runs: readonly Pick<Run, "id" | "state" | "slotWaitSince" | "queuedAt">[]): number | null {
  if (!waitsForSlot(run)) return null;
  // By the time itself: the backend writes a varying number of fractional digits, so the strings don't sort.
  const line = runs.filter(waitsForSlot).sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt) || a.id.localeCompare(b.id));
  const at = line.findIndex((r) => r.id === run.id);
  return at < 0 ? null : at + 1;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "Waiting for a slot · 2nd in line", or without the place when the other runs aren't known. */
export function slotText(run: Pick<Run, "id" | "state" | "slotWaitSince">, runs?: readonly Pick<Run, "id" | "state" | "slotWaitSince" | "queuedAt">[]): string | null {
  if (!waitsForSlot(run)) return null;
  const at = runs ? slotPosition(run, runs) : null;
  return at === null ? SLOT_WAIT : `${SLOT_WAIT} · ${ordinal(at)} in line`;
}

/** What a run is doing right now, in the person's words, for working and waiting runs; `runs` places one waiting for a slot in line. */
export function progressText(run: Pick<Run, "state" | "lastDetail"> & Partial<Pick<Run, "id" | "slotWaitSince">>, runs?: readonly Run[]): string {
  const slot = run.id ? slotText({ id: run.id, state: run.state, slotWaitSince: run.slotWaitSince }, runs) : null;
  if (slot) return slot;
  if (run.lastDetail?.trim()) return run.lastDetail.trim();
  if (run.state === "queued") return "Waiting to start";
  if (run.state === "launching") return "Starting up";
  // Said after the state's own "Working", so it adds what is known rather than the same word again ("Working · Working").
  return "No update from it yet";
}

/** The Work screen's one filter: only what has something waiting on the person, Needs you's one list. */
export interface AgentFilters {
  needs: boolean;
}

/** Which runs and workstreams hold a need (src/lib/needs.ts), for the Needs you filter; `loose` is a need that belongs to no workstream. */
export interface NeedsScope {
  runs: ReadonlySet<string>;
  workstreams: ReadonlySet<string>;
  loose: boolean;
}

export function needsScope(needs: readonly { runId?: string | null; workstreamId: string | null }[]): NeedsScope {
  return {
    runs: new Set(needs.flatMap((n) => (n.runId ? [n.runId] : []))),
    workstreams: new Set(needs.flatMap((n) => (n.workstreamId ? [n.workstreamId] : []))),
    loose: needs.some((n) => n.workstreamId === null),
  };
}

export const NO_FILTERS: AgentFilters = { needs: false };
export const isFiltered = (f: AgentFilters) => f.needs;

/** The runs the filter lets through; with Needs you on, the runs that hold a need (all of them when the need scope is not known yet). */
export const applyFilters = (runs: readonly Run[], f: AgentFilters, needed?: NeedsScope): Run[] => (f.needs && needed ? runs.filter((r) => needed.runs.has(r.id)) : [...runs]);

/** Newest activity first: a run that ended counts from its end, one still going from when it was queued. */
export function sortRuns(runs: readonly Run[]): Run[] {
  return [...runs].sort((a, b) => ageSince(b).localeCompare(ageSince(a)) || a.id.localeCompare(b.id));
}

export const NO_WORKSTREAM_TITLE = "No workstream";

export interface WorkstreamGroup {
  /** The workstream's id; null for the runs that belong to none. */
  id: string | null;
  title: string;
  /** The ticket the workstream is about, when it has one. */
  itemKey?: string | null;
  runs: Run[];
  /** Run id to its short name in the workstream (`R1` for the first queued), counted over all its runs so a filter never renumbers them. */
  labels: Record<string, string>;
}

/**
 * One group per workstream with runs the filter lets through, the one with the latest activity first, then the runs in
 * no workstream last as "No workstream". A workstream missing from `workstreams` (a closed one) is still a group, named by
 * its id. With no filter on, an open workstream that has no run yet is a group too, so every workstream can be opened
 * from here; with Needs you on, so is any workstream or No workstream that holds a need, even when none of its runs is the
 * need: the need is in its detail.
 */
export function groupRunsByWorkstream(runs: readonly Run[], workstreams: readonly WorkstreamView[], filters: AgentFilters, needed?: NeedsScope): WorkstreamGroup[] {
  const shown = new Set(runs.filter((r) => !filters.needs || !needed || needed.runs.has(r.id)).map((r) => r.id));
  const byId = new Map(workstreams.map((w) => [w.workstream.id, w]));
  const linked = new Map<string, Run[]>();
  const loose: Run[] = [];
  for (const r of runs) {
    const id = r.spec.workstream;
    if (id) linked.set(id, [...(linked.get(id) ?? []), r]);
    else if (shown.has(r.id)) loose.push(r);
  }
  const groups: WorkstreamGroup[] = [];
  const holdsNeed = (id: string) => !filters.needs || !needed || needed.workstreams.has(id);
  for (const [id, all] of linked) {
    const view = byId.get(id);
    const mine = sortRuns(all.filter((r) => shown.has(r.id)));
    if (!mine.length && !(filters.needs && needed?.workstreams.has(id))) continue;
    groups.push({ id, title: view?.workstream.title ?? `Workstream ${id}`, itemKey: view?.workstream.itemKey ?? null, runs: mine, labels: Object.fromEntries(runLabels(all)) });
  }
  const started = new Map<string, string>();
  for (const view of workstreams) {
    const ws = view.workstream;
    if (ws.closedAt !== null || linked.has(ws.id) || !holdsNeed(ws.id)) continue;
    started.set(ws.id, ws.createdAt);
    groups.push({ id: ws.id, title: ws.title, itemKey: ws.itemKey, runs: [], labels: {} });
  }
  const latest = (g: WorkstreamGroup) => (g.runs[0] ? ageSince(g.runs[0]) : (started.get(g.id ?? "") ?? ""));
  groups.sort((a, b) => latest(b).localeCompare(latest(a)) || a.title.localeCompare(b.title));
  if (loose.length || (filters.needs && needed?.loose)) groups.push({ id: null, title: NO_WORKSTREAM_TITLE, runs: sortRuns(loose), labels: {} });
  return groups;
}

/** The groups the Work screen shows and the order j and k walk their runs; the run sheet browses in the same order. */
export function agentGroups(runs: readonly Run[], workstreams: readonly WorkstreamView[], filters: AgentFilters, needed?: NeedsScope) {
  const groups = groupRunsByWorkstream(runs, workstreams, filters, needed);
  return { workstreams: groups, order: groups.flatMap((g) => g.runs.map((r) => r.id)) };
}

/** Where j (1) or k (-1) goes from `current`; with nothing current j starts at the first and k at the last. */
export function stepRun(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (!order.length) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return delta === 1 ? order[0] : order[order.length - 1];
  return order[Math.min(order.length - 1, Math.max(0, at + delta))];
}

/** A run that needs the person, or a failed one they haven't dismissed: the runs `yourAgents` counts as waiting on the person. */
export const needsAttention = (run: Pick<Run, "id" | "state">, dismissed: ReadonlySet<string>) =>
  needsPerson(run) || (run.state === "failed" && !dismissed.has(run.id));

const AT_WORK: readonly RunState[] = ["queued", "launching", "working"];

/**
 * The one meaning of "your agents", wherever agents are counted as a whole ("Your agents 3 of 6"): runs at work (queued,
 * launching or working, quiet ones too) and runs waiting on the person (`needsAttention`). Finished, stopped and
 * failed runs already dismissed are not agents any more, only history.
 */
export const yourAgents = (runs: readonly Run[], dismissed: ReadonlySet<string>): Run[] => runs.filter((r) => AT_WORK.includes(r.state) || needsAttention(r, dismissed));

/**
 * The runs at work, counted one way for the Agents view's summary and Pip's composer footer so the two agree:
 * `running` launching or working with recent progress, `quiet` working with none for a while, `queued` approved and
 * about to start, `waiting` approved and waiting for a slot.
 */
export function liveCounts(runs: readonly Run[], now: number): { running: number; quiet: number; queued: number; waiting: number } {
  const quiet = runs.filter((r) => quietMinutes(r, now) !== null).length;
  const running = runs.filter((r) => r.state === "launching" || r.state === "working").length - quiet;
  const waiting = runs.filter(waitsForSlot).length;
  const queued = runs.filter((r) => r.state === "queued").length - waiting;
  return { running, quiet, queued, waiting };
}

/** The live counts in words, in the order both lines give them: "2 running · 1 queued · 1 waiting for a slot". Quiet runs are said apart, where each line puts them. */
export const liveWords = (c: ReturnType<typeof liveCounts>) => [c.running && `${c.running} running`, c.queued && `${c.queued} queued`, c.waiting && `${c.waiting} waiting for a slot`].filter((w): w is string => !!w);

/**
 * The Work screen's summary for Pip: "2 need you · 2 running". Need you is Needs you's one count (`needsYou`, as the rail
 * badge and the composer give it); running, queued and waiting for a slot are `liveCounts`, as Pip's footer counts.
 */
export function summaryLine(runs: readonly Run[], now: number, needsYou = 0): string {
  if (!runs.length) return "Nothing running";
  const live = liveCounts(runs, now);
  return [needsYou && `${needsYou} ${needsYou === 1 ? "needs" : "need"} you`, ...liveWords(live), live.quiet && `${live.quiet} quiet`].filter(Boolean).join(" · ") || "Nothing running";
}

/** Runs Stop all would reach in this account: the ones that can be stopped. */
export const stoppable = (runs: readonly Run[]): Run[] => runs.filter((r) => r.state === "working" || needsPerson(r));

/** Approved runs Stop all stops before they start, so none takes a slot it frees. */
export const slotWaiters = (runs: readonly Run[]): Run[] => runs.filter(waitsForSlot);

/** Stop all's button, which counts what it can stop (`stoppable` and `slotWaiters`), a set apart from your agents, so it says so: "Stop all (5 stoppable)". */
export const stopAllLabel = (reach: number) => (reach ? `Stop all (${reach} stoppable)` : "Stop all");

/** What Stop all would stop, in words: "3 agents", "3 agents and 2 waiting to start", "1 waiting to start". */
export function stopAllText(agents: number, waiting: number): string {
  const live = agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : "";
  const queued = waiting ? `${waiting} waiting to start` : "";
  return [live, queued].filter(Boolean).join(" and ") || "0 agents";
}

/** What approving a plan is, said where the plan's description update waits: the Plan step and Pip's word when a plan finishes (N6). */
export const APPROVE_PLAN = "Approve the description update to let Build start.";

/**
 * The questions a plan run left for a person, from its answer's "Open questions" section, as bullets or numbered lines,
 * at most five; none when it has no such section. They are shown beside the plan's description update, never written
 * anywhere by this.
 */
export function planOpenQuestions(result: string | null | undefined): string[] {
  const lines = (result ?? "").split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s*open questions\b/i.test(l.trim()));
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1]?.trim();
    if (item) out.push(item);
  }
  return out.slice(0, 5);
}
