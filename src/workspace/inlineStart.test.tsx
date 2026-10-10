import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { ItemRef, Proposal, RunKind, RunSpec } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DraftPreview, LiveDraftPreview, openLiveDraft } from "./DraftPreview";
import { CLOSED_INLINE, InlineStartContext, InlineStartView, inlineStartBlock, inlineStartKey, inlineStartable, useInlineStarts, type InlineActions } from "./InlineStart";
import { usePrefs } from "./prefs";
import { COPY } from "./runSheetLogic";
import { useRunSetup } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const settle = () => new Promise((r) => setTimeout(r, 0));
const CA = itemRef("CA-401");
const inline = () => useInlineStarts.getState();
const entry = (id: string) => inline().entries[id] ?? CLOSED_INLINE;
const noop: InlineActions = { shown: vi.fn(), dismissChanged: vi.fn(), start: vi.fn(), recheck: vi.fn(), trustFolder: vi.fn(), close: vi.fn() };
const render = (id: string) => renderToStaticMarkup(<InlineStartView id={id} entry={entry(id)} on={noop} />);
/** The Start agent button as rendered, with its attributes. */
const startButton = (html: string) => /<button[^>]*data-inline-start-button[^>]*>/.exec(html)?.[0] ?? "";

let backend: MockBackend;

/** A run draft on CA-401 in acme/storefront, made as the setup sheet makes it, with the sheet closed again. */
async function draft(): Promise<string> {
  await useRunSetup.getState().begin({ item: CA });
  await useRunSetup.getState().chooseRepo("acme/storefront");
  const id = useRunSetup.getState().proposalId!;
  useRunSetup.getState().close();
  await useWorkspace.getState().refreshProposals();
  return id;
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  usePrefs.setState({ agentsIntroSeen: true });
  backend = new MockBackend({ runs: { seed: "empty", epoch: Date.parse("2026-09-30T12:00:00Z") } });
  await useWorkspace.getState().init(backend);
  useRuns.getState().init(backend);
  useToasts.getState().clear();
  useTabs.getState().setRoute("pip");
  await settle();
});

afterEach(() => {
  for (const id of Object.keys(inline().entries)) inline().close(id);
  useTabs.getState().setRoute("workspace");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reviewing and starting a run draft in place", () => {
  it("keeps Start off while the draft is read and until its prompt has rendered, then turns it on", async () => {
    const id = await draft();
    const opening = inline().open(id);
    expect(entry(id).phase).toBe("loading");
    expect(inlineStartBlock(entry(id))).toBe("Getting the draft ready…");
    expect(startButton(render(id))).toContain('disabled=""');
    await opening;

    const review = await backend.runsReview(id);
    expect(entry(id)).toMatchObject({ phase: "shown", review: { digest: review.digest }, displayed: null });
    const html = render(id);
    // The exact prompt, read-only, and the checks are there; Start still waits for the prompt to be on screen.
    expect(html).toContain(`data-inline-prompt="${review.digest}"`);
    expect(html).toContain(COPY.receives);
    expect(html).not.toContain("<textarea");
    expect(html).toContain('aria-label="Checks before you approve"');
    expect(html).toContain(COPY.runAsYou);
    // An investigation is read-only: the line, and the rules the backend would launch it with, are in the review.
    expect(review.readOnly?.mode).toBe("dontAsk");
    expect(html).toContain(COPY.readOnly);
    expect(html).toContain("data-read-only-rules");
    expect(startButton(html)).toContain('disabled=""');
    expect(inlineStartBlock(entry(id))).toBe("Showing the prompt…");

    // Only the digest on screen counts.
    inline().shown(id, "something else");
    expect(entry(id).displayed).toBeNull();
    inline().shown(id, review.digest);
    expect(inlineStartBlock(entry(id))).toBeNull();
    expect(startButton(render(id))).not.toContain('disabled=""');
    expect(render(id)).toContain(COPY.startsNow.replace(/'/g, "&#x27;"));
  });

  it("starts on ⌘↵ or Ctrl+↵ only when Start would, and takes the key without starting while Start is off", async () => {
    const id = await draft();
    const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
    await inline().open(id);
    // The prompt isn't on screen yet: held, like the button.
    expect(inlineStartKey(key({ metaKey: true }), entry(id))).toBe("held");
    inline().shown(id, entry(id).review!.digest);
    expect(inlineStartKey(key({ metaKey: true }), entry(id))).toBe("start");
    expect(inlineStartKey(key({ ctrlKey: true }), entry(id))).toBe("start");
    // Plain Enter, another modifier with it, or another key are not the shortcut.
    expect(inlineStartKey(key(), entry(id))).toBeNull();
    expect(inlineStartKey(key({ metaKey: true, shiftKey: true }), entry(id))).toBeNull();
    expect(inlineStartKey(key({ ctrlKey: true, altKey: true }), entry(id))).toBeNull();
    expect(inlineStartKey(key({ key: "s", metaKey: true }), entry(id))).toBeNull();
    // Starting, or changed and not yet read again: held.
    expect(inlineStartKey(key({ metaKey: true }), { ...entry(id), phase: "starting" })).toBe("held");
    expect(inlineStartKey(key({ metaKey: true }), { ...entry(id), phase: "changed" })).toBe("held");
  });

  it("starts with the digest shown and stays on Pip home, the draft's review closed", async () => {
    const id = await draft();
    await inline().open(id);
    const { digest } = entry(id).review!;
    inline().shown(id, digest);
    const approve = vi.spyOn(backend, "runsApprove");
    const run = await inline().start(id);
    expect(approve).toHaveBeenCalledWith(id, digest);
    expect(run?.state).toBe("queued");
    expect(useTabs.getState().route).toBe("pip");
    expect(useRuns.getState().selectedId).toBe(run!.id);
    expect(inline().entries[id]).toBeUndefined();
  });

  it("lets a red check block Start, with its reason beside the button", async () => {
    const id = await draft();
    const real = await backend.runsPreflight((await backend.runsReview(id)).spec);
    vi.spyOn(backend, "runsPreflight").mockResolvedValue({ ...real, blocking: true, rows: [...real.rows, { level: "red", text: "Claude is not signed in" }] });
    await inline().open(id);
    inline().shown(id, entry(id).review!.digest);
    expect(inlineStartBlock(entry(id))).toBe("Claude is not signed in");
    const html = render(id);
    expect(startButton(html)).toContain('disabled=""');
    expect(html).toContain('data-level="red"');
    expect(html).toMatch(/role="status"[^>]*>Claude is not signed in</);
    expect(await inline().start(id)).toBeNull();
  });

  it("refuses a draft that changed after it was read: a banner, the draft read again, and Start off until I've read it", async () => {
    const id = await draft();
    await inline().open(id);
    const stale = entry(id).review!.digest;
    inline().shown(id, stale);
    await backend.proposalsEdit(id, { type: "run", instruction: "Something else, changed behind the card." });

    expect(await inline().start(id)).toBeNull();
    expect(entry(id).phase).toBe("changed");
    expect(entry(id).review!.digest).not.toBe(stale);
    expect(entry(id).review!.prompt).toContain("Something else, changed behind the card.");
    expect(await backend.runsList({ item: CA })).toHaveLength(0);
    const html = render(id);
    expect(html).toContain(COPY.changed);
    expect(html).toContain("I&#x27;ve read it");
    expect(startButton(html)).toContain('disabled=""');

    // The new prompt rendering is not enough: the person says they read it.
    inline().shown(id, entry(id).review!.digest);
    expect(inlineStartBlock(entry(id))).toBe("Read the change above first");
    expect(await inline().start(id)).toBeNull();
    inline().dismissChanged(id);
    expect(inlineStartBlock(entry(id))).toBeNull();
    expect(render(id)).not.toContain(COPY.changed);
    const run = await inline().start(id);
    expect(run?.state).toBe("queued");
  });

  it("drops the stale review when a draft changed and reading it again fails, so Start isn't offered on it", async () => {
    const id = await draft();
    await inline().open(id);
    inline().shown(id, entry(id).review!.digest);
    await backend.proposalsEdit(id, { type: "run", instruction: "Something else, changed behind the card." });
    vi.spyOn(backend, "runsReview").mockRejectedValueOnce(new Error("Couldn't read the draft"));

    expect(await inline().start(id)).toBeNull();
    expect(entry(id)).toMatchObject({ phase: "error", review: null, displayed: null, error: "Couldn't read the draft" });
    expect(render(id)).toContain('role="alert"');
    expect(startButton(render(id))).toContain('disabled=""');
    // Start does nothing on it; opening it again reads the changed draft.
    expect(await inline().start(id)).toBeNull();
    expect(await backend.runsList({ item: CA })).toHaveLength(0);
    await inline().open(id);
    expect(entry(id).phase).toBe("shown");
    expect(entry(id).review!.prompt).toContain("Something else, changed behind the card.");
  });

  it("shows any other refusal and lets the person try again", async () => {
    const id = await draft();
    await inline().open(id);
    inline().shown(id, entry(id).review!.digest);
    vi.spyOn(backend, "runsApprove").mockRejectedValueOnce(new Error("Gossamr is already running 3 agents"));
    expect(await inline().start(id)).toBeNull();
    expect(entry(id)).toMatchObject({ phase: "error", error: "Gossamr is already running 3 agents" });
    expect(render(id)).toContain('role="alert"');
    expect(inlineStartBlock(entry(id))).toBeNull();
    expect((await inline().start(id))?.state).toBe("queued");
  });

  it("opens the safety sheet first for a person who hasn't seen it, and reads nothing", async () => {
    const id = await draft();
    usePrefs.setState({ agentsIntroSeen: false });
    await inline().open(id);
    expect(useRuns.getState().sheet).toEqual({ type: "safety" });
    expect(inline().entries[id]).toBeUndefined();
    useRuns.getState().closeSheet();
  });
});

const spec = (kind: RunKind): RunSpec => ({ kind, repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-x", instruction: "Do the work." });

const runDraft = (kind: RunKind, item: ItemRef | null = CA, over: Partial<Proposal> = {}): Proposal => ({
  id: `p-${kind}-${item ? "t" : "n"}`,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "r1" },
  createdBy: "pip",
  intent: { type: "startRun", connectionId: "mock", item, spec: spec(kind) },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const onPipHome = (p: Proposal) =>
  renderToStaticMarkup(
    <InlineStartContext.Provider value={true}>
      <LiveDraftPreview proposal={p} />
    </InlineStartContext.Provider>,
  );

describe("which run drafts start in place", () => {
  it("takes investigate, triage, plan and verify on a ticket; never a build, a review, one with no ticket or a decided one", () => {
    for (const kind of ["investigate", "triage", "plan", "verify"] as const) expect(inlineStartable(runDraft(kind))).toBe(true);
    expect(inlineStartable(runDraft("build"))).toBe(false);
    expect(inlineStartable(runDraft("review"))).toBe(false);
    expect(inlineStartable(runDraft("investigate", null))).toBe(false);
    expect(inlineStartable(runDraft("investigate", CA, { state: { type: "skipped" } }))).toBe(false);
  });

  it("gives an eligible draft on Pip home an expander, which its action toggles", () => {
    const p = runDraft("investigate");
    const html = onPipHome(p);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Review and start<\/button>/);
    expect(html).not.toContain("Review and start →");
    const begin = vi.spyOn(useRunSetup.getState(), "begin");
    const toggle = vi.spyOn(useInlineStarts.getState(), "toggle").mockImplementation(() => {});
    openLiveDraft(p, { inline: true });
    expect(toggle).toHaveBeenCalledWith(p.id);
    expect(begin).not.toHaveBeenCalled();
  });

  it("shows the review under the card once open, with the expander saying so", () => {
    const p = runDraft("plan");
    const panel = <InlineStartView id={p.id} entry={{ ...CLOSED_INLINE, phase: "loading" }} on={noop} />;
    const html = renderToStaticMarkup(<DraftPreview proposal={p} statusName={null} targetTitle={null} onOpen={vi.fn()} expander={{ open: true, panel }} />);
    expect(html).toMatch(/aria-expanded="true" aria-controls="inline-start-p-plan-t"[^>]*>Review and start<\/button>/);
    expect(html).toContain('id="inline-start-p-plan-t"');
    expect(html).toContain("Reading the draft…");
    // Closed, the panel isn't there.
    expect(renderToStaticMarkup(<DraftPreview proposal={p} statusName={null} targetTitle={null} onOpen={vi.fn()} expander={{ open: false, panel }} />)).not.toContain("inline-start-p-plan-t");
  });

  it("opens the full setup sheet for a build, a review and a draft with no ticket, on Pip home too", () => {
    const begin = vi.spyOn(useRunSetup.getState(), "begin").mockResolvedValue();
    const toggle = vi.spyOn(useInlineStarts.getState(), "toggle");
    for (const p of [runDraft("build"), runDraft("review"), runDraft("investigate", null)]) {
      const html = onPipHome(p);
      expect(html).toContain("Review and start →");
      expect(html).not.toContain("aria-expanded");
      expect(html).not.toContain("inline-start-");
      openLiveDraft(p, { inline: true });
      expect(begin).toHaveBeenLastCalledWith({ proposalId: p.id });
    }
    expect(toggle).not.toHaveBeenCalled();
  });

  it("without Pip home's context, as in the docked pane, behaves as before: no expander, the setup sheet opens", () => {
    const begin = vi.spyOn(useRunSetup.getState(), "begin").mockResolvedValue();
    const p = runDraft("investigate");
    useInlineStarts.setState({ entries: { [p.id]: { ...CLOSED_INLINE, phase: "shown" } } });
    const html = renderToStaticMarkup(<LiveDraftPreview proposal={p} />);
    expect(html).toContain("Review and start →");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("inline-start-");
    openLiveDraft(p);
    expect(begin).toHaveBeenCalledWith({ proposalId: p.id });
  });
});
