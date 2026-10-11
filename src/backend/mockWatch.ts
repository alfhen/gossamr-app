import { AUTO_WATCH_EVERYTHING_MAX, type ContainerRef, type Intent, type RunKind, type WatchChange, type WatchMode, type WatchRow, type WatchState } from "../types";
import type { ScriptedFinish } from "./mockRunResult";

export interface MockOptions {
  /** How many projects the catalog lists, at least the four that hold sample items. Above 12 the choice of what to watch starts unset. */
  catalogSize?: number;
  /** When set, a GitHub connection is already signed in with this many repositories (at least the five sample ones). Without it the sign-in commands connect one with 14. */
  githubRepos?: number;
  /** How the device flow ends once the sample waits for it: authorised after `delayMs`, or refused or expired. */
  device?: { delayMs: number; outcome: "authorised" | "denied" | "expired" };
  /** Which scripted agent runs exist, and the moment their ages count back from. */
  /** How long the scripted Pip waits between words, in ms (a step takes six times as long); unset keeps its usual pace. */
  pipPace?: number;
  /** False starts the sample with Agents turned off, as the desktop app is until the person turns them on. */
  agents?: boolean;
  /** New workstreams open in Manage mode, so the supervisor wakes Pip and starts the routine steps in them. */
  wsManage?: boolean;
  runs?: { seed?: "busy" | "kinds" | "empty" | "many" | "failures" | "stuck" | "reports"; epoch?: number; environment?: "ok" | "missing" | "signedOut"; cap?: number; pipRun?: boolean; planDescription?: boolean; untrusted?: boolean; prSurfaceMs?: number | null };
}

interface Stored {
  depth: WatchRow["depth"];
  pinned: boolean;
  source: WatchRow["source"];
  addedAt: string;
  unwatchedAt: string | null;
  inaccessible: boolean;
}

/** What a connection follows, kept the way the backend keeps it: a mode and rows that are soft-unwatched rather than removed. */
export class MockWatch {
  mode: WatchMode;
  private rows = new Map<string, Stored>();

  constructor(
    private readonly connectionId: string,
    readonly catalogSize: number,
  ) {
    this.mode = catalogSize <= AUTO_WATCH_EVERYTHING_MAX ? "everything" : "unset";
  }

  /** Ids of the containers that may be shown, or null when every one may. */
  visible(): Set<string> | null {
    if (this.mode !== "selected") return null;
    return new Set([...this.rows].filter(([, r]) => r.unwatchedAt === null).map(([id]) => id));
  }

  isWatched(containerId: string): boolean {
    return this.visible()?.has(containerId) ?? true;
  }

  setMode(mode: WatchMode) {
    this.mode = mode;
  }

  apply(changes: WatchChange[], at = new Date().toISOString()) {
    const selected = this.mode === "selected";
    for (const c of changes) {
      const row = this.rows.get(c.containerId);
      if (c.watched === false) {
        if (row && row.unwatchedAt === null) row.unwatchedAt = at;
        continue;
      }
      if (!row) {
        if (selected && c.watched !== true) continue;
        this.rows.set(c.containerId, {
          depth: c.depth ?? "involved",
          pinned: c.pinned ?? false,
          source: c.source ?? (selected ? "manual" : "everything"),
          addedAt: at,
          unwatchedAt: null,
          inaccessible: false,
        });
        continue;
      }
      if (c.watched === true) row.unwatchedAt = null;
      row.depth = c.depth ?? row.depth;
      row.pinned = c.pinned ?? row.pinned;
      row.source = c.source ?? row.source;
    }
  }

  state(describe: (id: string) => { key: string; name: string; cachedItems: number }): WatchState {
    const watches: WatchRow[] = [...this.rows].map(([id, r]) => {
      const container: ContainerRef = { connectionId: this.connectionId, externalId: id };
      return { container, ...r, ...describe(id) };
    });
    return {
      connectionId: this.connectionId,
      mode: this.mode,
      needsChoice: this.mode === "unset" && this.catalogSize > AUTO_WATCH_EVERYTHING_MAX,
      catalogSize: Math.min(this.catalogSize, AUTO_WATCH_EVERYTHING_MAX + 1),
      watches,
    };
  }
}

/** What the sample backend hands a dev browser to drive it from outside, as the e2e tests do (`advanceRuns` in e2e/support/app.ts). */
export interface MockHandle {
  /** Moves one run, or every unfinished run, a step along (queued, launching, working, done), as `MockRuns.advance` does. */
  advanceRuns(id?: string): void;
  /** The audit of every workstream, oldest first within each, as `workstreams_events` reads one. */
  workstreamEvents(): { workstreamId: string; actor: string; action: string; runId: string | null }[];
  /** Every run the sample backend holds, newest first: its id, kind and state. */
  runs(): { id: string; kind: string; state: string }[];
  /** Makes the draft pull requests finished builds opened show on the code host now, as a code sync finding them; true when there was one. */
  surfacePullRequests(): boolean;
  /** The next run of `kind` to finish writes this: a triage's plan recommendation, a review's verdict, or a data marker. */
  scriptNext(kind: RunKind, script: ScriptedFinish): void;
  /** Every write the sample tracker made, oldest first, with the draft the person approved for it. */
  jiraWrites(): { proposalId: string; type: string; key: string | null }[];
  /** Sets workstream `id`'s own limits for automatic turns and wakes. */
  setBudget(id: string, budget: { autoTurns?: number | null; wakes?: number | null }): void;
  /** Makes the scripted Pip wait, answering, after starting each turn (true) until let go (false). */
  holdPip(on: boolean): void;
  /** Whether the scripted Pip has no turn running or waiting anywhere, a wake the supervisor queued included. */
  pipIdle(): boolean;
}

/** The parts of the sample backend the handle reaches. */
export interface MockClockParts {
  runs: { advance(id?: string): void; list(): { id: string; spec: { kind: string }; state: string }[]; surfacePullRequests(): boolean; scriptNext(kind: RunKind, script: ScriptedFinish): void };
  workstreams?: { list(includeClosed?: boolean): { workstream: { id: string } }[]; events(id: string): MockHandleEvent[]; setBudget(id: string, budget: { autoTurns?: number | null; wakes?: number | null }): unknown };
  proposals?: { writes: readonly { proposalId: string; intent: Intent }[] };
  pip?: { hold(on: boolean): void; idle(): boolean };
}

declare global {
  /** Set by the sample backend in a dev browser only; see `exposeMockClock`. */
  var __gossamrMock: MockHandle | undefined;
}

/**
 * The scripted runs never move by themselves, so in a dev browser (never a build, never a test outside a browser) the sample
 * backend puts its clock on `globalThis.__gossamrMock`: `__gossamrMock.advanceRuns()` steps every unfinished run along and
 * `advanceRuns(id)` one run; `workstreamEvents()` reads the workstreams' audit, `runs()` lists the runs and `surfacePullRequests()` shows the
 * draft pull requests finished builds opened without waiting. The last sample backend made wins.
 */
export function exposeMockClock({ runs, workstreams, proposals, pip }: MockClockParts) {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  globalThis.__gossamrMock = {
    advanceRuns: (id) => runs.advance(id),
    workstreamEvents: () => (workstreams ? workstreams.list(true).flatMap((v) => workstreams.events(v.workstream.id)) : []),
    runs: () => runs.list().map((r) => ({ id: r.id, kind: r.spec.kind, state: r.state })),
    surfacePullRequests: () => runs.surfacePullRequests(),
    scriptNext: (kind, script) => runs.scriptNext(kind, script),
    jiraWrites: () => (proposals?.writes ?? []).map((w) => ({ proposalId: w.proposalId, type: w.intent.type, key: writtenKey(w.intent) })),
    setBudget: (id, budget) => void workstreams?.setBudget(id, budget),
    holdPip: (on) => pip?.hold(on),
    pipIdle: () => pip?.idle() ?? true,
  };
}

/** The ticket a write went to, by key, for the e2e tests to read. */
function writtenKey(intent: Intent): string | null {
  switch (intent.type) {
    case "comment":
    case "rewrite":
    case "transition":
      return intent.item.key;
    case "subtasks":
      return intent.parent.key;
    default:
      return null;
  }
}

type MockHandleEvent = ReturnType<MockHandle["workstreamEvents"]>[number];

/** In a dev browser, `?mockProjects=60` sets how many projects the sample catalog lists, and `?mockRepos=30` signs in a GitHub connection with that many repositories, and `?mockDevice=denied`, `expired` or `slow` makes the GitHub device flow wait 4 seconds and end that way. `?runs=busy` (without the other kinds), `empty`, `many`, `failures` or `reports` (a finished run for each way a result can have been read) changes the scripted agent runs, `?runsEnv=missing` or `signedOut` shows the Claude banners, `?runsCap=3` sets how many agents may run at once `?pipRun=1` starts with a run draft from Pip and `?runsUntrusted=1` makes Claude refuse every clone until Trust this folder is used. `?prSurface=manual` keeps a finished build's draft pull request off the code host until `__gossamrMock.surfacePullRequests()` (or Sync now) shows it, rather than after a moment. `?pipPace=200` slows the scripted Pip to 200ms a word, so a question can be queued behind one it is still answering. `?wsManage=1` opens new workstreams in Manage, where the supervisor wakes Pip and starts the routine steps. `?agents=off` starts with Agents turned off, for the app as it is without them. The runs move only when told to: see `exposeMockClock` above for `__gossamrMock.advanceRuns()`. */
export function mockOptionsFromUrl(): MockOptions {
  if (!import.meta.env.DEV || typeof location === "undefined") return {};
  const params = new URLSearchParams(location.search);
  const count = (name: string) => {
    const n = Number(params.get(name));
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const options: MockOptions = {};
  const projects = count("mockProjects");
  const repos = count("mockRepos");
  if (projects) options.catalogSize = projects;
  if (repos) options.githubRepos = repos;
  const pace = count("pipPace");
  if (pace) options.pipPace = pace;
  if (params.get("wsManage") === "1") options.wsManage = true;
  if (params.get("agents") === "off") options.agents = false;
  const outcome = params.get("mockDevice");
  if (outcome === "denied" || outcome === "expired" || outcome === "slow") options.device = { delayMs: 4000, outcome: outcome === "slow" ? "authorised" : outcome };
  const seed = params.get("runs");
  const environment = params.get("runsEnv");
  options.runs = {
    // The scripted ages count back from now, so the runs look recent whenever the page is opened.
    epoch: Date.now(),
    seed: seed === "empty" || seed === "many" || seed === "failures" || seed === "busy" || seed === "stuck" || seed === "reports" ? seed : "kinds",
    environment: environment === "missing" || environment === "signedOut" ? environment : "ok",
    cap: count("runsCap"),
    pipRun: params.get("pipRun") === "1",
    planDescription: true,
    untrusted: params.get("runsUntrusted") === "1",
    prSurfaceMs: params.get("prSurface") === "manual" ? null : undefined,
  };
  return options;
}
