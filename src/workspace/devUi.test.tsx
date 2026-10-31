import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CodeChange, DevLink, GhAccounts } from "../types";
import { summarize } from "../lib/devLinks";
import { PrBadge } from "./DevBits";
import { ChangeRow, ConnectBanner, DevelopmentView, PullDetail, type DevelopmentViewProps } from "./DevelopmentSection";
import { ConnectGithubView, type ConnectGithubViewProps } from "./ConnectGithub";
import { PickerRow } from "./WatchPicker";
import { FindRow, SettingsRowView } from "./WatchSettings";
import { nounFor } from "./watchLogic";

const NOW = new Date("2026-09-30T12:00:00Z");
const change = (over: Partial<CodeChange> = {}): CodeChange => ({
  connectionId: "github:ada",
  externalId: "pr:acme/webshop#208",
  kind: "pullRequest",
  repo: "acme/webshop",
  number: 208,
  title: "CA-208: Route checkout through the gateway",
  headRef: "ca-208-gateway",
  baseRef: "main",
  state: "draft",
  mergedAt: null,
  createdAt: null,
  updatedAt: "2026-09-30T09:00:00Z",
  author: { connectionId: "github:ada", accountId: "ada" },
  reviewers: [],
  checks: "failing",
  review: "changesRequested",
  url: "https://github.com/acme/webshop/pull/208",
  sha: "abc1234",
  additions: 120,
  deletions: 14,
  changedFiles: 4,
  body: "",
  linkedKeys: ["CA-208"],
  ...over,
});
const link = (c: CodeChange, provenance: DevLink["provenance"] = "branch"): DevLink => ({ item: { connectionId: "mock", externalId: "CA-208", key: "CA-208" }, change: c, provenance, confidence: 0.95 });

const view = (over: Partial<DevelopmentViewProps> = {}) =>
  renderToStaticMarkup(
    <DevelopmentView itemKey="CA-208" links={[link(change())]} error={null} now={NOW} searching={false} watched="in acme/webshop" expanded={null} details={{}} onSearch={vi.fn()} onToggle={vi.fn()} onOpen={vi.fn()} onRetryDetail={vi.fn()} onRetry={vi.fn()} onManage={vi.fn()} {...over} />,
  );

describe("the PR badge", () => {
  const badge = (links: DevLink[]) => renderToStaticMarkup(<PrBadge summary={summarize(links)} />);

  it("carries the lead state, the count and a tooltip", () => {
    const out = badge([link(change({ state: "open", checks: "passing" })), link(change({ externalId: "pr:b#2", number: 2, state: "merged" }))]);
    expect(out).toContain('data-pr-state="open"');
    expect(out).toContain("2 pull requests: 1 open, 1 merged");
    expect(out).not.toContain("data-checks");
  });

  it("marks failing checks and shows merged and draft states", () => {
    expect(badge([link(change())])).toContain('data-checks="failing"');
    expect(badge([link(change({ state: "merged", checks: "failing" }))])).toContain('data-pr-state="merged"');
    expect(badge([link(change({ state: "merged", checks: "failing" }))])).not.toContain("data-checks");
  });

  it("shows a branch on its own and nothing for no code", () => {
    expect(badge([link(change({ kind: "branch", externalId: "branch:x", number: null }))])).toContain('data-pr-state="branch"');
    expect(renderToStaticMarkup(<PrBadge summary={summarize([])} />)).toBe("");
    expect(renderToStaticMarkup(<PrBadge summary={null} />)).toBe("");
  });
});

describe("the Development section", () => {
  it("shows state, repository and number, author, checks, review, size and time", () => {
    const out = view();
    for (const text of ["Draft", "acme/webshop#208", "ada", "Checks failing", "Changes requested", "+120", "−14", "4 files", "3h ago", "Linked because the ticket key is in the branch name"]) expect(out).toContain(text);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("Search GitHub for this ticket");
  });

  it("shows a branch without a pull request with a hint and no expander", () => {
    const out = view({ links: [link(change({ kind: "branch", externalId: "branch:acme/webshop:feature/CA-209", number: null, title: "feature/CA-209_cache-warmup", state: "open", checks: "none", review: "none", additions: null, deletions: null, changedFiles: null }))] });
    expect(out).toContain("Branch");
    expect(out).toContain("No pull request yet.");
    expect(out).not.toContain("aria-expanded");
  });

  it("tells which repositories are watched when nothing matches, and offers Settings", () => {
    const out = view({ links: [] });
    expect(out).toContain("Nothing in acme/webshop names CA-208");
    expect(out).toContain("Manage repositories");
  });

  it("shows loading, errors and the searching state", () => {
    expect(view({ links: null })).toContain("Loading");
    expect(view({ links: null, error: "GitHub says no" })).toContain("GitHub says no");
    expect(view({ searching: true })).toContain("Searching GitHub…");
  });

  it("wraps long branch names and titles instead of overflowing", () => {
    const long = "feature/CA-208_" + "very-long-branch-name-".repeat(6);
    const out = view({ links: [link(change({ title: long, headRef: long }))] });
    expect(out).toContain("[overflow-wrap:anywhere]");
    expect(out).toContain("min-w-0");
  });

  it("can be folded", () => {
    expect(view({ collapsed: true, onToggleSection: vi.fn() })).toContain('aria-expanded="false"');
    expect(renderToStaticMarkup(<ConnectBanner onConnect={vi.fn()} />)).toContain("Connect GitHub to see the PRs for this ticket");
  });

  it("expands a pull request into files, commits and reviewers with a way to open it", () => {
    const c = change();
    const out = renderToStaticMarkup(
      <PullDetail
        change={c}
        now={NOW}
        onOpen={vi.fn()}
        onRetry={vi.fn()}
        state={{
          status: "ready",
          detail: {
            change: { ...c, reviewers: [{ connectionId: "github:ada", accountId: "cy" }] },
            files: [{ path: "src/gateway/routes.ts", status: "modified", additions: 80, deletions: 10, patch: null }],
            filesTruncated: true,
            commits: [{ sha: "c0ffee1234567", message: "first\n\nbody", author: "ada", at: "2026-09-26T09:00:00Z", url: "" }],
            reviews: [{ id: "1", reviewer: { connectionId: "github:ada", accountId: "bob" }, state: "changesRequested", at: null }],
          },
        }}
      />,
    );
    for (const text of ["Files changed (1+)", "src/gateway/routes.ts", "+80", "c0ffee1", "first", "bob", "cy", "Review requested", "Open on GitHub", "More files changed than are listed"]) expect(out).toContain(text);
    expect(renderToStaticMarkup(<PullDetail change={c} now={NOW} onOpen={vi.fn()} onRetry={vi.fn()} state={{ status: "error", error: "no access" }} />)).toContain("no access");
    expect(renderToStaticMarkup(<ChangeRow link={link(c)} now={NOW} expanded detail={{ status: "loading" }} onToggle={vi.fn()} onOpen={vi.fn()} onRetry={vi.fn()} />)).toContain("Loading the files");
  });
});

describe("the connect GitHub sheet", () => {
  const found = (over: Partial<GhAccounts> = {}): GhAccounts => ({
    installed: true,
    accounts: [
      { login: "ada", active: true, usable: true },
      { login: "ada-work", active: false, usable: true },
    ],
    message: null,
    fix: null,
    ...over,
  });
  const props = (over: Partial<ConnectGithubViewProps> = {}): ConnectGithubViewProps => ({ found: found(), connected: [], connecting: null, error: null, copied: false, onConnect: vi.fn(), onCopy: vi.fn(), onOpenTerminal: vi.fn(), onCheck: vi.fn(), onClose: vi.fn(), ...over });
  const show = (over?: Partial<ConnectGithubViewProps>) => renderToStaticMarkup(<ConnectGithubView {...props(over)} />);

  it("lists the accounts gh knows, marks the active one, and offers another account with the login command", () => {
    const out = show();
    for (const text of ["Accounts gh knows", "ada-work", "Active in gh", 'aria-label="Connect ada"', 'aria-label="Connect ada-work"', "Another account", "gh auth login -h github.com", "Copy", "Open Terminal"]) expect(out).toContain(text);
  });

  it("has no token, CLI import or browser code step", () => {
    const out = show();
    for (const text of ["personal access token", "Use my GitHub CLI login", "Sign in with your browser"]) expect(out).not.toContain(text);
    expect(out).not.toContain('type="password"');
  });

  it("shows an account that is already connected as Connected, with no button", () => {
    const out = show({ connected: ["ada"] });
    expect(out).toContain("Connected");
    expect(out).not.toContain('aria-label="Connect ada"');
    expect(out).toContain('aria-label="Connect ada-work"');
  });

  it("disables an account gh can't use and says to sign in again", () => {
    const out = show({ found: found({ accounts: [{ login: "old", active: false, usable: false }] }) });
    expect(out).toContain("gh can&#x27;t use its token");
    expect(out).toMatch(/<button[^>]*aria-label="Connect old"[^>]*disabled/);
  });

  it("says Connecting on the account being connected and keeps Done from closing mid-way", () => {
    const out = show({ connecting: "ada" });
    expect(out).toContain("Connecting…");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Done/);
  });

  it("shows what gh says and the command that fixes it when it has no login or isn't installed", () => {
    const none = show({ found: found({ accounts: [], message: "gh has no login on github.com.", fix: "gh auth login -h github.com" }) });
    for (const text of ["gh has no login on github.com.", "gh auth login -h github.com", "Open Terminal", "I&#x27;ve run it, check again"]) expect(none).toContain(text);
    expect(none).not.toContain("Another account");
    const missing = show({ found: found({ installed: false, accounts: [], message: "gh isn't installed.", fix: "brew install gh" }) });
    expect(missing).toContain("brew install gh");
    expect(missing).not.toContain("Open Terminal");
  });

  it("says it is asking gh while the answer is on its way, and shows an error with its address openable", () => {
    expect(show({ found: null })).toContain("Asking gh…");
    const out = show({ error: "authorise at https://github.com/orgs/acme/sso?x=1" });
    expect(out).toContain('role="alert"');
    expect(out).toContain("<button");
    expect(out).toContain("https://github.com/orgs/acme/sso?x=1");
  });
});

describe("repositories in the pickers and settings", () => {
  const code = nounFor("github");

  it("lists owner and name, permission, archived state and last push", () => {
    const out = renderToStaticMarkup(<PickerRow k="acme/legacy-admin" name="legacy-admin" checked={false} itemHint={null} repo={{ permission: "pull", archived: true, lastActive: "2026-09-27T12:00:00Z" }} now={NOW} onToggle={vi.fn()} />);
    for (const text of ["acme/", "legacy-admin", "Read", "archived", "pushed 3d ago", "opacity-60"]) expect(out).toContain(text);
  });

  it("shows a permission on the repositories still to add, and no depth or pin on watched ones", () => {
    const entry = { ref: { connectionId: "github:ada", externalId: "acme/infra" }, key: "acme/infra", name: "infra", kind: "admin", archived: false, lastActive: "2026-09-30T09:00:00Z", itemHint: null, watched: false };
    const find = renderToStaticMarkup(<FindRow entry={entry} code now={NOW} onWatch={vi.fn()} />);
    expect(find).toContain("Admin");
    expect(find).toContain("pushed 3h ago");
    const row = renderToStaticMarkup(
      <SettingsRowView row={{ container: entry.ref, key: "acme/infra", name: "infra", pinned: false, inaccessible: false, cachedItems: 3 }} noun={code} pinOnly={false} onPin={vi.fn()} onUnwatch={vi.fn()} />,
    );
    expect(row).toContain("3 changes synced");
    expect(row).toContain("Unwatch");
    expect(row).not.toContain("Pin ");
    expect(row).not.toContain("Involved");
  });
});
