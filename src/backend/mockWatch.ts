import { AUTO_WATCH_EVERYTHING_MAX, type ContainerRef, type WatchChange, type WatchMode, type WatchRow, type WatchState } from "../types";

export interface MockOptions {
  /** How many projects the catalog lists, at least the four that hold sample items. Above 12 the choice of what to watch starts unset. */
  catalogSize?: number;
  /** When set, a GitHub connection is already signed in with this many repositories (at least the five sample ones). Without it the sign-in commands connect one with 14. */
  githubRepos?: number;
  /** How the device flow ends once the sample waits for it: authorised after `delayMs`, or refused or expired. */
  device?: { delayMs: number; outcome: "authorised" | "denied" | "expired" };
  /** Which scripted agent runs exist, and the moment their ages count back from. */
  runs?: { seed?: "busy" | "kinds" | "empty" | "many" | "failures"; epoch?: number; environment?: "ok" | "missing" | "signedOut"; cap?: number; pipRun?: boolean; planDescription?: boolean; untrusted?: boolean };
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

/** In a dev browser, `?mockProjects=60` sets how many projects the sample catalog lists, and `?mockRepos=30` signs in a GitHub connection with that many repositories, and `?mockDevice=denied`, `expired` or `slow` makes the GitHub device flow wait 4 seconds and end that way. `?runs=busy` (without the other kinds), `empty`, `many` or `failures` changes the scripted agent runs, `?runsEnv=missing` or `signedOut` shows the Claude banners, `?runsCap=3` sets how many agents may run at once `?pipRun=1` starts with a run draft from Pip and `?runsUntrusted=1` makes Claude refuse every clone until Trust this folder is used. */
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
  const outcome = params.get("mockDevice");
  if (outcome === "denied" || outcome === "expired" || outcome === "slow") options.device = { delayMs: 4000, outcome: outcome === "slow" ? "authorised" : outcome };
  const seed = params.get("runs");
  const environment = params.get("runsEnv");
  options.runs = {
    // The scripted ages count back from now, so the runs look recent whenever the page is opened.
    epoch: Date.now(),
    seed: seed === "empty" || seed === "many" || seed === "failures" || seed === "busy" ? seed : "kinds",
    environment: environment === "missing" || environment === "signedOut" ? environment : "ok",
    cap: count("runsCap"),
    pipRun: params.get("pipRun") === "1",
    planDescription: true,
    untrusted: params.get("runsUntrusted") === "1",
  };
  return options;
}
