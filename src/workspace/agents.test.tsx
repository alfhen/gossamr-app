import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState, WorkstreamView } from "../types";
import { AgentCard, RunLabel, onActivate } from "./AgentCard";
import { AgentRow } from "./AgentRow";
import { FailureNext, OpenInTerminal } from "./AgentParts";
import { AgentsIntro } from "./AgentsEmpty";
import { AgentsScreen, StopAll, keyAction, type AgentsActions, type AgentsScreenProps } from "./AgentsView";
import { NO_FILTERS } from "./agentsLogic";

// The cards are called as plain functions in "opening a run", outside a render, so the store hook behind their state label is stood in for by the pure `stateView`.
vi.mock("./useStateView", async () => {
  const logic = await import("./agentsLogic");
  return { useStateView: (run: Parameters<typeof logic.stateView>[0], now: number) => logic.stateView(run, now) };
});
import { LAUNCHER_GUTTER } from "./PipExtras";
import { PERMISSION_NOTE } from "./PermissionAsk";
import { useActivity } from "./activityStore";
import { Rail, railBadgeText } from "./Rail";
import { useRuns } from "./runsStore";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const eight = () => new MockBackend().runs.list();

const on = (): AgentsActions => ({
  select: vi.fn(),
  open: vi.fn(),
  attach: vi.fn(),
  draftComment: vi.fn(),
  buildFromPlan: vi.fn(),
  filter: vi.fn(),
  clearFilters: vi.fn(),
  stop: vi.fn(),
  setIntro: vi.fn(),
  dismissIntro: vi.fn(),
  retry: vi.fn(),
  fix: vi.fn(),
  retryLaunch: vi.fn(),
  copied: vi.fn(),
  stopAll: vi.fn(),
  askPip: vi.fn(),
  openSafety: vi.fn(),
});

const screen = (over: Partial<AgentsScreenProps> = {}) =>
  renderToStaticMarkup(
    <AgentsScreen
      runs={eight()}
      status="ready"
      error={null}
      filters={NO_FILTERS}
      selectedId={null}
      introShown={false}
      stopping={false}
      opened={new Set()}
      now={NOW}
      ticketTitle={() => null}
      on={on()}
      {...over}
    />,
  );

describe("opening Agents (G9)", () => {
  it("makes the h1 a place focus can be sent to, and sends it there as the screen mounts", () => {
    expect(screen()).toMatch(/<h1 tabindex="-1"[^>]*>\s*Work\s*<\/h1>/);
    expect(readFileSync(new URL("./AgentsView.tsx", import.meta.url), "utf8")).toMatch(/requestAnimationFrame\([\s\S]{0,200}title\.current\?\.focus\(\)/);
  });
});

const articles = (html: string) => html.match(/<article[\s\S]*?<\/article>/g) ?? [];

const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...eight()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: null, result: null, error: null, lastProgressAt: iso(1), queuedAt: iso(10), endedAt: null, ...over });

const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

const card = (r: Run, opened = false) =>
  renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
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
    ["noClone", "The clone this run was set up for can't be used any more.", ["Clone it", "Choose clone", "Retry"], false],
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

  it("shows the short line on each failure card", () => {
    const out = screen({ runs: failures() });
    expect(out).toContain("Claude asks you once per folder before it will work there.");
    expect(out).toContain("Too many agents are running at once.");
  });
});

describe("the Work screen groups agents by workstream", () => {
  const ws: WorkstreamView = {
    workstream: { id: "ws-1", connectionId: "mock", itemKey: "CA-401", repo: null, title: "CA-401 Retry the payment", pipSession: null, pausedReason: null, notes: null, createdAt: iso(60), closedAt: null, basis: null },
    stage: "investigate",
    runs: ["w1"],
    labels: [["w1", "R1"]],
  };
  const linked = () => run("working", { id: "w1", queuedAt: iso(1), spec: { ...eight()[0].spec, role: "investigate", workstream: "ws-1" } });

  it("has one filter and no grouping or state controls", () => {
    const out = screen();
    expect(out).toContain("data-workstream-group");
    expect(out).toContain('data-chip="needs"');
    expect(out.match(/data-chip="/g)).toHaveLength(1);
    expect(out).not.toContain('aria-label="Group by"');
    expect(out).not.toContain("data-lane=");
    expect(out).not.toMatch(/<select/);
  });

  it("shows a workstream with its title and R labels, and the other runs under No workstream", () => {
    const out = screen({ runs: [...eight(), linked()], workstreams: [ws] });
    expect(out.match(/data-workstream-group="([^"]+)"/g)).toEqual(['data-workstream-group="ws-1"', 'data-workstream-group="none"']);
    expect(out).toMatch(/<h3[^>]*><b[^>]*>CA-401<\/b><span[^>]*>Retry the payment<\/span><\/h3>/);
    expect(out).toContain('data-run-label="R1"');
    expect(out).toContain(">No workstream</h3>");
    // Every run is reachable; nothing folds.
    expect(articles(out)).toHaveLength(9);
    expect(out).toContain('aria-setsize="9"');
  });
});

describe("the Agents screen as the operations view", () => {
  it("has no timeline filter of its own: what is running, the capacity and Stop all", () => {
    const html = screen();
    expect(html).not.toContain("data-agents-scope");
    expect(html).not.toContain("Timeline filter");
    expect(html).not.toContain("Timeline scope");
    expect(html).not.toContain("data-agents-timeline");
    expect(html).toContain("Stop all");
  });

  it("names F6 (the regions) and the palette in its footer, beside j k, Enter and Esc, and no other screen", () => {
    const footer = screen().match(/<footer[\s\S]*?<\/footer>/)![0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(footer).toContain("j k move");
    expect(footer).toContain("F6 regions");
    expect(footer).toContain("⌘K jump");
    expect(footer).not.toContain("Pip home");
    expect(footer).not.toContain("⌘0");
  });

  it("explains a run's R badge with a tooltip", () => {
    expect(renderToStaticMarkup(<RunLabel label="R2" />)).toContain('title="Run 2 in this workstream"');
    expect(renderToStaticMarkup(<RunLabel />)).toBe("");
  });
});

describe("cards", () => {
  it("shows the exact command a permission prompt waits on, with one way to answer it: Open in Terminal", () => {
    const asking = run("needsPermission", { needs: "approve Bash: git push -u origin worktree-ca-401-fix", shortId: "1000a000" });
    for (const role of ["builder", "investigator", "profiler"]) {
      const html = card({ ...asking, spec: { ...asking.spec, role, name: "ca-401-fix" } });
      expect(html).toContain("git push -u origin worktree-ca-401-fix");
      expect(html).toContain(PERMISSION_NOTE);
      expect(buttonsOf(html)).toEqual(["Copy", "Open in Terminal"]);
      for (const word of ["Allow once", "Deny", "read-only", "Approve", "Nudge", "Always"]) expect(html).not.toContain(word);
    }
  });

  it("names each Draft comment button by its ticket, or by the card's title without one (G9)", () => {
    const withDraft = (r: Run) =>
      renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onDraftComment={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    const name = (html: string) => html.match(/aria-label="(Draft comment on [^"]*)"/)?.[1];
    const base = run("done", { id: "a" });
    const one = name(withDraft({ ...base, item: { ...base.item!, key: "CA-1" } }));
    const two = name(withDraft({ ...base, id: "b", item: { ...base.item!, key: "CA-2" } }));
    expect(one).toBe("Draft comment on CA-1");
    expect(two).toBe("Draft comment on CA-2");
    expect(buttonsOf(withDraft(base))).toContain("Draft comment");
    expect(name(withDraft({ ...base, item: null }))).toMatch(/^Draft comment on \S/);
  });

  it("says a stopped run was stopped, and offers nothing to resume", () => {
    const stopped = run("stopped", { error: null, lastDetail: null });
    expect(buttonsOf(card(stopped))).not.toContain("Resume");
    expect(card(stopped)).toContain("Stopped");
    expect(card(stopped)).not.toContain("limit");
  });

  it("gives a running agent's row Open in Terminal and Stop, and a waiting one only Stop beside its own Terminal button", () => {
    const row = (r: Run) => renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onStop={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(buttonsOf(row(run("working", { shortId: "1000a000" })))).toEqual(["Open in Terminal", "Stop"]);
    const waiting = buttonsOf(row(run("needsAnswer", { needs: "Keep the rounding?", shortId: "1000a000" })));
    expect(waiting.filter((b) => b === "Open in Terminal")).toHaveLength(1);
    expect(waiting).toContain("Stop");
    expect(buttonsOf(row(run("done", { shortId: "1000a000" })))).toEqual(["Open in Terminal"]);
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

  it("shows Terminal and Stop on work rows", () => {
    const out = screen();
    expect(out).toContain("Open in Terminal");
    expect(out).toMatch(/<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?Stop<\/button>/);
  });

  it("names the branch worktree-<name>", () => {
    expect(card(run("working"))).toContain(`worktree-${run("working").spec.name}`);
  });
});

describe("empty, first-run and errors", () => {
  it("says there are no agents once the explainer is dismissed", () => {
    const out = screen({ runs: [] });
    expect(out).toContain("No agents yet");
    expect(out).toContain("When Pip starts one it appears here");
    expect(out).toContain("You can stop any of them.");
    expect(out).not.toMatch(/approve/i);
  });

  it("shows the explainer instead of the empty state on a first visit", () => {
    const out = screen({ runs: [], introShown: true });
    expect(out).toContain("Agents are Claude Code sessions that work in the background");
    expect(out).not.toContain("No agents yet");
  });

  it("states the limits honestly in the explainer", () => {
    const out = renderToStaticMarkup(<AgentsIntro onDismiss={vi.fn()} />).replace(/&#x27;/g, "'");
    for (const phrase of [
      "Pip starts an agent when you ask, and tells you about any it starts on its own.",
      "Agents run with your own Claude Code settings: anything your Claude can do, they can do.",
      "They are told not to write to Jira, but that is a request, not a lock.",
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

  it("has no house icon: Work is the one button, and the one count is its badge", () => {
    set(eight());
    const out = renderToStaticMarkup(<Rail />);
    expect(out).not.toContain("Pip home");
    expect(out).not.toContain("⌂");
    expect(out.match(/aria-label="Work(, [^"]*)?"/g)).toHaveLength(1);
  });

  it("puts the one count in Work's label and shows it as its badge", () => {
    set(eight());
    const [, label, inner] = button(renderToStaticMarkup(<Rail />), /Work/);
    // A permission, a question and a failure; the run that has been quiet for 45 minutes is not a need.
    expect(label).toBe("Work, 3 things need you");
    expect(inner).toContain('aria-label="3 things need you" title="3 things need you"');
    expect(inner).toContain(">3<");
    expect(inner).toContain("bg-ws-pip");
  });

  it("keeps a failed run in the count however long it is looked at, until it is dismissed", () => {
    const failedRun = eight().find((r) => r.state === "failed")!;
    set(eight());
    expect(button(renderToStaticMarkup(<Rail />), /Work/)[1]).toBe("Work, 3 things need you");
    set(eight(), [failedRun.id]);
    expect(button(renderToStaticMarkup(<Rail />), /Work/)[1]).toBe("Work, 2 things need you");
  });

  it("says thing for one and drops the badge at zero", () => {
    set([run("needsAnswer")]);
    expect(button(renderToStaticMarkup(<Rail />), /Work/)[1]).toBe("Work, 1 thing needs you");
    set([run("working", { lastProgressAt: new Date(NOW + 4 * 60_000).toISOString() }), run("done", { id: "d" })]);
    const [, label, inner] = button(renderToStaticMarkup(<Rail />), /Work/);
    expect(label).toBe("Work");
    expect(inner).not.toContain("bg-ws-pip");
  });

  it("names what the one badge counts", () => {
    expect(railBadgeText.agents(4)).toBe("4 things need you");
    expect(railBadgeText.agents(1)).toBe("1 thing needs you");
    expect(Object.keys(railBadgeText)).toEqual(["agents"]);
  });

  it("has no badge on Inbox, however much is unread", () => {
    useActivity.getInitialState().unread = 28;
    const [, label, inner] = button(renderToStaticMarkup(<Rail />), /Inbox/);
    useActivity.getInitialState().unread = 0;
    expect(label).toBe("Inbox");
    expect(inner).not.toContain("bg-ws-pip");
    expect(inner).not.toMatch(/>\d+</);
  });

  it("sits beside Activity in the bottom group", () => {
    set([]);
    const out = renderToStaticMarkup(<Rail />);
    expect(out.indexOf('aria-label="Inbox"')).toBeLessThan(out.indexOf('aria-label="Work"'));
    expect(out.indexOf('aria-label="Work"')).toBeLessThan(out.indexOf('aria-label="Settings"'));
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
    expect(out).toMatch(/data-chip="needs"[^>]*>Needs you<span data-chip-count[^>]*>4</);
    expect(out).not.toContain("In Needs you");
    expect(out).not.toContain('data-lane="needs"');
    expect(out).not.toContain(">Needs you</h3>");
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
