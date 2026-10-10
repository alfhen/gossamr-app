import type {
  CatalogPage,
  ConnectionInfo,
  ContainerRef,
  ContainerSummary,
  DeviceStart,
  Footprint,
  GithubSignInOptions,
  Intent,
  PostedReview,
  ReviewAccess,
  ReviewComment,
  WatchChange,
  WatchChanged,
  WatchMode,
  WatchState,
} from "../types";
import { MockCode } from "./mockCode";
import { MockWatch } from "./mockWatch";

export const GITHUB_LOGIN = "ada";
export const GITHUB_CONNECTION = `github:${GITHUB_LOGIN}`;
const CATALOG_PAGE = 50;
/** The sample repositories; any further ones are quiet. */
const SAMPLE: { name: string; permission: string; archived: boolean; pushedHoursAgo: number; mine: number }[] = [
  { name: "webshop", permission: "push", archived: false, pushedHoursAgo: 3, mine: 2 },
  { name: "gateway", permission: "admin", archived: false, pushedHoursAgo: 30, mine: 1 },
  // Where the sample agents work: their builds open draft pull requests here, and reviews read them.
  { name: "storefront", permission: "push", archived: false, pushedHoursAgo: 5, mine: 1 },
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

/** One review the sample GitHub was sent, the only kind of write it takes. */
export interface GithubWrite {
  proposalId: string;
  repo: string;
  number: number;
  event: "COMMENT";
  commitId: string;
  body: string;
  comments: ReviewComment[];
}

/** GitHub's 422 for a review whose lines no longer match the pull request, as `Error::ReviewOutdated`. */
export class ReviewOutdatedError extends Error {}

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
  /** Every review posted, oldest first: the only writes the sample GitHub takes, each from a draft the person approved. */
  readonly writes: GithubWrite[] = [];
  private nextReview = 9001;
  /** Repositories (lowercased) where a post was refused with a 403, which then outranks the token's permissions. */
  private refused = new Set<string>();

  constructor(
    private readonly repoCount: number,
    private readonly now = Date.now(),
    connected = false,
    /** "none" is a token that can't write to any pull request (`?mockReviewAccess=none`). */
    private readonly reviewWrites: "sample" | "none" = "sample",
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

  /** Whether the token may post a review on `repo`: not with `reviewWrites` "none", nor on a repository it can only read, nor after a refused post. As `review_access` in `codehost/github/mod.rs`. */
  reviewAccess(repo: string): ReviewAccess {
    const sample = this.repos.find((r) => r.key.toLowerCase() === repo.toLowerCase());
    const reason = (why: string) => ({ canPost: false, reason: `This GitHub token can't post reviews on ${repo} (${why}).` });
    if (this.refused.has(repo.toLowerCase())) return { canPost: false, reason: `GitHub refused to post the review: the token can't write to pull requests in ${repo}. Open the PR view instead, or reconnect GitHub with write access.` };
    if (this.reviewWrites === "none") return reason("it lacks write access to its pull requests");
    if (!sample || sample.kind === "pull") return reason("it lacks write access to its pull requests");
    return { canPost: true, reason: null };
  }

  /**
   * Posts a review draft's comment review, as `post_review` in `codehost/github/write.rs`: refused with GitHub's 403
   * without write access, its 404 for an unknown pull request, and its 422 (`ReviewOutdatedError`) once a force-push took
   * the reviewed commit out of the pull request. Anything else is appended to `writes`, once.
   */
  postReview(proposalId: string, intent: Extract<Intent, { type: "githubReview" }>): PostedReview {
    const { repo, number } = intent;
    if (this.reviewWrites === "none" || !this.reviewAccess(repo).canPost) {
      this.refused.add(repo.toLowerCase());
      throw new Error(`GitHub refused to post the review: the token can't write to pull requests in ${repo}. Open the PR view instead, or reconnect GitHub with write access.`);
    }
    const head = this.code.headSha(repo, number);
    if (!head) throw new Error(`GitHub couldn't find pull request #${number} in ${repo}, or the token can't see it.`);
    // GitHub reads the lines against the diff at the review's own commit, so a head that merely moved on takes it (its
    // comments show as outdated there); a commit a force-push dropped is refused.
    if (!this.code.hasCommit(repo, number, intent.commitSha)) throw new ReviewOutdatedError("GitHub couldn't place this review on the pull request as it is now (commit_id is not part of the pull request).");
    this.writes.push({ proposalId, repo, number, event: "COMMENT", commitId: intent.commitSha, body: intent.summary, comments: intent.comments.map((c) => ({ ...c })) });
    const id = this.nextReview++;
    return { id, url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${id}`, at: new Date().toISOString() };
  }

  onWatchChanged(listener: (c: WatchChanged) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
}
