import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CodeChange, DevLink } from "../types";
import { summarize } from "../lib/devLinks";
import { PrBadge } from "./DevBits";
import { ChangeRow, ConnectBanner, DevelopmentView, PullDetail, type DevelopmentViewProps } from "./DevelopmentSection";
import { ConnectView, type ConnectViewProps } from "./ConnectGithub";
import { connectReducer, START } from "./connectFlow";
import { GithubCardView } from "./Settings";
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
    expect(out).toContain("No pull request yet. Open one on GitHub");
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

describe("the connect dialog", () => {
  const props = (over: Partial<ConnectViewProps> = {}): ConnectViewProps => ({ state: START, options: { token: true, ghCli: true, deviceFlow: true }, token: "", now: 0, copied: false, onToken: vi.fn(), onPick: vi.fn(), onSubmit: vi.fn(), onBack: vi.fn(), onRetry: vi.fn(), onCopy: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onManage: vi.fn(), ...over });
  const show = (over?: Partial<ConnectViewProps>) => renderToStaticMarkup(<ConnectView {...props(over)} />);

  it("offers the methods that work and hides the others", () => {
    const all = show();
    expect(all).toContain("Paste a personal access token");
    expect(all).toContain("Use my GitHub CLI login");
    expect(all).toContain("Sign in with your browser");
    const token = show({ options: { token: true, ghCli: false, deviceFlow: false } });
    expect(token).not.toContain("GitHub CLI");
    expect(token).not.toContain("browser");
    expect(show({ options: null })).toContain("Checking what is available");
  });

  it("explains the token types and scopes, and hides the token", () => {
    const out = show({ state: connectReducer(START, { type: "pick", method: "token" }), token: "ghp_secret" });
    for (const text of ["read:org", "notifications", "Contents, Pull requests and Metadata", "Create a classic token", 'type="password"']) expect(out).toContain(text);
  });

  it("explains the CLI import and shows errors inline", () => {
    let state = connectReducer(START, { type: "pick", method: "cli" });
    expect(show({ state })).toContain("runs");
    state = connectReducer(connectReducer(state, { type: "submit" }), { type: "fail", message: "gh isn't signed in" });
    expect(show({ state })).toContain("gh isn&#x27;t signed in");
  });

  it("shows the device code with copy and open, the countdown, and the ending states", () => {
    const code = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };
    let state = connectReducer(START, { type: "pick", method: "device" });
    expect(show({ state })).toContain("Asking GitHub for a code");
    state = connectReducer(state, { type: "deviceCode", code, now: 0 });
    const waiting = show({ state, now: 60_000 });
    for (const text of ["WDJB-MJHT", "Copy code", "Open github.com/login/device", "Waiting for you to authorise", "14:00", "Cancel"]) expect(waiting).toContain(text);
    expect(show({ state, copied: true })).toContain("Copied");
    expect(show({ state: connectReducer(state, { type: "deviceEnd", message: "expired_token: the code expired" }) })).toContain("expired before it was entered");
    const denied = show({ state: connectReducer(state, { type: "deviceEnd", message: "access_denied" }) });
    expect(denied).toContain("denied");
    expect(denied).toContain("Try again");
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
      <SettingsRowView row={{ container: entry.ref, key: "acme/infra", name: "infra", depth: "involved", pinned: false, unwatchedAt: null, inaccessible: false, cachedItems: 3 }} noun={code} now={NOW} pinOnly={false} onDepth={vi.fn()} onPin={vi.fn()} onUnwatch={vi.fn()} onUndo={vi.fn()} />,
    );
    expect(row).toContain("3 changes synced");
    expect(row).toContain("Unwatch");
    expect(row).not.toContain("Pin ");
    expect(row).not.toContain("Involved");
  });

  it("shows the GitHub account with its watch summary and a confirmed disconnect", () => {
    const c = { id: "github:ada", kind: "github" as const, workspace: "ada", url: null, account: "Ada Example", lastSyncAt: null, syncing: false, error: null, transient: false };
    const watch = { mode: "selected" as const, needsChoice: false, watches: [] as never[] };
    const cardProps = { c, watch: { ...watch, connectionId: "github:ada", catalogSize: null }, now: NOW, busy: false, onSync: vi.fn(), onManage: vi.fn(), onAskDisconnect: vi.fn(), onCancel: vi.fn(), onDisconnect: vi.fn() };
    const out = renderToStaticMarkup(<GithubCardView {...cardProps} confirming={false} />);
    for (const text of ["AD", "ada", "Not watching any repositories yet", "Manage repositories", "Disconnect"]) expect(out).toContain(text);
    expect(out).not.toContain("alertdialog");
    expect(renderToStaticMarkup(<GithubCardView {...cardProps} confirming />)).toContain("alertdialog");
  });
});
