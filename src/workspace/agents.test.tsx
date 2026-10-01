import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState } from "../types";
import { AgentCard, onActivate } from "./AgentCard";
import { AgentRow } from "./AgentRow";
import { FailureNext, OpenInTerminal } from "./AgentParts";
import { AgentsBanners } from "./AgentsBanners";
import { AgentsIntro } from "./AgentsEmpty";
import { AgentsScreen, StopAll, keyAction, type AgentsActions, type AgentsScreenProps } from "./AgentsView";
import { NO_FILTERS } from "./agentsLogic";
import { Rail } from "./Rail";
import { useRuns } from "./runsStore";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const eight = () => new MockBackend().runs.list();

const on = (): AgentsActions => ({
  select: vi.fn(),
  open: vi.fn(),
  attach: vi.fn(),
  draftComment: vi.fn(),
  filter: vi.fn(),
  clearFilters: vi.fn(),
  setView: vi.fn(),
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
  it("shows the scripted runs in four lanes with a card each", () => {
    const out = screen();
    expect(out.match(/data-lane="(\w+)"/g)).toEqual(['data-lane="needs"', 'data-lane="running"', 'data-lane="done"', 'data-lane="bad"']);
    for (const heading of ["Needs you", "Running", "Done, ready to review", "Failed or stuck"]) expect(out).toContain(`>${heading}</h3>`);
    expect(articles(out)).toHaveLength(8);
    expect(out).toContain("2 need you · 2 running · 2 ready to review · 1 quiet · 1 failed");
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

describe("cards", () => {
  it("shows the exact command a permission prompt waits on, and one way to answer it", () => {
    const html = card(run("needsPermission", { needs: "approve Bash: git push origin HEAD", shortId: "1000a000" }));
    expect(html).toContain("git push origin HEAD");
    expect(html).toContain("Open in Terminal");
    expect(html.match(/<button/g)).toHaveLength(1);
    for (const word of ["Allow", "Deny", "Approve", "Nudge", "Stop"]) expect(html).not.toContain(word);
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
    for (const a of articles(out)) {
      expect(a).not.toMatch(/Stop|Nudge/);
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
    const out = screen({ filters: { ...NO_FILTERS, lane: "needs" } });
    expect(articles(out)).toHaveLength(2);
    expect(out).toContain(">Clear<");
    expect(out.match(/data-lane="(\w+)"/g)).toEqual(['data-lane="needs"']);
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
    const out = screen({ filters: { lane: "needs", repo: "acme/payments", ticket: "all" } });
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
      "You approve each one first.",
      "They run as you, with your own Claude settings: anything your Claude can do, they can do.",
      "They are told not to write to Jira and to send findings back to you, but that is a request, not a lock.",
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

  it("shows why the runs could not be read, with Try again, and keeps what it had", () => {
    const out = screen({ status: "error", error: "runs_list failed: database is locked" });
    expect(out).toContain("load your agents");
    expect(out).toContain("database is locked");
    expect(out).toContain("Try again");
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
  const set = (runs: Run[], seen: string[] = []) => {
    const initial = useRuns.getInitialState();
    initial.runs = runs;
    (initial as { seenFailed: ReadonlySet<string> }).seenFailed = new Set(seen);
  };
  const agents = (out: string) => /<button[^>]*aria-label="(Agents[^"]*)"[^>]*>(.*?)<\/button>/s.exec(out)!;

  it("puts the count in the button's label and shows it as a badge", () => {
    set(eight());
    const [, label, inner] = agents(renderToStaticMarkup(<Rail />));
    expect(label).toBe("Agents, 3 need you");
    expect(inner).toContain(">3<");
    expect(inner).toContain("bg-ws-pip");
  });

  it("counts a failed run only until it has been seen", () => {
    set(eight(), [eight().find((r) => r.state === "failed")!.id]);
    expect(agents(renderToStaticMarkup(<Rail />))[1]).toBe("Agents, 2 need you");
  });

  it("says needs for one and drops the badge at zero", () => {
    set([run("needsAnswer")]);
    expect(agents(renderToStaticMarkup(<Rail />))[1]).toBe("Agents, 1 needs you");
    set([run("working"), run("working", { id: "quiet", lastProgressAt: iso(300) }), run("done", { id: "d" })]);
    const [, label, inner] = agents(renderToStaticMarkup(<Rail />));
    expect(label).toBe("Agents");
    expect(inner).not.toContain("bg-ws-pip");
    set([]);
  });

  it("sits beside Activity in the bottom group", () => {
    set([]);
    const out = renderToStaticMarkup(<Rail />);
    expect(out.indexOf('aria-label="Activity"')).toBeLessThan(out.indexOf('aria-label="Agents"'));
    expect(out.indexOf('aria-label="Agents"')).toBeLessThan(out.indexOf('aria-label="Settings"'));
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
