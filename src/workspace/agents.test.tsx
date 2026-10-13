import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState, WorkstreamView } from "../types";
import { AgentCard, RunLabel, onActivate } from "./AgentCard";
import { AgentRow } from "./AgentRow";
import { FailureNext, OpenInTerminal } from "./AgentParts";
import { AgentsBanners } from "./AgentsBanners";
import { AgentsIntro } from "./AgentsEmpty";
import { AgentsScreen, StopAll, keyAction, type AgentsActions, type AgentsScreenProps } from "./AgentsView";
import { NO_FILTERS } from "./agentsLogic";
import { LAUNCHER_GUTTER } from "./PipExtras";
import { DENY_QUESTION, DenyConfirm, StopRunConfirm, stopRunQuestion } from "./PermissionAsk";
import { Rail, railBadgeText } from "./Rail";
import { usePrefs } from "./prefs";
import { useRuns } from "./runsStore";

/** Server rendering reads a store's initial state, so the flag is set on both. */
const explainerSeen = (seen: boolean) => {
  usePrefs.setState({ permissionExplainerSeen: seen });
  Object.assign(usePrefs.getInitialState(), { permissionExplainerSeen: seen });
};

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const eight = () => new MockBackend().runs.list();

const on = (): AgentsActions => ({
  select: vi.fn(),
  open: vi.fn(),
  attach: vi.fn(),
  draftComment: vi.fn(),
  buildFromPlan: vi.fn(),
  resume: vi.fn(),
  filter: vi.fn(),
  clearFilters: vi.fn(),
  setView: vi.fn(),
  setGroup: vi.fn(),
  toggleEarlier: vi.fn(),
  setIntro: vi.fn(),
  dismissIntro: vi.fn(),
  checkEnvironment: vi.fn(),
  retry: vi.fn(),
  fix: vi.fn(),
  retryLaunch: vi.fn(),
  copied: vi.fn(),
  stopAll: vi.fn(),
  startAgent: vi.fn(),
  openSafety: vi.fn(),
});

const screen = (over: Partial<AgentsScreenProps> = {}) =>
  renderToStaticMarkup(
    <AgentsScreen
      runs={eight()}
      status="ready"
      error={null}
      environment={{ claude: "ok", version: "2.1.286" }}
      filters={NO_FILTERS}
      selectedId={null}
      earlierOpen={false}
      introShown={false}
      view="cards"
      stopping={false}
      opened={new Set()}
      now={NOW}
      ticketTitle={() => null}
      on={on()}
      {...over}
    />,
  );

const articles = (html: string) => html.match(/<article[\s\S]*?<\/article>/g) ?? [];

const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...eight()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: null, result: null, error: null, lastProgressAt: iso(1), queuedAt: iso(10), endedAt: null, ...over });

const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

const card = (r: Run, opened = false) =>
  renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  // The permission prompt's one-time explainer is dismissed here, so the cards read as the prompt itself.
  explainerSeen(true);
});

const failures = () => new MockBackend({ runs: { seed: "failures" } }).runs.list();
const failed = (type: string) => failures().find((r) => r.failure?.type === type)!;

describe("a failed launch on a card", () => {
  it("explains an untrusted folder in a line and offers Trust, with Retry waiting until Terminal was used", () => {
    const out = card(failed("untrustedFolder"));
    expect(out).toContain("Claude asks you once per folder before it will work there.");
    expect(buttonsOf(out)).toEqual(["Trust this folder in Terminal", "Retry"]);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Retry/);
    expect(out).not.toContain("accept the trust prompt");
  });

  it("enables Retry once Terminal was opened, and makes it the next step", () => {
    const out = card(failed("untrustedFolder"), true);
    expect(out).not.toMatch(/<button[^>]*disabled=""/);
    const retry = out.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Retry<\/button>/)![0];
    const trust = out.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Trust this folder in Terminal<\/button>/)![0];
    expect(retry).toContain("bg-ws-pip");
    expect(trust).not.toContain("bg-ws-pip");
  });

  it.each([
    ["notSignedIn", "Claude isn't signed in.", ["Open Terminal to sign in", "Retry"], true],
    ["claudeMissing", "Claude Code isn't installed, or Gossamr can't find it.", ["Open the install page", "Retry"], false],
    ["noClone", "The clone this run was set up for can't be used any more.", ["Start it again and choose a clone", "Retry"], false],
    ["capReached", "Too many agents are running at once.", ["Retry"], false],
  ])("gives %s its own line and next step", (type, line, expected, gated) => {
    const out = card(failed(type));
    expect(out).toContain(line.replace(/'/g, "&#x27;"));
    expect(buttonsOf(out)).toEqual(expected);
    expect(/<button[^>]*disabled=""/.test(out)).toBe(gated);
  });

  it("keeps the recorded text for a failure with no kind, and offers a plain Retry", () => {
    const out = card(failed("other"));
    expect(out).toContain("Claude couldn&#x27;t start the agent: the session service didn&#x27;t answer");
    expect(buttonsOf(out)).toEqual([]);
    expect(card(run("failed", { shortId: null, error: "Launch was interrupted" }))).toContain("Launch was interrupted");
  });

  it("offers nothing for a failure after the session began", () => {
    const out = card({ ...failed("untrustedFolder"), shortId: "1000a000" });
    expect(buttonsOf(out)).toEqual([]);
  });

  it("shows the short line in the list row too", () => {
    const out = screen({ runs: failures(), view: "list" });
    expect(out).toContain("Claude asks you once per folder before it will work there.");
    expect(out).toContain("Too many agents are running at once.");
  });
});

describe("the lanes", () => {
  it("shows the scripted runs in three lanes with a card each, and no Needs you lane", () => {
    const out = screen({ needsYou: 4 });
    expect(out.match(/data-lane="(\w+)"/g)).toEqual(['data-lane="running"', 'data-lane="done"', 'data-lane="bad"']);
    for (const heading of ["Running", "Done, ready to review", "Failed or stuck"]) expect(out).toContain(`>${heading}</h3>`);
    expect(out).not.toContain(">Needs you</h3>");
    expect(articles(out)).toHaveLength(8);
    expect(out).toContain("4 need you · 2 running · 2 ready to review · 4 failed or stuck (1 quiet)");
  });

  it("folds Earlier and says how many are in it", () => {
    const stopped = run("stopped", { id: "s1" });
    const out = screen({ runs: [...eight(), stopped] });
    expect(out).toContain('data-lane="earlier"');
    expect(out).toContain(">Earlier</h3>");
    expect(out).toContain("Show");
    expect(out).toContain('aria-expanded="false"');
    expect(articles(out)).toHaveLength(8);
    const open = screen({ runs: [...eight(), stopped], earlierOpen: true });
    expect(articles(open)).toHaveLength(9);
    expect(open).toContain("Hide");
  });

  it("numbers the runs it lets j and k reach, leaving out a folded lane", () => {
    const out = screen({ runs: [...eight(), run("stopped", { id: "s1" })] });
    expect(out).toContain('aria-setsize="8"');
    expect(out).toContain('aria-posinset="8"');
    expect(out).not.toContain('aria-posinset="9"');
  });

  it("marks the selected run", () => {
    const id = eight()[0].id;
    const out = screen({ selectedId: id });
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toContain(`data-run-id="${id}"`);
  });
});

describe("grouped by workstream", () => {
  const ws: WorkstreamView = {
    workstream: { id: "ws-1", connectionId: "mock", itemKey: "CA-401", repo: null, title: "CA-401 Retry the payment", pipSession: null, mode: "advise", heldReason: null, notes: null, createdAt: iso(60), closedAt: null, budget: { autoTurns: null, wakes: null, tokens: null }, spent: { autoTurns: 0, wakes: 0, tokens: 0 }, rules: {}, basis: null },
    stage: "investigate",
    runs: ["w1"],
    labels: [["w1", "R1"]],
    budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
  };
  const linked = () => run("working", { id: "w1", queuedAt: iso(1), spec: { ...eight()[0].spec, kind: "investigate", workstream: "ws-1" } });

  it("says on the workstream's stage chip that its build waits for its pull request", () => {
    const out = screen({ runs: [linked()], group: "workstream", workstreams: [{ ...ws, waitingForPr: "b9" }] });
    expect(out).toMatch(/data-stage="investigate" data-waiting-for-pr="b9"[^>]*>Investigate · waiting for PR</);
    expect(screen({ runs: [linked()], group: "workstream", workstreams: [ws] })).not.toContain("waiting for PR");
  });

  it("offers Group by with State pressed by default", () => {
    const out = screen();
    expect(out).toContain('aria-label="Group by"');
    expect(out).toMatch(/aria-pressed="true"[^>]*>State</);
    expect(out).toContain("data-lane=");
    expect(out).not.toContain("data-workstream-group");
  });

  it("shows a workstream with its title, stage chip and R labels, and the other runs under No workstream", () => {
    const out = screen({ runs: [...eight(), linked()], group: "workstream", workstreams: [ws] });
    expect(out).toMatch(/aria-pressed="true"[^>]*>Workstream</);
    expect(out.match(/data-workstream-group="([^"]+)"/g)).toEqual(['data-workstream-group="ws-1"', 'data-workstream-group="none"']);
    expect(out).toContain(">CA-401 Retry the payment</h3>");
    expect(out).toContain('data-stage="investigate"');
    expect(out).toContain('data-run-label="R1"');
    expect(out).toContain(">No workstream</h3>");
    expect(out).not.toContain("data-lane=");
    // Every run is reachable; nothing folds in this grouping.
    expect(articles(out)).toHaveLength(9);
    expect(out).toContain('aria-setsize="9"');
  });

  it("labels the run in list mode too", () => {
    const out = screen({ runs: [linked()], group: "workstream", workstreams: [ws], view: "list" });
    expect(out).toContain('data-run-label="R1"');
  });
});

describe("the Agents screen as the operations view", () => {
  it("has no timeline filter of its own: what is running, the capacity and Stop all, with a way to the Runs timeline", () => {
    const html = screen({ on: { ...on(), showTimeline: vi.fn() } });
    expect(html).not.toContain("data-agents-scope");
    expect(html).not.toContain("Timeline filter");
    expect(html).not.toContain("Timeline scope");
    expect(html).toMatch(/<button[^>]*data-agents-timeline[^>]*>(?:<[^>]+>)*Runs timeline/);
    expect(html).toContain("Stop all");
    // Without the way there (a screen that can't show Pip home), no button.
    expect(screen()).not.toContain("data-agents-timeline");
  });

  it("names F6 (the regions) and the Pip home key in its footer, beside j k, Enter and Esc", () => {
    const footer = screen().match(/<footer[\s\S]*?<\/footer>/)![0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(footer).toContain("j k move");
    expect(footer).toContain("F6 regions");
    expect(footer).toContain("⌘0 Pip home");
  });

  it("explains a run's R badge with a tooltip", () => {
    expect(renderToStaticMarkup(<RunLabel label="R2" />)).toContain('title="Run 2 in this workstream"');
    expect(renderToStaticMarkup(<RunLabel />)).toBe("");
  });
});

describe("cards", () => {
  it("shows the exact command a permission prompt waits on, with Allow once only on a Build, Deny, and Stop said to abandon the run", () => {
    const asking = run("needsPermission", { needs: "approve Bash: git push -u origin worktree-ca-401-fix", shortId: "1000a000", readOnly: null });
    const build = card({ ...asking, spec: { ...asking.spec, kind: "build", allowPush: true, name: "ca-401-fix" } });
    expect(build).toContain("git push -u origin worktree-ca-401-fix");
    expect(buttonsOf(build)).toEqual(["Copy", "Allow once in Terminal", "Deny", "Stop the run (abandons it)"]);
    const ro = card({ ...asking, spec: { ...asking.spec, kind: "investigate" } });
    expect(ro).toContain("This run is read-only: Claude Code refuses this.");
    expect(buttonsOf(ro)).toEqual(["Copy", "Deny", "Stop the run (abandons it)"]);
    for (const html of [build, ro]) for (const word of ["Approve", "Nudge", "Always"]) expect(html).not.toContain(word);
  });

  it("asks before a card's Stop abandons the run, as the sheet does", () => {
    const html = renderToStaticMarkup(<StopRunConfirm name="R4" onStop={vi.fn()} onKeep={vi.fn()} />);
    expect(html).toContain('role="group" aria-label="Stop this run"');
    expect(html).toContain(stopRunQuestion("R4"));
    expect(stopRunQuestion("R4")).toBe("Stop R4? It abandons the run.");
    expect(buttonsOf(html)).toEqual(["Yes, stop", "Keep going"]);
  });

  it("asks before a card's Deny tells the agent no: Escape and Keep waiting leave it asking", () => {
    const html = renderToStaticMarkup(<DenyConfirm onDeny={vi.fn()} onKeep={vi.fn()} />);
    expect(html).toContain('role="group" aria-label="Deny this request"');
    expect(html).toContain(DENY_QUESTION);
    expect(DENY_QUESTION).toBe("Deny this?");
    expect(buttonsOf(html)).toEqual(["Yes, deny", "Keep waiting"]);
  });

  it("offers Resume on a run stopped at its limit, only when the person can act on it, and says it stopped at its limit", () => {
    const limit = run("stopped", { stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit" });
    const resume = vi.fn();
    const withResume = (r: Run, onResume?: () => void) =>
      renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onResume={onResume} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(buttonsOf(withResume(limit, resume))).toContain("Resume");
    expect(buttonsOf(withResume(limit))).not.toContain("Resume");
    expect(buttonsOf(card(run("stopped")))).not.toContain("Resume");
    expect(card(limit)).toContain("Stopped at limit");
    // The lane it sits in is Failed or stuck; Needs you lists it too.
    const html = screen({ runs: [limit, run("failed", { id: "f", failure: null })] });
    expect(html).toMatch(/data-lane="bad"[\s\S]*Stopped at limit/);
  });

  it("shows a question with Open in Terminal and no answer box", () => {
    const html = card(run("needsAnswer", { needs: "Should the refund path keep the old rounding?", shortId: "1000a000" }));
    expect(html).toContain("Should the refund path keep the old rounding?");
    expect(html).toContain("Open in Terminal");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  it("says Claude needs a sign-in, without a question", () => {
    const html = card(run("systemBlocked", { shortId: "1000a000" }));
    expect(html).toContain("Claude needs you to sign in");
    expect(html).toContain("Sign-in needed");
    expect(html).not.toContain("<q");
  });

  it("sends an unknown state to Terminal", () => {
    const html = card(run("unknown", { shortId: "1000a000" }));
    expect(html).toContain("Open in Terminal to look");
    expect(html).toContain("Unknown");
  });

  it("calls a working run quiet at 30 minutes, with a chip that says so and never says stuck", () => {
    const html = card(run("working", { lastProgressAt: iso(40), shortId: "1000a000" }));
    expect(html).toContain("Quiet for 40 min");
    expect(html).not.toMatch(/stuck/i);
    expect(card(run("working", { lastProgressAt: iso(29) }))).not.toContain("Quiet for");
    expect(card(run("working", { lastProgressAt: iso(247 * 60), shortId: "1000a000" }))).toContain("Quiet for 10 days");
    expect(card(run("working", { lastProgressAt: iso(247 * 60), shortId: "1000a000" }))).not.toMatch(/\d{3,} h\b/);
  });

  it("disables Open in Terminal until there is a session", () => {
    expect(card(run("needsAnswer", { shortId: null }))).toMatch(/<button[^>]* disabled=""/);
  });

  it("gives every state an icon and a word", () => {
    const states: RunState[] = ["queued", "launching", "working", "needsAnswer", "needsPermission", "systemBlocked", "done", "failed", "stopped", "unknown"];
    const words = ["Queued", "Launching", "Working", "Needs an answer", "Needs permission", "Sign-in needed", "Ready to review", "Failed", "Stopped", "Unknown"];
    states.forEach((s, i) => {
      const html = card(run(s));
      expect(html).toContain(`>${words[i]}<`);
      expect(html).toMatch(/<span[^>]*data-state="[a-zA-Z]+"[^>]*><svg/);
    });
  });

  it("writes tokens as a count and never as money", () => {
    const html = screen();
    expect(html).toContain("578k tokens");
    expect(html).not.toMatch(/[$€£]|\bkr\b|≈/);
  });

  it("has no Stop or Nudge on any card; Stop all is in the header only", () => {
    const out = screen();
    // The one exception: a permission prompt can be answered by abandoning the run, and says so.
    for (const a of articles(out)) {
      expect(a.replace(/>Stop the run \(abandons it\)</g, "><")).not.toMatch(/Stop|Nudge/);
      if (a.includes("Stop the run")) expect(a).toContain('data-state="needsPermission"');
    }
    expect(out).toContain("Stop all");
    expect(out).not.toContain("Nudge");
  });

  it("names the branch worktree-<name>", () => {
    expect(card(run("working"))).toContain(`worktree-${run("working").spec.name}`);
  });
});

describe("list mode", () => {
  it("is one row per run under a single header of column names", () => {
    const out = screen({ view: "list" });
    expect(articles(out)).toHaveLength(8);
    expect(out.match(/>Ticket</g)).toHaveLength(1);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("git push origin HEAD");
  });
});

describe("filters", () => {
  it("shows only the runs in the chosen lane", () => {
    const out = screen({ filters: { ...NO_FILTERS, lane: "bad" } });
    expect(articles(out)).toHaveLength(4);
    expect(out).toContain(">Clear<");
    expect(out.match(/data-lane="(\w+)"/g)).toEqual(['data-lane="bad"']);
  });

  it("narrows by repo and by ticket", () => {
    expect(articles(screen({ filters: { ...NO_FILTERS, repo: "acme/payments" } }))).toHaveLength(1);
    expect(articles(screen({ filters: { ...NO_FILTERS, ticket: "WEB-108" } }))).toHaveLength(1);
  });

  it("lists every repo and ticket in the menus, whatever is filtered", () => {
    const out = screen({ filters: { ...NO_FILTERS, repo: "acme/payments" } });
    expect(out).toContain('aria-label="Filter by repo"');
    expect(out).toContain('<option value="acme/storefront">');
    expect(out).toContain('<option value="DEVOPS-471">');
  });

  it("says nothing matches and offers Clear filters", () => {
    const out = screen({ filters: { lane: "bad", repo: "acme/payments", ticket: "all" } });
    expect(out).toContain("No agents match these filters");
    expect(out).toContain("8 runs are hidden by the filters above.");
    expect(out).toContain("Clear filters");
    expect(articles(out)).toHaveLength(0);
  });
});

describe("empty, first-run and errors", () => {
  it("says there are no agents once the explainer is dismissed", () => {
    const out = screen({ runs: [] });
    expect(out).toContain("No agents yet");
    expect(out).toContain("Nothing runs until you approve it.");
    expect(out).toContain("Nothing running");
  });

  it("shows the explainer instead of the empty state on a first visit", () => {
    const out = screen({ runs: [], introShown: true });
    expect(out).toContain("Agents are Claude Code sessions that work in the background");
    expect(out).not.toContain("No agents yet");
  });

  it("states the limits honestly in the explainer", () => {
    const out = renderToStaticMarkup(<AgentsIntro onDismiss={vi.fn()} />).replace(/&#x27;/g, "'");
    for (const phrase of [
      "You approve each one first. Agents are on by default; turn them off any time in Settings.",
      "A Build runs as you, with your own Claude settings: anything your Claude can do, it can do.",
      "Read-only steps are signed in as you but run without your settings.",
      "Investigate, Triage, Plan, Review and Verify are read-only: Claude Code itself refuses their file edits and writing commands, and your own and the repository's allow rules don't apply.",
      "Review and Verify may run the repository's tests, whose code runs as written.",
      "A Build changes code in its worktree and is told not to write to Jira, but that is a request, not a lock.",
      "They work in their own worktree of your clone, so your own files and branch are not touched.",
      "Stop any run from its details, or Stop all above.",
      "Agents you start from Terminal are not shown here, and Gossamr's runs also show in your own",
      "claude agents",
    ]) {
      expect(out).toContain(phrase);
    }
    expect(out).not.toMatch(/never write to Jira/i);
  });

  it("waits quietly for the first read", () => {
    expect(screen({ runs: [], status: "loading" })).toContain("Loading agents…");
    expect(screen({ runs: [], status: "idle" })).toContain("Loading agents…");
  });

  it("explains a missing Claude with the install command and a way to check again", () => {
    const out = renderToStaticMarkup(<AgentsBanners environment={{ claude: "missing", version: null }} loadError={null} onCheckAgain={vi.fn()} onRetry={vi.fn()} />);
    expect(out).toContain("installed on this Mac");
    expect(out).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(out).toContain("Check again");
    expect(out).toContain('role="alert"');
  });

  it("explains a signed-out Claude", () => {
    const out = renderToStaticMarkup(<AgentsBanners environment={{ claude: "signedOut", version: "2.1.286" }} loadError={null} onCheckAgain={vi.fn()} onRetry={vi.fn()} />);
    expect(out).toContain("signed in");
    expect(out).toContain("/login");
    expect(out).not.toContain("installed on this Mac");
  });

  it("shows no banner when Claude is fine or the check could not be made", () => {
    for (const claude of ["ok", "unknown"] as const) {
      expect(renderToStaticMarkup(<AgentsBanners environment={{ claude, version: null }} loadError={null} onCheckAgain={vi.fn()} onRetry={vi.fn()} />)).toBe("");
    }
    expect(renderToStaticMarkup(<AgentsBanners environment={null} loadError={null} onCheckAgain={vi.fn()} onRetry={vi.fn()} />)).toBe("");
  });

  it("shows why the runs could not be read, with Retry, and keeps what it had", () => {
    const out = screen({ status: "error", error: "runs_list failed: database is locked" });
    expect(out).toContain("load your agents");
    expect(out).toContain("database is locked");
    expect(out).toContain("Retry");
    expect(articles(out)).toHaveLength(8);
  });
});

describe("keys", () => {
  const order = ["a", "b", "c"];

  it("moves the selection with j and k and clears it with Esc", () => {
    expect(keyAction("j", null, order)).toEqual({ type: "select", id: "a" });
    expect(keyAction("j", "a", order)).toEqual({ type: "select", id: "b" });
    expect(keyAction("k", "c", order)).toEqual({ type: "select", id: "b" });
    expect(keyAction("Escape", "b", order)).toEqual({ type: "clear" });
  });

  it("leaves other keys, and Esc with nothing selected, alone", () => {
    expect(keyAction("Escape", null, order)).toBeNull();
    expect(keyAction("x", "a", order)).toBeNull();
    expect(keyAction("n", "a", order)).toBeNull();
    expect(keyAction("j", null, [])).toBeNull();
  });

  it("opens a run with Enter only when the card itself has focus", () => {
    const open = vi.fn();
    const handler = onActivate(open);
    const card = {};
    const press = (key: string, target: unknown) => handler({ key, target, currentTarget: card, preventDefault: vi.fn() } as never);
    press("Enter", {});
    expect(open).not.toHaveBeenCalled();
    press("x", card);
    expect(open).not.toHaveBeenCalled();
    press("Enter", card);
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("stop all", () => {
  it("is disabled with nothing to stop", () => {
    const disabled = /<button[^>]* disabled=""/;
    expect(renderToStaticMarkup(<StopAll count={0} busy={false} onStop={vi.fn()} />)).toMatch(disabled);
    expect(renderToStaticMarkup(<StopAll count={2} busy={false} onStop={vi.fn()} />)).not.toMatch(disabled);
    expect(renderToStaticMarkup(<StopAll count={2} busy onStop={vi.fn()} />)).toMatch(disabled);
  });
});

describe("the rail", () => {
  const set = (runs: Run[], dismissed: string[] = []) => {
    const initial = useRuns.getInitialState();
    initial.runs = runs;
    (initial as { dismissed: ReadonlySet<string> }).dismissed = new Set(dismissed);
  };
  const button = (out: string, name: RegExp) => new RegExp(`<button[^>]*aria-label="(${name.source}[^"]*)"[^>]*>(.*?)</button>`, "s").exec(out)!;
  // The sample's clock stands at 12:00 on 30 September 2026; five minutes on, its quiet run has been quiet 45.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 5 * 60_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    set([]);
  });

  it("has no badge on Agents: what needs the person is counted once, on Pip home", () => {
    set(eight());
    const [, label, inner] = button(renderToStaticMarkup(<Rail />), /Agents/);
    expect(label).toBe("Agents");
    expect(inner).not.toContain("bg-ws-pip");
    expect(inner).not.toMatch(/>\d+</);
  });

  it("puts the one count in Pip home's label and shows it as its badge", () => {
    set(eight());
    const [, label, inner] = button(renderToStaticMarkup(<Rail />), /Pip home/);
    // A permission, a question, a failure and the run that has been quiet for 45 minutes.
    expect(label).toBe("Pip home, 4 things need you");
    expect(inner).toContain('aria-label="4 things need you" title="4 things need you"');
    expect(inner).toContain(">4<");
    expect(inner).toContain("bg-ws-pip");
  });

  it("keeps a failed run in the count however long it is looked at, until it is dismissed", () => {
    const failedRun = eight().find((r) => r.state === "failed")!;
    set(eight());
    expect(button(renderToStaticMarkup(<Rail />), /Pip home/)[1]).toBe("Pip home, 4 things need you");
    set(eight(), [failedRun.id]);
    expect(button(renderToStaticMarkup(<Rail />), /Pip home/)[1]).toBe("Pip home, 3 things need you");
  });

  it("says thing for one and drops the badge at zero", () => {
    set([run("needsAnswer")]);
    expect(button(renderToStaticMarkup(<Rail />), /Pip home/)[1]).toBe("Pip home, 1 thing needs you");
    set([run("working", { lastProgressAt: new Date(NOW + 4 * 60_000).toISOString() }), run("done", { id: "d" })]);
    const [, label, inner] = button(renderToStaticMarkup(<Rail />), /Pip home/);
    expect(label).toBe("Pip home");
    expect(inner).not.toContain("bg-ws-pip");
  });

  it("names what each badge counts, in words no other badge uses", () => {
    expect([railBadgeText.activity(24), railBadgeText.pipHome(4)]).toEqual(["24 unread updates", "4 things need you"]);
    expect([railBadgeText.activity(1), railBadgeText.pipHome(1)]).toEqual(["1 unread update", "1 thing needs you"]);
    expect(railBadgeText).not.toHaveProperty("agents");
  });

  it("sits beside Activity in the bottom group", () => {
    set([]);
    const out = renderToStaticMarkup(<Rail />);
    expect(out.indexOf('aria-label="Activity"')).toBeLessThan(out.indexOf('aria-label="Agents"'));
    expect(out.indexOf('aria-label="Agents"')).toBeLessThan(out.indexOf('aria-label="Settings"'));
  });
});

describe("a run in Needs you", () => {
  it("shows an 'In Needs you' pill on its card and its row, which opens the need rather than the run", () => {
    const asking = run("needsAnswer");
    const open = vi.fn();
    const onOpen = vi.fn();
    const withPill = renderToStaticMarkup(<AgentCard run={asking} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={onOpen} onAttach={vi.fn()} onOpenNeed={open} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(withPill).toContain("data-in-needs-you");
    expect(withPill).toContain(">In Needs you<");
    expect(card(asking)).not.toContain("In Needs you");
    const row = renderToStaticMarkup(<AgentRow run={asking} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={onOpen} onAttach={vi.fn()} onOpenNeed={open} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(row).toContain(">In Needs you<");
  });

  it("is told only for the runs Needs you lists, and the header counts Needs you's one count", () => {
    const out = screen({ needsYou: 4, inNeeds: new Map() });
    expect(out).toContain("4 need you · ");
    expect(out).not.toContain("In Needs you");
    expect(out).not.toContain('data-lane="needs"');
    expect(out).not.toContain(">Needs you<");
  });
});

describe("motion", () => {
  const css = readFileSync(new URL("./agents.css", import.meta.url), "utf8");

  it("turns the pulse into a plain dot and stops card movement for reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.ws-pulse::after\s*{\s*display:\s*none/);
    expect(reduced).toMatch(/\.ws-agent-card:hover\s*{\s*transform:\s*none/);
  });
});

describe("opening a run", () => {
  const props = (onOpen: () => void) => ({ run: run("done"), now: NOW, selected: false, position: 1, total: 1, ticketTitle: null, onOpen, onAttach: vi.fn(), failure: { opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } } });

  it("opens the run when a card or a row is clicked, not only when Enter is pressed", () => {
    const open = vi.fn();
    const card = AgentCard(props(open)) as { props: { onClick: () => void } };
    card.props.onClick();
    const row = AgentRow(props(open)) as { props: { onClick: () => void } };
    row.props.onClick();
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("controls inside a card", () => {
  type El = { props: { onClick?: (ev: { stopPropagation(): void }) => void; children?: unknown } };
  const buttons = (el: unknown): El[] => {
    const found: El[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) return n.forEach(walk);
      const e = n as El | null;
      if (!e || typeof e !== "object" || !("props" in e)) return;
      if ((e as unknown as { type: unknown }).type === "button") found.push(e);
      walk(e.props.children);
    };
    walk(el);
    return found;
  };
  const click = (b: El) => {
    const ev = { stopPropagation: vi.fn() };
    b.props.onClick!(ev);
    return ev.stopPropagation;
  };

  it("keeps a click on Open in Terminal from also opening the run", () => {
    const onOpen = vi.fn();
    const [b] = buttons(OpenInTerminal({ run: run("needsAnswer", { shortId: "1000a000" }), onOpen }));
    const stop = click(b);
    expect(stop).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps a click on the failure buttons from also opening the run", () => {
    const failure = { opened: true, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } };
    const bs = buttons(FailureNext({ run: failed("untrustedFolder"), failure }));
    expect(bs).toHaveLength(2);
    for (const b of bs) expect(click(b)).toHaveBeenCalledOnce();
    expect(failure.on.act).toHaveBeenCalledOnce();
    expect(failure.on.retry).toHaveBeenCalledOnce();
  });
});

describe("a disabled Retry says why in view", () => {
  it("shows the reason as text linked to the button, not only a title, and nothing once Retry is ready", () => {
    const waiting = renderToStaticMarkup(<FailureNext run={failed("untrustedFolder")} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    const id = /aria-describedby="([^"]+)"/.exec(waiting)?.[1];
    expect(id).toBeTruthy();
    expect(waiting).toContain(`id="${id}"`);
    expect(waiting).toContain("Do the step above first, then retry</span>");
    expect(waiting).not.toContain("title=");
    const ready = renderToStaticMarkup(<FailureNext run={failed("untrustedFolder")} failure={{ opened: true, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(ready).not.toContain("Do the step above first");
    expect(ready).not.toContain("aria-describedby");
  });
});

describe("publishing the shown order", () => {
  // The suite renders to static markup, so no effect runs here; this guards the source instead.
  const source = readFileSync(new URL("./AgentsView.tsx", import.meta.url), "utf8");

  it("publishes it in a layout effect, which the native j and k listener cannot outrun", () => {
    expect(source).toMatch(/useLayoutEffect\(\(\) => onOrder\?\.\(order\)/);
    expect(source).not.toMatch(/useEffect\(\(\) => onOrder\?\.\(order\)/);
  });
});

describe("clearance for the floating Pip launcher", () => {
  it("keeps the Agents list's cards and its lanes' links out of the launcher's column and above its row", () => {
    const html = screen();
    expect(html).toContain("pr-[max(24px,var(--ws-launcher-gutter,0px))]");
    expect(html).toContain("pb-[max(80px,var(--ws-launcher-clear,0px))]");
  });

  it("publishes the gutter beside the bottom clearance, at least the launcher's width and margin, only while the launcher shows", () => {
    expect(LAUNCHER_GUTTER).toBeGreaterThanOrEqual(74 + 20);
    const source = readFileSync(new URL("./Workspace.tsx", import.meta.url), "utf8");
    expect(source).toContain("`${launcherShown ? LAUNCHER_GUTTER : 0}px`");
  });
});
