import type { CatalogPage, ConnectionInfo, ContainerRef, ContainerSummary, DeviceStart, Footprint, GithubSignInOptions, WatchChange, WatchChanged, WatchMode, WatchState } from "../types";
import { MockCode } from "./mockCode";
import { MockWatch } from "./mockWatch";

export const GITHUB_LOGIN = "ada";
export const GITHUB_CONNECTION = `github:${GITHUB_LOGIN}`;
const CATALOG_PAGE = 50;
/** The sample repositories; any further ones are quiet. */
const SAMPLE: { name: string; permission: string; archived: boolean; pushedHoursAgo: number; mine: number }[] = [
  { name: "webshop", permission: "push", archived: false, pushedHoursAgo: 3, mine: 2 },
  { name: "gateway", permission: "admin", archived: false, pushedHoursAgo: 30, mine: 1 },
  { name: "infra", permission: "push", archived: false, pushedHoursAgo: 75, mine: 1 },
  { name: "mobile-app", permission: "pull", archived: false, pushedHoursAgo: 200, mine: 0 },
  { name: "legacy-admin", permission: "pull", archived: true, pushedHoursAgo: 9000, mine: 0 },
];

export function repoSummary(connectionId: string, index: number, now: number): ContainerSummary {
  const sample = SAMPLE[index];
  const name = sample?.name ?? `repo-${index + 1}`;
  const full = `acme/${name}`;
  return {
    ref: { connectionId, externalId: full },
    key: full,
    name,
    kind: sample?.permission ?? "pull",
    archived: sample?.archived ?? false,
    lastActive: new Date(now - (sample?.pushedHoursAgo ?? 400 + index * 10) * 3_600_000).toISOString(),
    itemHint: null,
  };
}

/**
 * A believable GitHub connection for the mock: repositories to choose from, watched the way the backend watches them
 * (above 12 the choice starts unset), and the sign-in entry points, which accept any non-empty token except "bad".
 */
export class MockGithub {
  private watch: MockWatch | null = null;
  private repos: ContainerSummary[] = [];
  private listeners = new Set<(c: WatchChanged) => void>();
  private pendingDevice = false;
  /** The sample pull requests, branches and commits, tied to the sample tickets. Empty reads until connected. */
  readonly code: MockCode;

  constructor(
    private readonly repoCount: number,
    private readonly now = Date.now(),
    connected = false,
  ) {
    this.code = new MockCode(GITHUB_CONNECTION, now, GITHUB_LOGIN, (repo) => this.isWatched(repo));
    if (connected) this.connect();
  }

  get connected() {
    return this.watch !== null;
  }

  private connect() {
    const size = Math.max(this.repoCount, SAMPLE.length);
    this.repos = Array.from({ length: size }, (_, i) => repoSummary(GITHUB_CONNECTION, i, this.now));
    this.watch = new MockWatch(GITHUB_CONNECTION, size);
    this.listeners.forEach((l) => l({ connectionId: GITHUB_CONNECTION }));
  }

  signInOptions(): GithubSignInOptions {
    return { deviceFlow: true, ghCli: true, token: true };
  }

  connectToken(token: string): ConnectionInfo {
    if (!token.trim()) throw new Error("paste a GitHub token first");
    if (token.trim() === "bad") throw new Error("GitHub didn't accept the token. It may have expired or been revoked; connect again.");
    if (!this.connected) this.connect();
    return this.info();
  }

  importGhToken(): ConnectionInfo {
    if (!this.connected) this.connect();
    return this.info();
  }

  deviceStart(): DeviceStart {
    this.pendingDevice = true;
    return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };
  }

  devicePoll(): ConnectionInfo {
    if (!this.pendingDevice) throw new Error("start signing in first");
    this.pendingDevice = false;
    if (!this.connected) this.connect();
    return this.info();
  }

  disconnect(connectionId: string) {
    if (connectionId !== GITHUB_CONNECTION) return;
    this.watch = null;
    this.repos = [];
    this.listeners.forEach((l) => l({ connectionId }));
  }

  info(): ConnectionInfo {
    return { id: GITHUB_CONNECTION, kind: "github", workspace: GITHUB_LOGIN, url: `https://github.com/${GITHUB_LOGIN}`, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false };
  }

  watchState(): WatchState | null {
    return this.watch?.state((id) => ({ key: id, name: id.split("/")[1] ?? id, cachedItems: 0 })) ?? null;
  }

  setWatchMode(mode: WatchMode) {
    this.requireWatch().setMode(mode);
    this.listeners.forEach((l) => l({ connectionId: GITHUB_CONNECTION }));
  }

  setWatched(changes: WatchChange[]) {
    this.requireWatch().apply(changes);
    this.listeners.forEach((l) => l({ connectionId: GITHUB_CONNECTION }));
  }

  private requireWatch() {
    if (!this.watch) throw new Error("Not signed in to GitHub");
    return this.watch;
  }

  /** What the backend's `runs_repos` returns: the chosen repositories, or the whole catalog when it is small, minus archived ones in a whole-catalog watch. */
  watchedRepos(): string[] {
    const state = this.watchState();
    if (!state || state.mode === "unset") return [];
    const names = state.mode === "selected" ? state.watches.filter((w) => !w.unwatchedAt && !w.inaccessible).map((w) => w.container.externalId) : this.repos.filter((r) => !r.archived).map((r) => r.key);
    return names.sort((a, b) => a.localeCompare(b));
  }

  isWatched(repo: string) {
    return this.watch?.isWatched(repo) ?? false;
  }

  /** The catalog, matching on name, fifty at a time, most recently pushed first. */
  catalogPage(query: string, cursor: string | null): CatalogPage {
    const watch = this.requireWatch();
    const q = query.trim().toLowerCase();
    const matches = this.repos.filter((r) => !q || r.key.toLowerCase().includes(q)).sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
    const start = cursor ? Number(cursor) : 0;
    return {
      containers: matches.slice(start, start + CATALOG_PAGE).map((r) => ({ ...r, watched: watch.isWatched(r.ref.externalId) })),
      next: start + CATALOG_PAGE < matches.length ? String(start + CATALOG_PAGE) : null,
      offline: false,
    };
  }

  /** Repositories the person has pull requests in or pushed to lately. */
  footprint(): Footprint[] {
    this.requireWatch();
    return SAMPLE.map((s, i) => ({ s, r: this.repos[i] }))
      .filter(({ s, r }) => s.mine > 0 && r)
      .map(({ s, r }) => ({
        container: r.ref as ContainerRef,
        key: r.key,
        name: r.name,
        assigned: s.mine > 1 ? 1 : 0,
        reported: s.mine,
        watching: 0,
        commented: 0,
        mentioned: 0,
        lastTouch: r.lastActive,
      }));
  }

  onWatchChanged(listener: (c: WatchChanged) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
