import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { READ_ONLY_GUARD, readOnlyRules } from "../backend/mockRunKinds";
import { renderPrompt } from "../backend/mockRuns";
import type { Preflight, Run, RunReview, RunSpec } from "../types";
import { AgentCard } from "./AgentCard";
import { CLOSED_INLINE, InlineStartView, type InlineActions } from "./InlineStart";
import { RunSetupView, type SetupViewProps } from "./RunSetup";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { AgentRow } from "./AgentRow";
import { COPY, MAY_TOUCH_READ_ONLY, READ_ONLY_STEPS } from "./runSheetLogic";

// What the person is shown of the restriction Claude Code enforces on a read-only kind: the headline and the note where an
// agent is started, the exact flags and rules in "What Gossamr adds for the model", the badge on the card, and the rules a
// run was launched with in its brief. A Build shows none of it and keeps the "request, not a lock" copy.

const NOW = Date.parse("2026-09-30T12:00:00Z");
const seeded = () => new MockBackend().runs.list();
const ok: Preflight = { rows: [{ level: "green", text: "Claude Code 2.1.286" }], blocking: false };
/** Text as the static markup escapes it. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const reviewOf = (over: Partial<RunSpec> = {}): RunReview => {
  const spec: RunSpec = { ...seeded()[0].spec, name: "ca-401-fix-ab12", ...over };
  return { digest: "mock-1", prompt: renderPrompt(spec), instruction: spec.instruction, focus: spec.focus ?? null, ticketBlock: spec.ticketBlock ?? null, guard: "GUARD TEXT", spec, readOnly: readOnlyRules(spec) };
};

const setup = (review: RunReview) => {
  const props: SetupViewProps = {
    item: itemRef("CA-401"),
    ticketTitle: "Welcome flow refresh",
    kind: review.spec.kind,
    kindEditable: true,
    pr: null,
    prs: { status: "idle", query: "", choices: [], error: null },
    repo: "acme/storefront",
    repos: ["acme/storefront"],
    shortage: null,
    reposError: null,
    repoEditable: true,
    ticketless: false,
    project: null,
    projects: [],
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
    instruction: review.instruction,
    onInstruction: vi.fn(),
    base: "main",
    onBase: vi.fn(),
    wide: false,
    onWide: vi.fn(),
    on: { close: vi.fn(), discard: vi.fn(), start: vi.fn(), chooseRepo: vi.fn(), chooseClone: vi.fn(), cloneFresh: vi.fn(), retryRepos: vi.fn(), openSettings: vi.fn(), dismissChanged: vi.fn(), commit: vi.fn(), chooseKind: vi.fn(), chooseProject: vi.fn(), searchPrs: vi.fn(), choosePr: vi.fn(), setAllowPush: vi.fn() },
  };
  return renderToStaticMarkup(<RunSetupView {...props} />);
};

const inline = (review: RunReview) => {
  const on: InlineActions = { shown: vi.fn(), dismissChanged: vi.fn(), start: vi.fn(), recheck: vi.fn(), trustFolder: vi.fn(), close: vi.fn() };
  return renderToStaticMarkup(<InlineStartView id="p-1" entry={{ ...CLOSED_INLINE, phase: "shown", review, preflight: ok, displayed: review.digest }} on={on} />);
};

const run = (over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: "r-1", state: "working", needs: null, error: null, result: null, endedAt: null, ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), loadBrief: vi.fn(), draftComment: vi.fn(), askPip: vi.fn(), openDraft: vi.fn(), pickBlocker: vi.fn(), cancelBlocker: vi.fn(), draftBlocker: vi.fn(), openChange: vi.fn(), draftTicket: vi.fn(), openTicketDraft: vi.fn(), finishWithPip: vi.fn(), openCreated: vi.fn(), askPipBreakdown: vi.fn(), buildFromPlan: vi.fn(), draftPlanComment: vi.fn(), openPlanDraft: vi.fn(), reviewThis: vi.fn() });

const sheet = (r: Run, brief: RunReview) =>
  renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="Welcome flow refresh" place={{ index: 1, total: 1 }} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={brief} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} />);

const card = (r: Run) => renderToStaticMarkup(<AgentCard run={r} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

/** The rules listed under `attr`, one per list item. */
const listed = (html: string, attr: string) => {
  const list = new RegExp(`<ul ${attr}[^>]*>([\\s\\S]*?)</ul>`).exec(html)?.[1] ?? "";
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
};

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("a read-only kind where it is started", () => {
  const investigate = reviewOf({ kind: "investigate" });
  const build = reviewOf({ kind: "build" });

  for (const [where, render] of [
    ["the setup sheet", setup],
    ["the inline review on Pip home", inline],
  ] as const) {
    describe(where, () => {
      it("shows the headline, the note, the exact flag, the rules and the guard line for an Investigate", () => {
        const html = render(investigate);
        expect(html).toContain("data-read-only");
        expect(html).toContain(COPY.readOnly);
        expect(html).toContain(esc(COPY.readOnlyNote));
        expect(html).toContain("--permission-mode dontAsk");
        expect(listed(html, "data-read-only-rules")).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git push *)"]));
        expect(listed(html, "data-read-only-allow")).toEqual(["Bash(git fetch origin main)", "Bash(git checkout --detach origin/main)"]);
        expect(html).toContain(esc(READ_ONLY_GUARD));
        expect(html).not.toContain(COPY.notALock);
        expect(html).toContain("--setting-sources &#x27;&#x27;");
        expect(html).toContain("--strict-mcp-config");
        // An Investigate runs no tests, so neither the headline nor the note mentions them.
        expect(html).not.toContain(COPY.readOnlyTests);
        expect(html).not.toContain(esc(COPY.readOnlyTestsNote));
        // Its run-as-you line is the read-only one: it doesn't run with the person's settings.
        expect(html).toContain(esc(COPY.runAsYouReadOnly));
        expect(html).not.toContain(esc(COPY.runAsYou));
      });

      it("says a Review or Verify runs the repository's tests, whose code can write, instead of promising no writes", () => {
        for (const kind of ["review", "verify"] as const) {
          const html = render(reviewOf({ kind, pr: kind === "review" ? 12 : null }));
          expect(html).toContain(esc(COPY.readOnlyTests));
          expect(html).toContain(esc(COPY.readOnlyTestsNote));
          expect(html).not.toContain(`${COPY.readOnly}<`);
        }
      });

      it("lists the read-only rules before the report tool's, the order the guard lines are sent in", () => {
        const html = render(reviewOf({ kind: "investigate", report: true }));
        const withReport = { ...reviewOf({ kind: "investigate", report: true }), report: { allowed: "mcp__run-report__report_result", guard: "REPORT LINE" } };
        const shown = render(withReport);
        expect(html).toContain("data-read-only-extras");
        expect(shown.indexOf("data-read-only-extras")).toBeLessThan(shown.indexOf("data-report-extras"));
      });

      it("shows none of it for a Build, and the request-not-a-lock copy as before", () => {
        const html = render(build);
        expect(build.readOnly).toBeNull();
        expect(html).not.toContain("data-read-only");
        expect(html).not.toContain(COPY.readOnly);
        expect(html).not.toContain("--permission-mode");
        expect(html).not.toContain(esc(READ_ONLY_GUARD));
        expect(html).toContain(COPY.notALock);
      });
    });
  }

  it("lists a review's pull request head and test runners among the allowed commands", () => {
    const html = setup(reviewOf({ kind: "review", pr: 512, prSha: "abc1234" }));
    expect(listed(html, "data-read-only-allow")).toEqual(expect.arrayContaining(["Bash(git fetch origin pull/512/head)", "Bash(git checkout --detach abc1234)", "Bash(cargo test)"]));
  });
});

describe("the setup sheet's exact command", () => {
  it("carries the read-only flags and guard sentence for an Investigate, and none for a Build", () => {
    const investigate = setup(reviewOf({ kind: "investigate" }));
    const command = /<pre[^>]*>(cd [\s\S]*?)<\/pre>/.exec(investigate)?.[1] ?? /(cd &#x27;[\s\S]*?)<\/(?:pre|code|div)>/.exec(investigate)?.[1] ?? "";
    expect(command).toContain("--permission-mode &#x27;dontAsk&#x27; --setting-sources &#x27;&#x27; --strict-mcp-config --allowedTools");
    expect(command).toContain("--disallowedTools");
    expect(command).toContain(esc(READ_ONLY_GUARD));
    const build = setup(reviewOf({ kind: "build" }));
    expect(build).not.toContain("--permission-mode");
  });

  it("tells the read-only steps of starting, which never stop for a permission prompt", () => {
    expect(setup(reviewOf({ kind: "investigate" }))).toContain(esc(READ_ONLY_STEPS[1]));
    expect(setup(reviewOf({ kind: "build" }))).not.toContain(esc(READ_ONLY_STEPS[1]));
  });
});

describe("a run's sheet and card", () => {
  const brief = reviewOf({ kind: "investigate" });

  it("lists the rules in the brief only when the run was launched with them", () => {
    const launched = sheet(run({ readOnly: brief.readOnly }), brief);
    expect(launched).toContain("data-read-only-extras");
    expect(listed(launched, "data-read-only-rules")).toContain("Bash(git push *)");
    expect(launched).toContain(COPY.readOnly);
    // A run launched before Phase 6 has no record of a restriction, whatever its brief would get today.
    const old = sheet(run({ readOnly: undefined }), brief);
    expect(old).not.toContain("data-read-only");
    expect(old).not.toContain("--permission-mode");
  });

  it("says on a read-only run's sheet that pushes are refused, not asked, and keeps the old list for a Build", () => {
    const restricted = sheet(run({ readOnly: brief.readOnly }), brief);
    for (const t of MAY_TOUCH_READ_ONLY) expect(restricted).toContain(esc(t.text));
    expect(restricted).not.toContain("the run stops under Needs you");
    const builder = sheet(run({ spec: { ...run().spec, kind: "build" }, readOnly: null }), reviewOf({ kind: "build" }));
    expect(builder).toContain("the run stops under Needs you");
  });

  it("shows only a shield in a list row, so the title keeps its room", () => {
    const html = renderToStaticMarkup(<AgentRow run={run({ readOnly: brief.readOnly })} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    const badge = /<span data-read-only="true"[^>]*>[\s\S]*?<\/span>/.exec(html)?.[0] ?? "";
    expect(badge).toContain('aria-label="Read-only"');
    expect(badge).not.toMatch(/>Read-only</);
    expect(html).toMatch(/class="min-w-\[6ch\] truncate font-semibold"/);
    expect(renderToStaticMarkup(<AgentRow run={run({ readOnly: undefined })} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />)).not.toContain("data-read-only");
  });

  it("puts the Read-only badge on a restricted run's card, not on a Build's or an old run's", () => {
    const restricted = card(run({ readOnly: brief.readOnly }));
    expect(restricted).toMatch(new RegExp(`<span data-read-only="true" title="${COPY.readOnly}"[^>]*>[\\s\\S]*?Read-only</span>`));
    const builder = run({ spec: { ...run().spec, kind: "build" }, readOnly: null });
    expect(card(builder)).not.toContain("data-read-only");
    expect(card(run({ readOnly: undefined }))).not.toContain("data-read-only");
  });
});
