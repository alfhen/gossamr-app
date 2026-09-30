import type {
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

const hoursAgo = (now: number, h: number) => new Date(now - h * 3_600_000).toISOString();

/** The sample code behind the GitHub mock: changes tied to sample tickets, with the reads Pip's tools will make. */
export class MockCode {
  private listeners = new Set<(c: DevLinksChanged) => void>();
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
