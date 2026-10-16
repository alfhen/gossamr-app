import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { bodyChange, docFromMarkdown } from "../backend/mockMarkdown";
import { AUTOSTART_DEFAULTS, type Proposal, type Run, type WorkstreamView } from "../types";
import { useRuns } from "./runsStore";
import { useWorkstreams } from "./workstreamsStore";
import { DraftCard, draftSummary, draftTitle } from "./DraftCard";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";
import { ONLY_SPACING, changedPairs, diffSummary, diffWords, oneLine, rewriteBlocked, rewriteEdit, rewriteFields, RewriteView, startsBlock, takesBackendText, type Rewrite } from "./RewriteDiff";
import { diffLines } from "../lib/textDiff";
import { targetOf } from "../lib/proposals";

const OLD = "Retries back off.\n\nBackoff starts at two seconds.\n\nOpen question: who owns the alert?";
const NEW = "Retries back off and cap at five attempts.\n\nBackoff starts at two seconds.\n\n## Scope\n\n- In: webhooks\n- Out: queue replay";

const intent = (over: Partial<Rewrite> = {}): Rewrite => ({
  type: "rewrite",
  item: itemRef("DEVOPS-471"),
  title: { from: "Retry failed payment webhooks", to: "Retry failed payment webhooks with a cap" },
  body: bodyChange(docFromMarkdown(OLD), NEW),
  flattened: [],
  ...over,
});

const draft = (i: Rewrite = intent(), over: Partial<Proposal> = {}): Proposal => ({
  id: "w1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "r1" },
  createdBy: "pip",
  intent: i,
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const props = (p: Proposal) => ({ proposal: p, statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() });
/** The text of each line of `kind`, without the marks on its changed words. */
const lines = (html: string, kind: string) => [...html.matchAll(new RegExp(`data-line="${kind}"[^>]*>.*?<span class="min-w-0[^>]*>(?:<span class="sr-only">[^<]*</span>)?(.*?)</span></div>`, "g"))].map((m) => m[1].replace(/<[^>]+>/g, ""));
/** The card's text as a screen reader gets it, each line's hidden lead-in in brackets. */
const spoken = (html: string) => html.replace(/<span class="sr-only">([^<]*)<\/span>/g, "[$1]").replace(/<[^>]+>/g, "");

describe("a description edit draft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  it("is named for what it changes and the ticket it is about", () => {
    expect(draftTitle(draft())).toBe("Update the title and description of DEVOPS-471");
    expect(draftTitle(draft(intent({ title: null })))).toBe("Update the description of DEVOPS-471");
    expect(draftTitle(draft(intent({ body: null })))).toBe("Update the title of DEVOPS-471");
    expect(targetOf(intent())?.key).toBe("DEVOPS-471");
  });

  it("summarises the title change and how many lines of the description change", () => {
    expect(draftSummary(draft(), null)).toBe("Title: Retry failed payment webhooks → Retry failed payment webhooks with a cap; Description: 5 added, 2 removed");
    const preview = draftPreviewBody(draft(), null);
    expect(preview.split("\n")).toEqual(["Title: Retry failed payment webhooks → Retry failed payment webhooks with a cap", "Description: 5 added, 2 removed"]);
  });

  it("shows the old lines removed and the new ones added, for the title and the description", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft())} />);
    expect(html).toContain('data-diff="title"');
    expect(html).toContain('data-diff="description"');
    expect(lines(html, "del")).toEqual(["Retry failed payment webhooks", "Retries back off.", "Open question: who owns the alert?"]);
    expect(lines(html, "add")).toEqual(["Retry failed payment webhooks with a cap", "Retries back off and cap at five attempts.", "## Scope", "", "- In: webhooks", "- Out: queue replay"].map((t) => t || " "));
    expect(lines(html, "same")).toContain("Backoff starts at two seconds.");
    expect(html).toContain("Update title and description");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Skip<");
    expect(html).not.toContain("data-flattened");
  });

  it("tells a screen reader which lines were added, removed or left alone, apart from the visible markers", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft())} />);
    expect(spoken(html)).toContain("[Removed: ]Retries back off.");
    expect(spoken(html)).toContain("[Added: ]Retries back off and cap at five attempts.");
    expect(spoken(html)).toContain("[Unchanged: ]Backoff starts at two seconds.");
    expect(html.match(/<span aria-hidden="true" class="w-3[^>]*>[+−]<\/span>/g)?.length).toBeGreaterThan(0);
    expect(html).toMatch(/role="group" aria-label="description changes"/);
  });

  it("reads a block of lines of one kind once, and skips blank lines (G32)", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft())} />);
    // The title line, the reworded line and then "## Scope" with its blank line and two bullets: three blocks, each said once, the blank line hidden.
    expect(spoken(html)).toContain("[Added: ]## Scope");
    expect(spoken(html).match(/\[Added: \]/g)).toHaveLength(3);
    expect(html).toMatch(/data-line="add" aria-hidden="true"/);
    const rows = diffLines("a", "a\n\nb\nc");
    expect(rows.map((_, i) => startsBlock(rows, i))).toEqual([true, false, true, false]);
    expect(diffSummary(diffLines("a", "a\n\nb"), "description")).toBe("Description changes: 1 line added.");
  });

  it("shows only the part it changes", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft(intent({ title: null })))} />);
    expect(html).toContain('data-diff="description"');
    expect(html).not.toContain('data-diff="title"');
    expect(renderToStaticMarkup(<DraftCard {...props(draft(intent({ body: null })))} />)).not.toContain('data-diff="description"');
  });

  it("says what the old description holds that approving turns into plain text", () => {
    const html = renderToStaticMarkup(<DraftCard {...props(draft(intent({ flattened: ["images and attachments", "tables"] })))} />);
    expect(html).toContain("data-flattened");
    expect(html).toContain("The old description has images and attachments, tables.");
    expect(html).toContain("Jira keeps the old text in the ticket&#x27;s history");
    expect(renderToStaticMarkup(<DraftCard {...props(draft(intent({ body: null, flattened: ["tables"] })))} />)).not.toContain("data-flattened");
  });

  it("shows why the last approval was refused, and offers no approve once decided", () => {
    const refused = "DEVOPS-471 changed since this was drafted, so nothing was written. Skip this draft and ask Pip to draft it again from the current text.";
    const html = renderToStaticMarkup(<DraftCard {...props(draft(intent(), { error: refused }))} />);
    expect(html).toContain("nothing was written");
    expect(html).toContain('role="alert"');
    const done = renderToStaticMarkup(<DraftCard {...props(draft(intent(), { state: { type: "applied" } }))} />);
    expect(done).toContain("Done");
    expect(done).not.toContain("Update title and description");
    const retired = renderToStaticMarkup(<DraftCard {...props(draft(intent(), { state: { type: "retired", reason: "the ticket's text changed since this was drafted" } }))} />);
    expect(retired).toContain("the ticket&#x27;s text changed since this was drafted");
  });

  it("appears in the conversation with its change and where to review it", () => {
    const html = renderToStaticMarkup(<DraftPreview proposal={draft()} statusName={null} targetTitle="Retry failed payment webhooks" onOpen={() => {}} />);
    expect(html).toContain("Update the title and description of DEVOPS-471");
    expect(html).toContain("Description: 5 added, 2 removed");
    expect(html).toContain("Review on DEVOPS-471 →");
  });
});

describe("what the person's edit sends", () => {
  it("sends nothing when the text is as drafted, and only the parts that changed otherwise", () => {
    const i = intent();
    expect(rewriteEdit(i, i.title!.to, i.body!.toText)).toBeNull();
    expect(rewriteEdit(i, "My title", i.body!.toText)).toEqual({ type: "rewrite", title: "My title" });
    expect(rewriteEdit(i, i.title!.to, "My text")).toEqual({ type: "rewrite", body: "My text" });
    expect(rewriteEdit(i, "T", "B")).toEqual({ type: "rewrite", title: "T", body: "B" });
    expect(rewriteEdit(intent({ title: null }), "ignored", "B")).toEqual({ type: "rewrite", body: "B" });
  });

  it("blocks approval for a blank part or for text that matches the ticket as it is", () => {
    const i = intent();
    expect(rewriteBlocked(i, i.title!.to, i.body!.toText)).toBe(false);
    expect(rewriteBlocked(i, "  ", i.body!.toText)).toBe(true);
    expect(rewriteBlocked(i, i.title!.to, "\n ")).toBe(true);
    expect(rewriteBlocked(i, i.title!.from, i.body!.fromText)).toBe(true);
    expect(rewriteBlocked(i, i.title!.from, "changed")).toBe(false);
    expect(rewriteBlocked(intent({ body: null }), i.title!.from, "")).toBe(true);
  });

  it("compares a title as the backend will store it, so whitespace alone is not a change", () => {
    const same = intent({ body: null, title: { from: "A B", to: "A B and more" } });
    expect(rewriteBlocked(same, "A  B", "")).toBe(true);
    expect(rewriteBlocked(same, " A\tB\n", "")).toBe(true);
    expect(rewriteBlocked(same, "A  B  C", "")).toBe(false);
    expect(rewriteBlocked(same, " \t ", "")).toBe(true);
    expect(rewriteBlocked(intent({ body: null, title: { from: "A  B", to: "x" } }), "A  B", "")).toBe(false);
    expect(oneLine("  A \n  B\t C ")).toBe("A B C");
  });
});

describe("what the fields show after the backend saved the person's edit", () => {
  it("follows the backend's text while typing is not in the way, and during an approval, but not over unsaved typing", () => {
    expect(takesBackendText(false, false)).toBe(true);
    expect(takesBackendText(true, true)).toBe(true);
    expect(takesBackendText(true, false)).toBe(false);
  });

  it("is the normalised title and the Markdown the backend kept, not what was typed", async () => {
    const backend = new MockBackend();
    const now = backend.connector.item(itemRef("DEVOPS-471"))!;
    const p = backend.proposals.draft({ type: "rewrite", item: now.item, title: { from: now.title, to: "Pip's title" }, body: bodyChange(now.body, "Pip's text"), flattened: [] });
    expect(rewriteFields(p.intent as Rewrite)).toEqual({ title: "Pip's title", text: "Pip's text" });
    const saved = await backend.proposalsEdit(p.id, { type: "rewrite", title: "  My   title\n", body: "  My text  " });
    expect(rewriteFields(saved.intent as Rewrite)).toEqual({ title: "My title", text: "My text" });
    expect(rewriteFields(null)).toEqual({ title: "", text: "" });
    expect(rewriteFields(intent({ title: null }))).toEqual({ title: "", text: NEW });
  });
});

describe("approving through the backend", () => {
  it("applies the edit the person made, not the one Pip drafted", async () => {
    const backend = new MockBackend();
    const now = backend.connector.item(itemRef("DEVOPS-471"))!;
    const p = backend.proposals.draft({ type: "rewrite", item: now.item, title: null, body: bodyChange(now.body, "Pip's text"), flattened: [] });
    await backend.proposalsEdit(p.id, { type: "rewrite", body: "The person's text\n\n- one" });
    const done = await backend.proposalsApprove(p.id);
    expect(done.state.type).toBe("applied");
    const text = backend.connector.item(now.item)!.body.blocks.map((b) => b.type);
    expect(text).toEqual(["paragraph", "list"]);
  });
});

describe("a changed line's words (D31)", () => {
  const marked = (parts: { text: string; changed: boolean }[]) => parts.filter((p) => p.changed).map((p) => p.text);

  it("marks only the words that differ on each side of a changed line", () => {
    const d = diffWords("Drafted by an agent run (1000addd) on 2026-10-11.", "Drafted by an agent run (2000beef) on 2026-10-11.");
    expect(marked(d.from)).toEqual(["1000addd"]);
    expect(marked(d.to)).toEqual(["2000beef"]);
    expect(d.from.map((p) => p.text).join("")).toBe("Drafted by an agent run (1000addd) on 2026-10-11.");
    expect(d.to.map((p) => p.text).join("")).toBe("Drafted by an agent run (2000beef) on 2026-10-11.");
    expect(d.spacingOnly).toBe(false);
  });

  it("says when two lines differ only in spacing, which no mark would show", () => {
    expect(diffWords("Backoff starts at  two seconds. ", "Backoff starts at two seconds.").spacingOnly).toBe(true);
    expect(diffWords("Tabs\there", "Tabs here").spacingOnly).toBe(true);
    expect(diffWords("same", "same").spacingOnly).toBe(false);
    expect(diffWords("one", "two").spacingOnly).toBe(false);
  });

  it("pairs each run of removed lines with the added lines after it, first with first", () => {
    const rows = diffLines("a\nb\nkeep\nc", "A\nB\nextra\nkeep");
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(["del", "del", "add", "add", "add", "same", "del"]);
    const pairs = changedPairs(rows);
    expect([...pairs.entries()].sort(([x], [y]) => x - y)).toEqual([
      [0, 2],
      [1, 3],
      [2, 0],
      [3, 1],
    ]);
  });

  const body = (from: string, to: string): Rewrite => intent({ title: null, body: bodyChange(docFromMarkdown(from), to) });
  const view = (i: Rewrite, runName: string | null = null) => renderToStaticMarkup(<RewriteView intent={i} title="" body={i.body!.toText} editing={false} onTitle={vi.fn()} onBody={vi.fn()} runName={runName} />);

  it("says in one line for a screen reader how much changed, and the diff is described by it (G29)", () => {
    const html = view(body("One.\nTwo.\nThree.", "One.\n2.\nThree.\nFour."));
    expect(html).toMatch(/data-diff-summary[^>]*>Description changes: 2 lines added, 1 line removed\./);
    expect(html).toMatch(/<div[^>]*role="group"[^>]*aria-describedby="([^"]+)"/);
    const id = /aria-describedby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${id}"`);
    expect(diffSummary(diffLines("a", "a"), "description")).toBe("Description changes: no lines changed.");
    expect(diffSummary(diffLines("a", "a\nb"), "title")).toBe("Title changes: 1 line added.");
  });

  it("highlights the changed words of a removed and added pair", () => {
    const html = view(body("Retries back off.", "Retries back off quickly."));
    expect(html.match(/<mark data-word-changed[^>]*>[^<]*<\/mark>/g)?.map((m) => m.replace(/<[^>]+>/g, ""))).toEqual([" quickly"]);
    expect(html).not.toContain("data-spacing-only");
  });

  it("marks the words on both sides of a changed pair: what goes on the removed line, what comes on the added one", () => {
    const html = view(body("Retries back off slowly.", "Retries back off quickly."));
    const marked = (kind: string) => [...html.matchAll(new RegExp(`data-line="${kind}"[^>]*>(.*?)</div>`, "g"))].flatMap((m) => [...m[1].matchAll(/<mark data-word-changed[^>]*>([^<]*)<\/mark>/g)].map((w) => w[1].trim()));
    expect(marked("del")).toEqual(["slowly"]);
    expect(marked("add")).toEqual(["quickly"]);
  });

  it("notes a pair that differs only in spacing", () => {
    const html = view(body("Retries back off.\n\nThen  stop.", "Retries back off.\n\nThen stop."));
    expect(html).toContain(`data-spacing-only`);
    expect(html).toContain(`(${ONLY_SPACING})`);
    expect(ONLY_SPACING).toBe("only spacing changed");
  });

  it("shows the new intro as it will be written, with no run to name, so the card and Jira agree", () => {
    const intro = "Drafted by an agent on 2026-10-11. A person read and approved it before it was added here.";
    const html = view(body("## Gossamr Plan\n\nOld.", `## Gossamr Plan\n\n${intro}`), "the CA-401 plan");
    expect(lines(html, "add").join(" ")).toContain(intro);
    expect(html).not.toContain("the CA-401 plan");
  });

  it("names this draft's run only in the new text, so a plan's re-drafted intro no longer reads the same on both sides", () => {
    const was = "## Gossamr Plan\n\nDrafted by an agent run (1000addd) on 2026-10-11. A person read and approved it in Gossamr before it was added here.";
    const now = "## Gossamr Plan\n\nDrafted by an agent run (2000beef) on 2026-10-11. A person read and approved it in Gossamr before it was added here.";
    const html = view(body(was, now), "the CA-401 plan");
    expect(lines(html, "del")).toEqual(["Drafted by an agent run (1000addd) on 2026-10-11. A person read and approved it in Gossamr before it was added here."]);
    expect(lines(html, "add")).toEqual(["Drafted by the CA-401 plan on 2026-10-11. A person read and approved it in Gossamr before it was added here."]);
    expect(html).toContain("data-word-changed");
  });
});

describe("the plan's description draft says it can start a Build (G3)", () => {
  const plan = { ...new MockBackend().runs.list()[0], id: "plan-1" } as Run;
  plan.spec = { ...plan.spec, kind: "plan", workstream: "ws-1" };
  const ws = (mode: "manage" | "advise", rules = {}) =>
    ({ workstream: { id: "ws-1", mode, rules, closedAt: null, heldReason: null }, runs: ["plan-1"], labels: [], stage: "plan", budget: { level: "ok" } }) as unknown as WorkstreamView;
  const fromPlan = draft(intent(), { origin: { type: "run", runId: "plan-1", shortId: null, workstream: "ws-1" } });
  const html = (view: WorkstreamView, globals: typeof AUTOSTART_DEFAULTS | null = AUTOSTART_DEFAULTS, p = fromPlan) => {
    // Static rendering reads the stores' initial state, so that is where the case is set up, and put back.
    const runs = useRuns.getInitialState();
    const streams = useWorkstreams.getInitialState();
    Object.assign(runs, { runs: [plan] });
    Object.assign(streams, { list: [view], globals });
    try {
      return renderToStaticMarkup(<DraftCard {...props(p)} />);
    } finally {
      Object.assign(runs, { runs: [] });
      Object.assign(streams, { list: [], globals: null });
    }
  };
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });
  it("shows the line, linking to Agents settings, in Manage with the rule on", () => {
    const out = html(ws("manage"));
    expect(out).toContain("Approving this can start a Build: it changes code in its own worktree and runs with your Claude settings.");
    expect(out).toContain("Agents settings");
  });
  it("says nothing in Advise, with the rule off, for a draft from chat, or before Settings is read", () => {
    expect(html(ws("advise"))).not.toContain("data-approval-starts-build");
    expect(html(ws("manage", { plan_build: false }))).not.toContain("data-approval-starts-build");
    expect(html(ws("manage"), null)).not.toContain("data-approval-starts-build");
    expect(html(ws("manage"), AUTOSTART_DEFAULTS, draft())).not.toContain("data-approval-starts-build");
  });
});
