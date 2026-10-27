import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { ActivityView } from "./ActivityView";
import { NeedsYouList } from "./NeedsYou";
import { Launcher } from "./PipExtras";
import { Rail } from "./Rail";
import { useActivity } from "./activityStore";
import { composerFooter } from "./workViewLogic";
import { useRuns } from "./runsStore";
import { currentNeeds, needsYouText } from "./useNeeds";

vi.mock("./useNow", () => ({ useNow: () => Date.parse("2026-09-30T12:00:00Z") }));

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });
const base = new MockBackend().runs.list()[0];
const run = (id: string, state: Run["state"], kind: Run["spec"]["role"], minutesAgo: number, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  state,
  item: ref("CA-401"),
  spec: { ...base.spec, role: kind, workstream: null },
  failure: null,
  needs: null,
  queuedAt: ago(minutesAgo),
  lastProgressAt: ago(minutesAgo),
  endedAt: state === "working" ? null : ago(minutesAgo),
  ...over,
});

const planDraft = (runId: string): Proposal =>
  ({
    id: "d-plan",
    createdAt: ago(3),
    updatedAt: ago(3),
    origin: { type: "run", runId, shortId: null, workstream: null },
    createdBy: "agent",
    intent: { type: "rewrite", item: ref("CA-401"), title: null, body: { from: docFromText("a"), to: docFromText("b"), fromText: "a", toText: "b" }, flattened: [] } as unknown as Intent,
    label: null,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
  }) as unknown as Proposal;

/** Server rendering reads a store's initial state, so what a render should see is put into both. */
function seed(runs: Run[], proposals: Proposal[]) {
  const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));
  Object.assign(useRuns.getInitialState(), { runs, dismissed: new Set<string>() });
  useRuns.setState({ runs, dismissed: new Set<string>() });
  Object.assign(useWorkspace.getInitialState(), { proposals: byId });
  useWorkspace.setState({ proposals: byId });
}

afterEach(() => {
  seed([], []);
  Object.assign(useActivity.getInitialState(), { chip: "all", unread: 0, codeUnread: 0 });
});

describe("one count of what needs you", () => {
  const trust = { shortId: null, failure: { type: "untrustedFolder", path: "/work/shop" } } as const;
  const failures = [run("p1", "failed", "plan", 90, { ...trust, error: "untrusted" }), run("p2", "failed", "plan", 60, { ...trust, error: "untrusted" }), run("p3", "failed", "plan", 30, { ...trust, error: "untrusted" })];
  // Three plan runs failed for the same untrusted folder; a question, a plan a finished run drafted, and a finished build.
  const runs = [...failures, run("q", "needsAnswer", "triage", 20, { needs: "Which cache?" }), run("b", "done", "build", 10), run("pd", "done", "plan", 3)];

  it("is the same on the house badge, the Activity Your turn chip and list, the composer and the launcher", () => {
    seed(runs.filter((r) => r.state !== "failed"), [planDraft("pd")]);
    const list = currentNeeds();
    const n = list.length;
    expect(list.map((x) => x.kind).sort()).toEqual(["plan", "question"]);

    expect(renderToStaticMarkup(<Rail />)).toContain(`Agents, ${needsYouText(n)}`);

    Object.assign(useActivity.getInitialState(), { chip: "needsMe", unread: 28, codeUnread: 3 });
    const activity = renderToStaticMarkup(<ActivityView />);
    expect(activity).toMatch(new RegExp(`Your turn<span[^>]*>${n}</span>`));
    expect(activity).toMatch(new RegExp(`data-needs-you-count[^>]*>${n}<`));

    expect(renderToStaticMarkup(<NeedsYouList needs={list} />)).toMatch(new RegExp(`data-needs-you-count[^>]*>${n}<`));
    expect(Number(/(\d+) needs? you/.exec(composerFooter(runs, n, NOW))?.[1])).toBe(n);
    expect(renderToStaticMarkup(<Launcher needs={n} onOpen={() => {}} />)).toContain(`Ask Pip, ${needsYouText(n)}`);
  });

  it("counts the failures once, on the latest run, and drops them once a newer run has followed", () => {
    seed(failures, []);
    expect(currentNeeds().map((x) => [x.kind, x.runId])).toEqual([["failure", "p3"]]);
    expect(renderToStaticMarkup(<Rail />)).toContain("Agents, 1 thing needs you");
    seed([...failures, run("again", "working", "plan", 1)], []);
    expect(currentNeeds()).toEqual([]);
    expect(renderToStaticMarkup(<Rail />)).toContain('aria-label="Agents"');
  });
});
