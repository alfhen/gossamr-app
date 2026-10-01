import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { renderPrompt } from "../backend/mockRuns";
import type { AgentSettings, Preflight, Run, RunEvent, RunReview, RunSpec, RunState } from "../types";
import { AgentMenuView, TicketAgentRows } from "./AgentMenu";
import { AgentsIntro } from "./AgentsEmpty";
import { AgentsSettingsView, type CleanupOffer } from "./AgentsSettings";
import { RunSetupView, setupBlock, type SetupViewProps } from "./RunSetup";
import { RunSheetView, type RunSheetActions, type RunSheetViewProps } from "./RunSheet";
import { placesOf } from "./RunWhere";
import { offsetText } from "./RunTimeline";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const SETTINGS: AgentSettings = { maxRuns: 3, wallClockMinutes: 60, tokenCap: 3_000_000, terminal: "terminal" };
const seeded = () => new MockBackend().runs.list();

const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: 212_000, result: null, error: null, shortId: "1000a000", lastProgressAt: iso(1), queuedAt: iso(10), endedAt: null, ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), draftWithPip: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn() });

const sheet = (r: Run, over: Partial<RunSheetViewProps> = {}) =>
  renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="Retry failed payment webhooks" place={{ index: 2, total: 8 }} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} opened={false} on={actions()} {...over} />);

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("the run sheet, by state", () => {
  it("shows the exact command a permission prompt waits on with one way to answer it, and no Allow or Deny", () => {
    const html = sheet(run("needsPermission", { needs: "approve Bash: git push origin HEAD && echo 'done'" }));
    expect(html).toContain("Claude is asking permission");
    expect(html).toContain("git push origin HEAD &amp;&amp; echo &#x27;done&#x27;");
    expect(html).toContain('data-copy="git push origin HEAD &amp;&amp; echo &#x27;done&#x27;"');
    expect(buttons(html).filter((b) => b === "Open in Terminal")).toHaveLength(1);
    for (const word of ["Allow", "Deny", "Nudge", "Send answer", "don&#x27;t ask again"]) expect(html).not.toContain(word);
    expect(html).toContain("Gossamr can&#x27;t answer for you");
  });

  it("shows a question as text with Open in Terminal and no answer box", () => {
    const html = sheet(run("needsAnswer", { needs: "Should the refund path keep the old rounding?" }));
    expect(html).toContain("Claude is asking you");
    expect(html).toContain("Should the refund path keep the old rounding?");
    expect(html).not.toContain("<textarea");
    expect(buttons(html)).toContain("Open in Terminal");
  });

  it("says Claude needs a sign-in, with no question to answer", () => {
    const html = sheet(run("systemBlocked"));
    expect(html).toContain("Claude needs you to sign in");
    expect(html).not.toContain("Claude is asking you");
    expect(buttons(html)).toContain("Open in Terminal");
  });

  it("sends an unclear state to Terminal", () => {
    const html = sheet(run("unknown", { lastDetail: "This session isn't listed any more" }));
    expect(html).toContain("Open in Terminal to look");
    expect(html).toContain("This session isn&#x27;t listed any more");
  });

  it("shows quiet as a chip beside the facts, not as a banner", () => {
    const html = sheet(run("working", { lastProgressAt: iso(40) }));
    expect(html).toContain("Quiet for 40 min");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/stuck/i);
    expect(sheet(run("working", { lastProgressAt: iso(29) }))).not.toContain("Quiet for");
  });

  describe("a failed launch the person can fix", () => {
    const failures = () => new MockBackend({ runs: { seed: "failures" } }).runs.list();
    const failedOf = (type: string) => failures().find((r) => r.failure?.type === type)!;
    const disabled = (html: string, label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>)[\\s\\S])*${label}</button>`).test(html);

    it("walks through trusting a folder: explanation, one main button, the command to copy, and Retry that waits", () => {
      const html = sheet(failedOf("untrustedFolder"));
      expect(html).toContain("Claude asks you once per folder before it will work there.");
      expect(html).toContain("hasn&#x27;t been trusted in /Users/sample/Code/storefront yet");
      expect(html).toContain("Gossamr doesn&#x27;t change Claude&#x27;s settings for you.");
      expect(buttons(html).filter((b) => !b.startsWith("Copy") && !b.startsWith("×") && !/^[⤢⤡]/.test(b))).toEqual(expect.arrayContaining(["Trust this folder in Terminal", "Retry"]));
      expect(html).toContain("data-copy=\"cd &#x27;/Users/sample/Code/storefront&#x27; &amp;&amp; claude\"");
      expect(disabled(html, "Retry")).toBe(true);
      expect(html).toContain("What Gossamr recorded");
      expect(html).toContain("accept the trust prompt");
    });

    it("lets Retry through once Terminal was opened", () => {
      const html = sheet(failedOf("untrustedFolder"), { opened: true });
      expect(disabled(html, "Retry")).toBe(false);
    });

    it("quotes a folder with a single quote or a space so the copied command still works", () => {
      const html = sheet({ ...failedOf("untrustedFolder"), failure: { type: "untrustedFolder", path: "/Users/me/It's mine/repo" } });
      expect(html).toContain("cd &#x27;/Users/me/It&#x27;\\&#x27;&#x27;s mine/repo&#x27; &amp;&amp; claude");
    });

    it("tells a signed-out run to open Terminal and type /login", () => {
      const html = sheet(failedOf("notSignedIn"));
      expect(buttons(html)).toContain("Open Terminal to sign in");
      expect(html).toContain("Type /login");
      expect(html).toContain('data-copy="claude"');
      expect(disabled(html, "Retry")).toBe(true);
    });

    it("links a missing Claude to the install page, shows the install command, and keeps Retry open", () => {
      const html = sheet(failedOf("claudeMissing"));
      expect(buttons(html)).toContain("Open the install page");
      expect(html).toContain("curl -fsSL https://claude.ai/install.sh | bash");
      expect(disabled(html, "Retry")).toBe(false);
    });

    it("points a missing clone at starting the agent again with a clone chosen", () => {
      const html = sheet(failedOf("noClone"));
      expect(buttons(html)).toContain("Start it again and choose a clone");
      expect(html).toContain("choose a clone of acme/storefront");
      expect(html).not.toContain("Or run this");
    });

    it("explains the limit when the cap was reached and has only Retry", () => {
      const html = sheet(failedOf("capReached"));
      expect(html).toContain("Too many agents are running at once.");
      expect(html).toContain("3 agents are already running");
      expect(buttons(html).filter((b) => b === "Retry")).toHaveLength(1);
      expect(buttons(html)).not.toContain("Start it again and choose a clone");
    });

    it("wires the buttons to the actions", () => {
      const on = actions();
      const html = sheet(failedOf("untrustedFolder"), { opened: true, on });
      expect(html).toContain("Retry");
      expect(on.fix).not.toHaveBeenCalled();
    });
  });

  it("explains a failed launch and offers Retry launch only when there was no session", () => {
    const failed = sheet(run("failed", { shortId: null, error: "Workspace not trusted: open Terminal in this folder, accept the trust prompt, then retry." }));
    expect(failed).toContain("It didn&#x27;t start");
    expect(failed).toContain("Workspace not trusted");
    expect(buttons(failed)).toContain("Retry launch");
    const died = sheet(run("failed", { error: "The agent process ended unexpectedly" }));
    expect(died).toContain("The run stopped without finishing");
    expect(buttons(died)).not.toContain("Retry launch");
  });

  it("shows the result of a finished run with a way to copy it", () => {
    const html = sheet(run("done", { result: "The lag comes from one consumer.\n\nFor Jira: add a backoff.", endedAt: iso(5) }));
    expect(html).toContain("What it found");
    expect(html).toContain("The lag comes from one consumer.");
    expect(html).toContain('data-copy="The lag comes from one consumer.');
    expect(html).toContain("Nothing is posted until you approve a draft");
  });

  it("offers Start now for a queued run, and no Stop", () => {
    const html = sheet(run("queued", { shortId: null }));
    expect(buttons(html)).toContain("Start now");
    expect(buttons(html)).not.toContain("Stop");
    expect(html).toContain("Waiting to start");
  });
});

describe("Stop in the run sheet", () => {
  it("is disabled while the run launches and says so", () => {
    const html = sheet(run("launching", { shortId: null }));
    expect(disabled(html, "Launching…")).toBe(true);
    expect(attrsOf(html, "Launching…")).toContain("You can stop it once it&#x27;s working");
  });

  it("is enabled while working, and asks before stopping", () => {
    expect(disabled(sheet(run("working")), "Stop")).toBe(false);
    const asking = sheet(run("working"), { confirmStop: true });
    expect(asking).toContain("Stop this agent?");
    expect(buttons(asking)).toEqual(expect.arrayContaining(["Yes, stop", "Keep going"]));
  });

  it("is not shown once the run has ended", () => {
    for (const s of ["done", "stopped", "failed"] as const) expect(buttons(sheet(run(s)))).not.toContain("Stop");
  });
});

describe("where a run lives", () => {
  it("copies the worktree, the clone and the branch exactly", () => {
    const r = run("working", { branch: null, expectedWorktree: "/Users/sample/Code/storefront/.claude/worktrees/ca-1-fix-ab12", spec: { ...seeded()[0].spec, name: "ca-1-fix-ab12", clonePath: "/Users/sample/Code/storefront" } });
    expect(placesOf(r).map((p) => p.value)).toEqual(["/Users/sample/Code/storefront/.claude/worktrees/ca-1-fix-ab12", "/Users/sample/Code/storefront", "worktree-ca-1-fix-ab12"]);
    const html = sheet(r);
    for (const p of placesOf(r)) expect(html).toContain(`data-copy="${p.value}"`);
  });

  it("shows the size of the session files once it is known", () => {
    expect(sheet(run("working"), { disk: 3 * 1024 ** 3 })).toContain("take up 3 GB");
    expect(sheet(run("working"), { disk: "unknown" })).toContain("couldn&#x27;t be read");
    expect(sheet(run("working"), { disk: null })).not.toContain("take up");
  });
});

describe("what it did", () => {
  const events: RunEvent[] = [
    { runId: "r", seq: 1, at: iso(10), kind: "start", text: "Created the worktree", detail: "git worktree add /x" },
    { runId: "r", seq: 2, at: iso(4), kind: "ask", text: "Wants to run a command", detail: null },
  ];

  it("lists the lines with the minutes since the first and a way to open the ones with detail", () => {
    const html = sheet(run("working"), { events });
    expect(html).toContain("Created the worktree");
    expect(html).toContain("+6m");
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1);
    expect(html).not.toContain("git worktree add /x");
  });

  it("says when nothing was recorded, and while it loads", () => {
    expect(sheet(run("done"), { events: [] })).toContain("Nothing recorded yet.");
    expect(sheet(run("done"), { events: null })).toContain("Loading what it did…");
  });

  it("writes the offset in minutes, then hours", () => {
    expect(offsetText(iso(0), iso(0))).toBe("+0m");
    expect(offsetText(iso(0), iso(95))).toBe("+1h 35m");
  });
});

describe("the brief as it was sent", () => {
  it("is read when opened and shows the same prompt parts as the setup sheet", () => {
    const spec: RunSpec = { ...seeded()[0].spec, focus: "Look at the retry loop.", ticketBlock: "CA-1: t" };
    const brief: RunReview = { digest: "abc", prompt: renderPrompt(spec), instruction: spec.instruction, focus: spec.focus ?? null, ticketBlock: spec.ticketBlock ?? null, guard: "GUARD TEXT", spec };
    const html = sheet(run("working"), { brief });
    expect(html).toContain("Focus · written by Pip");
    expect(html).toContain("GUARD TEXT");
    expect(html).toContain("What you approved:");
    expect(sheet(run("working"), { brief: "loading" })).toContain("Loading…");
  });
});

const ok: Preflight = { rows: [{ level: "green", text: "Claude Code 2.1.286" }, { level: "amber", text: "Clone is dirty" }], blocking: false };

const reviewOf = (over: Partial<RunSpec> = {}): RunReview => {
  const spec: RunSpec = { ...seeded()[0].spec, name: "ca-401-fix-ab12", ...over };
  return { digest: "mock-1", prompt: renderPrompt(spec), instruction: spec.instruction, focus: spec.focus ?? null, ticketBlock: spec.ticketBlock ?? null, guard: "GUARD TEXT", spec };
};

const setup = (over: Partial<SetupViewProps> = {}) => {
  const review = over.review === undefined ? reviewOf() : over.review;
  const props: SetupViewProps = {
    item: itemRef("CA-401"),
    ticketTitle: "Welcome flow refresh",
    kind: "investigate",
    repo: "acme/storefront",
    repos: ["acme/storefront", "acme/payments"],
    shortage: null,
    reposError: null,
    repoEditable: true,
    choice: { clones: [{ path: "/Users/sample/Code/storefront", branch: "main", dirty: false, defaultBranch: "main" }], picked: null, fresh: null },
    review,
    preflight: ok,
    phase: "ready",
    busy: false,
    error: null,
    cloning: false,
    cloneError: null,
    changed: false,
    fromPip: false,
    instruction: review?.instruction ?? "",
    onInstruction: vi.fn(),
    base: "main",
    onBase: vi.fn(),
    wide: false,
    onWide: vi.fn(),
    on: { close: vi.fn(), discard: vi.fn(), start: vi.fn(), chooseRepo: vi.fn(), chooseClone: vi.fn(), cloneFresh: vi.fn(), retryRepos: vi.fn(), openSettings: vi.fn(), dismissChanged: vi.fn(), commit: vi.fn() },
    ...over,
  };
  return renderToStaticMarkup(<RunSetupView {...props} />);
};

/** The attributes of the button whose label is `label`. */
const attrsOf = (html: string, label: string) => new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*?${label}</button>`).exec(html)?.[1];
const disabled = (html: string, label: string) => {
  const attrs = attrsOf(html, label);
  expect(attrs, `a "${label}" button`).toBeDefined();
  return /disabled=""/.test(attrs!);
};

describe("the setup sheet", () => {
  it("shows the prompt as the backend rendered it, in labelled parts", () => {
    const review = reviewOf({ focus: "Look at the retry loop.", ticketBlock: "CA-401: Welcome flow refresh\n\nBody text" });
    const html = setup({ review });
    expect(html).toContain("Which branch it starts from");
    expect(html).toContain("What to do (you can edit this)");
    expect(html).toContain("Ticket text from Jira");
    expect(html).toContain("Show the whole prompt as one piece");
    expect(html).toContain('data-copy="' + review.prompt.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '"');
  });

  it("shows Pip's focus note in a box of its own, labelled as Pip's, apart from the instruction", () => {
    const html = setup({ review: reviewOf({ focus: "Look at the retry loop.", focusFromRun: "run-9" }), fromPip: true });
    expect(html).toContain('aria-label="Focus note from Pip"');
    expect(html).toContain("Focus · written by Pip");
    expect(html).toContain("Written after reading the output of run run-9");
    expect(html).toContain("Sent apart from the instruction, as data, not instructions. 23 of 300 characters.");
    expect(html).toContain("Proposed by Pip");
    const textarea = /<textarea[\s\S]*?<\/textarea>/.exec(html)![0];
    expect(textarea).not.toContain("Look at the retry loop.");
    expect(setup({ review: reviewOf() })).not.toContain("Focus · written by Pip");
  });

  it("turns Start off, with the red row as the reason, and leaves it on for amber rows", () => {
    expect(disabled(setup(), "Start agent")).toBe(false);
    const red: Preflight = { rows: [{ level: "red", text: "3 agents are running, the most Gossamr starts at once (3)." }], blocking: true };
    const html = setup({ preflight: red });
    expect(disabled(html, "Start agent")).toBe(true);
    expect(html).toContain("3 agents are running, the most Gossamr starts at once (3).");
    expect(html).toContain("Blocks starting");
  });

  it("says plainly when there is no clone, and turns Start off", () => {
    const html = setup({ choice: { clones: [], picked: null, fresh: null }, review: null, preflight: null });
    expect(html).toContain("No clone of acme/storefront found");
    expect(html).toContain("~/Code, ~/Developer and ~/src");
    expect(disabled(html, "Start agent")).toBe(true);
  });

  describe("with no clone, the fresh copy", () => {
    const fresh = { path: "/Users/sample/Gossamr/agents/acme/storefront", command: "git clone https://github.com/acme/storefront.git /Users/sample/Gossamr/agents/acme/storefront", ghFallback: true, occupied: false };
    const none = (over: Partial<SetupViewProps> = {}, f = fresh) => setup({ choice: { clones: [], picked: null, fresh: f }, review: null, preflight: null, ...over });

    it("shows the folder and the exact command before anything is cloned", () => {
      const html = none();
      expect(html).toContain("Or use a fresh copy in ~/Gossamr/agents/acme/storefront");
      expect(html).toContain('data-copy="git clone https://github.com/acme/storefront.git /Users/sample/Gossamr/agents/acme/storefront"');
      expect(html).toContain("the repository&#x27;s own hooks don&#x27;t run");
      expect(html).toContain("gh repo clone");
      expect(html).toContain("trust the folder once, in Terminal");
      expect(disabled(html, "Clone into ~/Gossamr/agents/acme/storefront")).toBe(false);
      expect(disabled(html, "Start agent")).toBe(true);
    });

    it("leaves out the gh sentence when gh isn't there, and the whole offer when there is none", () => {
      expect(none({}, { ...fresh, ghFallback: false })).not.toContain("gh repo clone");
      expect(setup({ choice: { clones: [], picked: null, fresh: null }, review: null, preflight: null })).not.toContain("fresh copy");
    });

    it("says so when something else is in the way, and offers no clone", () => {
      const html = none({}, { ...fresh, occupied: true });
      expect(html).toContain("isn&#x27;t a clone of acme/storefront");
      expect(html).not.toContain("git clone https");
      expect(disabled(html, "Clone into ~/Gossamr/agents/acme/storefront")).toBe(true);
    });

    it("shows progress and, on failure, the reason and the command that usually fixes sign-in", () => {
      expect(disabled(none({ cloning: true }), "Cloning…")).toBe(true);
      const html = none({ cloneError: "Git couldn't sign in to GitHub: terminal prompts disabled" });
      expect(html).toContain('role="alert"');
      expect(html).toContain("terminal prompts disabled");
      expect(html).toContain('data-copy="gh auth setup-git"');
    });
  });

  it("asks which repository when none is chosen", () => {
    const html = setup({ repo: null, review: null, choice: null, preflight: null });
    expect(html).toContain("Choose a repository…");
    expect(html).toContain("Choose a repository first");
  });

  it("shows only Investigate as available, the others as coming later", () => {
    const html = setup();
    expect(html.match(/Coming later/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html.match(/<button[^>]*disabled=""[^>]*title="Coming later"/g)).toHaveLength(4);
  });

  it("asks for a second look when the draft changed, and holds Start until it is read", () => {
    const html = setup({ changed: true });
    expect(html).toContain("This draft changed. Read it again.");
    expect(disabled(html, "Start agent")).toBe(true);
    expect(html).toContain("I&#x27;ve read it");
  });

  it("shows what happens on Start and the exact command, with every part quoted", () => {
    const html = setup();
    expect(html).toContain("What happens when you press Start");
    expect(html).toContain("Show the exact command");
    expect(html).toContain("claude --bg --name &#x27;CA-401 investigate&#x27; --worktree &#x27;ca-401-fix-ab12&#x27;");
    expect(html).toContain("Starts right away. You can stop it once it&#x27;s working.");
  });

  it("names the branch the run will use", () => {
    expect(setup()).toContain("worktree-ca-401-fix-ab12");
  });
});

describe("what ⌘↵ may start", () => {
  const props = (over: Partial<SetupViewProps> = {}) => {
    const review = reviewOf();
    return { review, preflight: ok, phase: "ready" as const, busy: false, changed: false, choice: null, repo: "acme/storefront", instruction: review.instruction, base: "main", ...over };
  };

  it("is nothing while the checks have a red row, so the shortcut cannot get past a disabled button", () => {
    const red: Preflight = { rows: [{ level: "red", text: "Not signed in to Claude." }], blocking: true };
    expect(setupBlock(props({ preflight: red }))).toBe("Not signed in to Claude.");
    expect(setupBlock(props())).toBeNull();
  });

  it("is nothing for a cleared instruction, an unread change or a draft that is still being made", () => {
    expect(setupBlock(props({ instruction: "" }))).toMatch(/Write/);
    expect(setupBlock(props({ changed: true }))).toMatch(/change/);
    expect(setupBlock(props({ review: null, phase: "preparing" }))).toMatch(/ready/);
  });
});

describe("the honest wording", () => {
  const phrases = ["run as you", "not a lock"];

  it("is in the setup sheet, with what the agent receives", () => {
    const html = setup();
    for (const p of [...phrases, "exactly what the agent receives"]) expect(html).toContain(p);
    expect(html).toContain("This is a request to the model, not a block.");
  });

  it("is in the first-run text", () => {
    const html = renderToStaticMarkup(<AgentsIntro onDismiss={vi.fn()} />);
    for (const p of phrases) expect(html).toContain(p);
  });

  it("is in the safety sheet, with the list of what an agent may touch", () => {
    const html = renderToStaticMarkup(<AgentsSettingsView runs={seeded()} stopping={false} keepRunning={3} settings={SETTINGS} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    for (const p of [...phrases, "exactly what the agent receives", "Nothing enforces that", "Gossamr adds no fence of its own"]) expect(html).toContain(p);
    expect(html).not.toMatch(/never write to jira|can&#x27;t write to jira/i);
  });
});

describe("safety and settings", () => {
  it("counts what Stop all reaches and what keeps running after a quit", () => {
    const html = renderToStaticMarkup(<AgentsSettingsView runs={seeded()} stopping={false} keepRunning={3} settings={SETTINGS} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("Stop all (5)");
    expect(html).toContain("3 agents keep running if you quit Gossamr or sign out.");
    expect(html).toContain("Agents running at once");
    expect(html).not.toContain("This is fixed for now");
  });

  it("shows the limits as fields and says how far a token limit can be overshot", () => {
    const html = renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={{ ...SETTINGS, wallClockMinutes: 45, tokenCap: 2_500_000, terminal: "iTerm" }} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    expect(html).toMatch(/aria-label="Stop a run after this many minutes"[^>]*value="45"/);
    expect(html).toMatch(/aria-label="Stop a run after this many million tokens"[^>]*value="2.5"/);
    expect(html).toMatch(/<option value="iTerm" selected/);
    expect(html).toContain("a run can pass its limit by a poll and a turn before it stops");
  });

  it("holds the fields while a save is under way so a second one can't send stale values", () => {
    const view = (settingsSaving: boolean) => renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={SETTINGS} settingsSaving={settingsSaving} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    const fields = (html: string) => [...html.matchAll(/<(?:input|select)[^>]*aria-label="(?:Stop a run|Agents running|Terminal app)[^>]*>/g)].map((m) => /disabled/.test(m[0]));
    expect(fields(view(false))).toEqual([false, false, false, false]);
    expect(fields(view(true))).toEqual([true, true, true, true]);
  });

  it("waits for the backend's answer before showing fields", () => {
    const html = renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={null} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    expect(html).not.toContain("Agents running at once");
  });

  it("offers Clean up finished runs only when there is something to offer, and shows what the last one did", () => {
    const view = (cleanup: CleanupOffer | null) => renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={SETTINGS} cleanup={cleanup} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    expect(buttons(view(null))).not.toContain("Clean up finished runs (2)");
    const html = view({ count: 2, reason: "Some ended more than 14 days ago.", report: "Removed 1 worktree. 1 kept: unpushed", busy: false });
    expect(buttons(html)).toContain("Clean up finished runs (2)");
    expect(html).toContain("claude rm");
    expect(html).toContain("Removed 1 worktree. 1 kept: unpushed");
  });

  it("turns Stop all off when nothing is running", () => {
    const html = renderToStaticMarkup(<AgentsSettingsView runs={[run("done")]} stopping={false} keepRunning={0} settings={SETTINGS} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);
    expect(disabled(html, "Stop all")).toBe(true);
  });
});

describe("the Agent menu on a ticket", () => {
  it("offers Investigate, and says you approve before anything starts", () => {
    const html = renderToStaticMarkup(<AgentMenuView ticketKey="CA-401" open onOpen={vi.fn()} onInvestigate={vi.fn()} />);
    expect(html).toContain('role="menu"');
    expect(html).toContain("Investigate this ticket");
    expect(html).toContain("approve before anything starts");
    for (const hidden of ["Build", "Review the PR", "Verify", "Triage"]) expect(html).not.toContain(hidden);
    expect(renderToStaticMarkup(<AgentMenuView ticketKey="CA-401" open={false} onOpen={vi.fn()} onInvestigate={vi.fn()} />)).not.toContain('role="menu"');
  });

  it("lists the runs on the ticket and opens one", () => {
    const html = renderToStaticMarkup(<TicketAgentRows runs={[run("working", { lastDetail: "Reading the cart module" })]} now={NOW} title="A ticket" onOpen={vi.fn()} />);
    expect(html).toContain("A ticket");
    expect(html).toContain("Reading the cart module");
    expect(renderToStaticMarkup(<TicketAgentRows runs={[]} now={NOW} title={null} onOpen={vi.fn()} />)).toContain("None yet");
  });
});
