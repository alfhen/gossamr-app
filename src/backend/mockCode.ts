import type {
  ChangedFile,
  CodeChange,
  CodeCommitQuery,
  CodeFile,
  CodeHit,
  CodeRef,
  DevLink,
  DevLinksChanged,
  ItemRef,
  LinkSource,
  PersonRef,
  PullRequestDetail,
  TreeEntry,
  WorkEvent,
} from "../types";

const CONFIDENCE: Record<LinkSource, number> = { branch: 0.95, title: 0.9, commit: 0.85, body: 0.6 };
const ROUTES_TS = "import { route } from './router';\n\nexport const checkout = route('/checkout', async (req) => {\n  return gateway.forward(req);\n});\n";
const FILES: Record<string, string> = {
  "README.md": "# webshop\n\nThe storefront. Checkout goes through the gateway.\n",
  "src/gateway/routes.ts": ROUTES_TS,
  "src/cart/round.ts": "export const round = (n: number) => Math.round(n * 100) / 100;\n",
};

/** What sample pull request #218 changes in its consumer: its new side shows lines 14–21 and 38–45 of retry.ts. */
const RETRY_PATCH = [
  '@@ -14,6 +14,8 @@ import { Message } from "./message";',
  ' import { Queue } from "./queue";',
  ' import { handle } from "./handle";',
  " ",
  "+const MAX = 5;",
  "+",
  " export async function consume(queue: Queue) {",
  "   const batch = await queue.take();",
  "   for (const message of batch) {",
  "@@ -36,5 +38,8 @@ export async function consume(queue: Queue) {",
  " export async function retry(message: Message) {",
  "   let attempt = 0;",
  "-  await handle(message);",
  "+  while (attempt < MAX) {",
  "+    attempt += 1;",
  "+    try { return await handle(message); } catch { continue; }",
  "+  }",
  '   throw new Error("gave up");',
  " }",
  "\\ No newline at end of file",
].join("\n");
const INDEX_PATCH = ['@@ -1,3 +1,3 @@', '-export { consume } from "./consume";', '+export { consume, retry } from "./retry";', ' export type { Message } from "./message";', ' export type { Queue } from "./queue";'].join("\n");
/** What #218's consumer change becomes once its head moves (`movePullHead`): only the top of retry.ts changes, so the old comments' lines are gone. */
const MOVED_PATCH = ['@@ -1,3 +1,4 @@', ' import { Queue } from "./queue";', '+import { backoff } from "./backoff";', ' import { handle } from "./handle";', " "].join("\n");
/** The files of the sample pull requests a review draft reads, by `repo#number`. */
const PULL_FILES: Record<string, ChangedFile[]> = {
  "acme/webshop#218": [
    { path: "src/consumer/retry.ts", status: "modified", additions: 6, deletions: 1, patch: RETRY_PATCH, truncated: false },
    { path: "src/consumer/index.ts", status: "modified", additions: 1, deletions: 1, patch: INDEX_PATCH, truncated: false },
  ],
};

/** Where the other sample pull requests' changes are, by `repo#number`; their stats say how much each file changes. */
const SAMPLE_PATHS: Record<string, string[]> = {
  "acme/webshop#208": ["src/gateway/routes.ts", "src/gateway/client.ts", "src/checkout/submit.ts", "docs/rollout.md"],
  "acme/gateway#14": ["src/retry.rs", "src/upstream.rs", "tests/retry.rs"],
  "acme/webshop#212": ["src/catalog/tree.ts", "src/catalog/cache.ts"],
  "acme/webshop#215": ["docs/size-guide.md"],
  "acme/webshop#190": ["src/banner/Banner.tsx", "src/banner/index.ts"],
};

/** `total` shared out over `n` parts, the first ones taking what doesn't divide. */
const shares = (total: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

/** Sample files for a pull request with no hand-written ones, whose additions, deletions and count are its stats'. */
function sampleFiles(change: CodeChange): ChangedFile[] {
  const key = `${change.repo.toLowerCase()}#${change.number}`;
  const n = Math.max(1, change.changedFiles ?? 1);
  const paths = Array.from({ length: n }, (_, i) => SAMPLE_PATHS[key]?.[i] ?? `src/change-${i + 1}.ts`);
  const [adds, dels] = [shares(change.additions ?? 1, n), shares(change.deletions ?? 0, n)];
  return paths.map((path, i) => {
    const lines = [...Array.from({ length: dels[i] }, (_, j) => `-old line ${j + 1}`), ...Array.from({ length: adds[i] }, (_, j) => `+new line ${j + 1}`)];
    const patch = `@@ -1,${dels[i] + 1} +1,${adds[i] + 1} @@\n ${path.endsWith(".md") ? "#" : "//"} ${path}\n${lines.join("\n")}`;
    return { path, status: dels[i] && !adds[i] ? "removed" : "modified", additions: adds[i], deletions: dels[i], patch, truncated: false };
  });
}

const hoursAgo = (now: number, h: number) => new Date(now - h * 3_600_000).toISOString();

/** The sample code behind the GitHub mock: changes tied to sample tickets, with the reads Pip's tools will make. */
export class MockCode {
  private listeners = new Set<(c: DevLinksChanged) => void>();
  /** Pull requests whose head moved since the sample began (`movePullHead`), by `repo#number`, with their files now. */
  private moved = new Map<string, ChangedFile[]>();
  /** Commits a force-push took out of their pull request, as `repo#number@sha`. */
  private dropped = new Set<string>();
  /** Pull requests an agent's build opened (`addPullRequest`), by `repo#number`: they change the same consumer #218 does, and are read only in a watched repository, as any other. */
  private byAgents = new Set<string>();
  private discovered = false;
  readonly changes: CodeChange[];
  /** `[ticket key, change external id, provenance]`. */
  private readonly links: [string, string, LinkSource][];

  constructor(
    private readonly connectionId: string,
    private readonly now: number,
    me: string,
    private readonly watched: (repo: string) => boolean,
  ) {
    const who = (login: string): PersonRef => ({ connectionId, accountId: login });
    const base = {
      connectionId,
      baseRef: "main" as string | null,
      mergedAt: null as string | null,
      reviewers: [] as PersonRef[],
      checks: "none" as CodeChange["checks"],
      review: "none" as CodeChange["review"],
      additions: null as number | null,
      deletions: null as number | null,
      changedFiles: null as number | null,
      body: "",
      linkedKeys: [] as string[],
      number: null as number | null,
      sha: null as string | null,
      createdAt: null as string | null,
    };
    const pr = (repo: string, n: number, o: Partial<CodeChange>): CodeChange => ({
      ...base,
      externalId: `pr:${repo}#${n}`,
      kind: "pullRequest",
      repo,
      number: n,
      url: `https://github.com/${repo}/pull/${n}`,
      headRepo: repo,
      sha: `sha${n}0000`,
      state: "open",
      title: "",
      headRef: "",
      updatedAt: hoursAgo(now, 2),
      author: who(me),
      ...o,
    });
    this.changes = [
      pr("acme/webshop", 208, {
        title: "CA-208: Route checkout through the gateway",
        headRef: "ca-208-gateway",
        state: "draft",
        checks: "failing",
        review: "changesRequested",
        reviewers: [who("bob")],
        additions: 120,
        deletions: 14,
        changedFiles: 4,
        body: "Moves the checkout calls. See DEVOPS-471 for the rollout.",
        linkedKeys: ["CA-208", "DEVOPS-471"],
        createdAt: hoursAgo(now, 120),
        updatedAt: hoursAgo(now, 3),
      }),
      pr("acme/gateway", 14, {
        title: "Gateway: retry upstream timeouts",
        headRef: "devops-471-retries",
        state: "merged",
        checks: "passing",
        review: "approved",
        author: who("priya"),
        mergedAt: hoursAgo(now, 30),
        updatedAt: hoursAgo(now, 30),
        additions: 60,
        deletions: 8,
        changedFiles: 3,
        linkedKeys: ["DEVOPS-471"],
        createdAt: hoursAgo(now, 200),
      }),
      pr("acme/webshop", 212, {
        title: "CA-402: Cache the category tree",
        headRef: "feature/CA-402_category-cache",
        checks: "passing",
        review: "approved",
        reviewers: [who("bob")],
        additions: 44,
        deletions: 3,
        changedFiles: 2,
        linkedKeys: ["CA-402"],
        createdAt: hoursAgo(now, 50),
      }),
      pr("acme/webshop", 218, {
        title: "CA-402: Cache the category tree (agent)",
        headRef: "worktree-ca-402-category-cache-e1f2",
        state: "draft",
        sha: "a1b2c3d4e5f6",
        checks: "passing",
        // What its files below come to.
        additions: 7,
        deletions: 2,
        changedFiles: 2,
        linkedKeys: ["CA-402"],
        updatedAt: hoursAgo(now, 1),
      }),
      pr("acme/webshop", 215, {
        title: "Fix the size-guide typo",
        headRef: "patch-1",
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        headRepo: "dana-lee/webshop",
        author: who("dana-lee"),
        updatedAt: hoursAgo(now, 8),
      }),
      pr("acme/webshop", 190, {
        title: "Drop the unused banner component",
        headRef: "chore/drop-banner",
        additions: 0,
        deletions: 40,
        changedFiles: 2,
        state: "closed",
        updatedAt: hoursAgo(now, 90),
      }),
      {
        ...base,
        externalId: "branch:acme/webshop:feature/CA-209_cache-warmup",
        kind: "branch",
        repo: "acme/webshop",
        title: "feature/CA-209_cache-warmup",
        headRef: "feature/CA-209_cache-warmup",
        state: "open",
        url: "https://github.com/acme/webshop/tree/feature/CA-209_cache-warmup",
        sha: "ccc3333",
        updatedAt: hoursAgo(now, 20),
        author: who(me),
        linkedKeys: ["CA-209"],
      },
      {
        ...base,
        externalId: "commit:acme/webshop@9999999ccccccc",
        kind: "commit",
        repo: "acme/webshop",
        title: "CA-208 hotfix for gateway timeout",
        headRef: "",
        state: "merged",
        url: "https://github.com/acme/webshop/commit/9999999ccccccc",
        sha: "9999999ccccccc",
        updatedAt: hoursAgo(now, 40),
        author: who("bob"),
        linkedKeys: ["CA-208"],
      },
    ];
    this.links = [
      ["CA-208", "pr:acme/webshop#208", "branch"],
      ["DEVOPS-471", "pr:acme/webshop#208", "body"],
      ["DEVOPS-471", "pr:acme/gateway#14", "branch"],
      ["CA-402", "pr:acme/webshop#212", "branch"],
      // The agent's draft pull request, whose worktree branch names the ticket.
      ["CA-402", "pr:acme/webshop#218", "branch"],
      ["CA-208", "commit:acme/webshop@9999999ccccccc", "commit"],
      ["CA-209", "branch:acme/webshop:feature/CA-209_cache-warmup", "branch"],
    ];
  }

  private refused(repo: string): Error {
    return new Error(`${repo} isn't one of the repositories you watch, so it isn't read.`);
  }

  private require(repo: string) {
    if (!this.watched(repo)) throw this.refused(repo);
  }

  private linksFor(key: string, includeUndiscovered: boolean): DevLink[] {
    return this.links
      .filter(([k, id]) => k === key && (includeUndiscovered || this.isCached(id)))
      .map(([k, id, provenance]) => ({ item: { connectionId: "mock", externalId: k, key: k } as ItemRef, change: this.changes.find((c) => c.externalId === id)!, provenance, confidence: CONFIDENCE[provenance] }))
      .filter((l) => this.watched(l.change.repo))
      .sort((a, b) => b.confidence - a.confidence || b.change.updatedAt.localeCompare(a.change.updatedAt));
  }

  /** A branch with no pull request is only found by the live search, the way a sync doesn't list branches. */
  private isCached(id: string) {
    return this.discovered || !id.startsWith("branch:");
  }

  devLinks(item: ItemRef): DevLink[] {
    return this.linksFor(item.key, false);
  }

  devLinksLive(item: ItemRef): DevLink[] {
    const before = this.linksFor(item.key, false).length;
    const found = this.linksFor(item.key, true);
    if (!this.discovered && found.length > before) {
      this.discovered = true;
      this.listeners.forEach((l) => l({ connectionId: this.connectionId }));
    }
    return found;
  }

  onDevLinksChanged(listener: (c: DevLinksChanged) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** A draft pull request an agent's build opened, as a sync finds it: linked to the tickets it names by its branch. */
  addPullRequest(change: CodeChange) {
    // One already shown moved on, to a new head commit: a sync finds it as it is now.
    const at = this.changes.findIndex((c) => c.externalId === change.externalId);
    if (at >= 0) {
      this.changes[at] = { ...change, connectionId: this.connectionId };
      this.listeners.forEach((l) => l({ connectionId: this.connectionId }));
      return;
    }
    this.changes.push({ ...change, connectionId: this.connectionId });
    if (change.number != null) this.byAgents.add(`${change.repo.toLowerCase()}#${change.number}`);
    for (const key of change.linkedKeys) this.links.push([key, change.externalId, "branch"]);
    this.listeners.forEach((l) => l({ connectionId: this.connectionId }));
  }

  /** The pull request as GitHub has it now; null when there is none or the repository isn't watched. */
  change(repo: string, number: number): CodeChange | null {
    return this.watched(repo) ? (this.changes.find((c) => c.kind === "pullRequest" && c.repo === repo && c.number === number) ?? null) : null;
  }

  pullRequest(ref: CodeRef): PullRequestDetail {
    this.require(ref.repo);
    const change = this.changes.find((c) => c.kind === "pullRequest" && c.repo === ref.repo && c.number === ref.number);
    if (!change) throw new Error("GitHub couldn't find that, or the token can't see it.");
    return {
      change,
      files: [
        { path: "src/gateway/routes.ts", status: "modified", additions: 80, deletions: 10, patch: "@@ -1,3 +1,4 @@\n-old\n+new" },
        { path: "docs/logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      ],
      filesTruncated: (change.changedFiles ?? 0) > 2,
      commits: [{ sha: "c0ffee1234567", message: `${change.title}\n\nfirst step`, author: change.author?.accountId ?? null, at: hoursAgo(this.now, 100), url: `${change.url}/commits/c0ffee1234567` }],
      reviews: change.review === "none" ? [] : [{ id: "501", reviewer: { connectionId: this.connectionId, accountId: "bob" }, state: change.review === "approved" ? "approved" : "changesRequested", at: hoursAgo(this.now, 10) }],
    };
  }

  /** The files a pull request changes with their whole patches, as a review draft reads them; null when they can't be read. */
  pullFiles(repo: string, number: number): ChangedFile[] | null {
    if (!this.watched(repo)) return null;
    const key = `${repo.toLowerCase()}#${number}`;
    const change = this.change(repo, number);
    if (!change) return null;
    return (this.moved.get(key) ?? PULL_FILES[key] ?? (this.byAgents.has(key) ? PULL_FILES["acme/webshop#218"] : sampleFiles(change))).map((f) => ({ ...f }));
  }

  /** The commit pull request `number` of `repo` is at now, or null when there is no such pull request. */
  headSha(repo: string, number: number): string | null {
    return this.changes.find((c) => c.kind === "pullRequest" && c.repo.toLowerCase() === repo.toLowerCase() && c.number === number)?.sha ?? null;
  }

  /**
   * Someone force-pushed pull request `number`: its head is a new commit, the one it was at is no longer part of it, and
   * its diff no longer shows the lines it did. False when there is no such pull request.
   */
  movePullHead(repo: string, number: number): boolean {
    const change = this.changes.find((c) => c.kind === "pullRequest" && c.repo.toLowerCase() === repo.toLowerCase() && c.number === number);
    if (!change) return false;
    const key = `${repo.toLowerCase()}#${number}`;
    if (change.sha) this.dropped.add(`${key}@${change.sha}`);
    change.sha = `moved${(change.sha ?? "").slice(0, 7)}`;
    change.updatedAt = new Date().toISOString();
    const files = PULL_FILES[key] ?? [];
    this.moved.set(key, files.map((f) => (f.path === "src/consumer/retry.ts" ? { ...f, additions: 1, deletions: 0, patch: MOVED_PATCH } : { ...f })));
    return true;
  }

  /** Whether commit `sha` is still part of pull request `number`: a force-push (`movePullHead`) drops the one it replaced. */
  hasCommit(repo: string, number: number, sha: string): boolean {
    return !this.dropped.has(`${repo.toLowerCase()}#${number}@${sha}`);
  }

  /** Matches words of the query in titles, bodies and branch names; a work item key must appear whole. */
  search(query: string): CodeChange[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const key = /^[a-z][a-z0-9_]+-\d+$/.test(q);
    const named = (text: string) => (key ? new RegExp(`(^|[^a-z0-9])${q}($|[^a-z0-9])`).test(text.toLowerCase()) : text.toLowerCase().includes(q));
    return this.changes
      .filter((c) => this.watched(c.repo) && [c.title, c.body, c.headRef].some(named))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  events(limit = 100): WorkEvent[] {
    const at = (h: number) => hoursAgo(this.now, h);
    const ev = (id: string, kind: WorkEvent["kind"], h: number, change: CodeChange, text: string): WorkEvent => ({
      id: `${change.externalId}:${id}`,
      connectionId: this.connectionId,
      at: at(h),
      kind,
      subject: { type: "codeChange", repo: change.repo, number: change.number ?? 0 },
      actor: change.author,
      payload: { text, repo: change.repo, number: change.number, title: change.title, url: change.url },
    });
    const [p208, merged, p212] = this.changes;
    return [
      ev("checks-failed:sha2080000", "checkFailed", 3, p208, `Checks failed on acme/webshop#208: ${p208.title}`),
      ev("review:501", "reviewSubmitted", 10, p208, `bob requested changes on acme/webshop#208: ${p208.title}`),
      ev("merged", "prMerged", 30, merged, `priya merged acme/gateway#14: ${merged.title}`),
      ev("review-requested", "reviewRequested", 48, p212, `ada asked you to review acme/webshop#212: ${p212.title}`),
      ev("opened", "prOpened", 120, p208, `ada opened acme/webshop#208: ${p208.title}`),
    ]
      .filter((e) => e.subject.type === "codeChange" && this.watched(e.subject.repo))
      .slice(0, limit);
  }

  file(repo: string, path: string, reference: string | null): CodeFile {
    this.require(repo);
    const text = FILES[path.replace(/^\/+|\/+$/g, "")];
    if (text === undefined) throw new Error("GitHub couldn't find that, or the token can't see it.");
    return { repo, path, reference: reference ?? "", text, size: text.length, truncated: false };
  }

  tree(repo: string, path: string): TreeEntry[] {
    this.require(repo);
    const dir = path.replace(/^\/+|\/+$/g, "");
    const prefix = dir ? `${dir}/` : "";
    const entries = new Map<string, TreeEntry>();
    for (const [full, text] of Object.entries(FILES)) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const [name, ...more] = rest.split("/");
      entries.set(name, more.length ? { name, path: `${prefix}${name}`, kind: "dir", size: 0 } : { name, path: full, kind: "file", size: text.length });
    }
    if (!entries.size) throw new Error("GitHub couldn't find that, or the token can't see it.");
    return [...entries.values()].sort((a, b) => Number(a.kind !== "dir") - Number(b.kind !== "dir") || a.name.localeCompare(b.name));
  }

  commits(repo: string, opts: CodeCommitQuery): CodeChange[] {
    this.require(repo);
    const text = opts.query?.toLowerCase();
    const since = opts.since ? Date.parse(opts.since) : 0;
    return this.changes
      .filter((c) => c.kind === "commit" && c.repo === repo && Date.parse(c.updatedAt) >= since && (!text || `${c.title}\n${c.body}`.toLowerCase().includes(text)))
      .slice(0, opts.limit || 30);
  }

  searchCode(query: string, repos?: string[]): CodeHit[] {
    for (const r of repos ?? []) this.require(r);
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scope = repos ?? ["acme/webshop"].filter((r) => this.watched(r));
    return scope.flatMap((repo) =>
      Object.entries(FILES)
        .filter(([, text]) => text.toLowerCase().includes(q))
        .map(([path, text]) => ({ repo, path, url: `https://github.com/${repo}/blob/main/${path}`, fragments: text.split("\n").filter((l) => l.toLowerCase().includes(q)) })),
    );
  }
}
