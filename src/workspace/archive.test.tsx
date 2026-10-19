import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { DEFAULT_CLEAR } from "../lib/archiveRuns";
import type { ClearPreview, Run } from "../types";
import { ArchivedSectionView, type ArchivedSectionViewProps } from "./ArchivedSection";
import { ClearFinishedView, type ClearFinishedViewProps } from "./ClearFinished";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { NO_FILTERS } from "./agentsLogic";
import { useRuns } from "./runsStore";
import { useToasts } from "./toasts";
import { currentNeeds } from "./useNeeds";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const s = () => useRuns.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));
const NOW = Date.parse("2026-09-30T12:00:00Z");

let backend: MockBackend;

async function start(seed: "failures" | "busy") {
  backend = new MockBackend({ runs: { seed } });
  s().init(backend);
  await settle();
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useRuns.setState({ dismissed: new Set(), filters: NO_FILTERS, earlierOpen: false, archivedOpen: false });
  useToasts.getState().clear();
});

describe("archiving a run", () => {
  it("moves it out of the Agents list and out of Needs you, and restoring brings both back", async () => {
    await start("failures");
    const before = currentNeeds().filter((n) => n.kind === "failure");
    const target = s().runs.find((r) => before.some((n) => n.runId === r.id))!;
    expect(target).toBeDefined();

    expect(await s().archive([target.id])).toBe(true);
    await settle();
    expect(s().runs.map((r) => r.id)).not.toContain(target.id);
    expect(s().archived.map((r) => r.id)).toEqual([target.id]);
    expect(currentNeeds().filter((n) => n.kind === "failure")).toHaveLength(before.length - 1);
    expect(currentNeeds().map((n) => n.runId)).not.toContain(target.id);

    await s().restore(target.id);
    await settle();
    expect(s().archived).toEqual([]);
    expect(s().runs.map((r) => r.id)).toContain(target.id);
    expect(currentNeeds().filter((n) => n.kind === "failure")).toHaveLength(before.length);
  });

  it("offers an Undo that restores what was archived", async () => {
    await start("failures");
    const id = s().runs[0].id;
    await s().archive([id]);
    await settle();
    const undo = useToasts.getState().toasts.find((t) => t.action?.label === "Undo");
    expect(undo).toBeDefined();
    undo!.action!.run();
    await settle();
    await settle();
    expect(s().archived).toEqual([]);
  });

  it("refuses a run that is still going, which has to be stopped first", async () => {
    await start("busy");
    const working = s().runs.find((r) => r.state === "working")!;
    expect(await s().archive([working.id])).toBe(false);
    expect(useToasts.getState().toasts.some((t) => /Stop it first/.test(t.text))).toBe(true);
    expect(s().archived).toEqual([]);
    expect(s().runs.map((r) => r.id)).toContain(working.id);
  });
});

describe("Clear finished", () => {
  it("previews with the backend's count and archives exactly that, keeping runs listed in Needs you", async () => {
    await start("failures");
    const filter = { ...DEFAULT_CLEAR, olderThanDays: null, keep: [s().runs[0].id] };
    const preview = await backend.runsClearPreview(filter);
    expect(preview.ids).toHaveLength(s().runs.length - 1);
    expect(preview.kept.needsYou).toBe(1);

    expect(await s().clearFinished(filter)).toBe(preview.ids.length);
    await settle();
    expect(s().runs.map((r) => r.id)).toEqual([filter.keep[0]]);
    expect(s().archived).toHaveLength(preview.ids.length);
  });

  it("never selects a run with a draft still to approve", async () => {
    await start("busy");
    const withDraft = new Set(backend.proposals.list({ states: ["pending"] }).flatMap((p) => (p.origin.type === "run" ? [p.origin.runId] : [])));
    const preview = await backend.runsClearPreview({ ...DEFAULT_CLEAR, olderThanDays: null, states: ["done", "failed", "stopped", "unknown"] });
    expect(preview.ids.filter((id) => withDraft.has(id))).toEqual([]);
    expect(preview.kept.draft).toBe([...withDraft].filter((id) => s().runs.some((r) => r.id === id && r.state === "done")).length);
  });
});

describe("deleting an archived run", () => {
  it("removes it for good, only once archived", async () => {
    await start("failures");
    const id = s().runs[0].id;
    expect(await s().deleteArchived(id, false)).toBeNull();
    expect(s().runs.map((r) => r.id)).toContain(id);
    await s().archive([id]);
    await settle();
    expect(await s().deleteArchived(id, false)).toEqual({ type: "deleted" });
    await settle();
    expect(s().archived).toEqual([]);
    expect(s().runs.map((r) => r.id)).not.toContain(id);
  });

  it("offers the worktree folder only inside ~/Gossamr/agents, and says why when it can't", async () => {
    await start("busy");
    const [own, fresh] = s().runs.filter((r) => r.state === "done");
    const spec = { ...fresh.spec, clonePath: "/Users/sample/Gossamr/agents/acme/shop" };
    const inner = backend.runs as unknown as { runs: Run[] };
    inner.runs = inner.runs.map((r) => (r.id === fresh.id ? { ...r, spec } : r));

    expect(await backend.runsWorktreeInfo(fresh.id)).toMatchObject({ removable: true, reason: null, path: expect.stringContaining("~/Gossamr/agents/") });
    expect((await backend.runsWorktreeInfo(fresh.id)).bytes).toBeGreaterThan(0);
    expect(await backend.runsWorktreeInfo(own.id)).toMatchObject({ removable: false, bytes: null, reason: expect.stringContaining("~/Gossamr/agents") });
    await expect(backend.runsDelete(own.id, true)).rejects.toThrow();
  });
});

describe("the Archived section", () => {
  const run = (over: Partial<Run> = {}): Run => ({ ...new MockBackend().runs.list()[0], archivedAt: new Date(NOW - 3_600_000).toISOString(), ...over });
  const view = (over: Partial<ArchivedSectionViewProps> = {}) =>
    renderToStaticMarkup(<ArchivedSectionView runs={[run({ id: "a1" })]} open now={NOW} ticketTitle={() => "Retry webhooks"} asking={null} onToggle={vi.fn()} onRestore={vi.fn()} onAskDelete={vi.fn()} onCancelDelete={vi.fn()} onRemoveWorktree={vi.fn()} onConfirmDelete={vi.fn()} {...over} />);

  it("is collapsed to a count and opens to rows with Restore and Delete permanently", () => {
    const closed = view({ open: false });
    expect(closed).toContain("Archived");
    expect(closed).toMatch(/data-archived-count[^>]*>1</);
    expect(closed).not.toContain("data-archived-run");
    const open = view();
    expect(open).toContain(">Restore<");
    expect(open).toContain("Delete permanently");
    expect(open).toContain("Retry webhooks");
  });

  it("asks before deleting, showing the folder's size and an unchecked box to remove it", () => {
    const html = view({ asking: { id: "a1", info: { path: "~/Gossamr/agents/acme/shop/.claude/worktrees/x", removable: true, reason: null, bytes: 5 * 1024 * 1024 }, removeWorktree: false, busy: false, refused: null } });
    expect(html).toContain("can&#x27;t be undone");
    expect(html).toContain("5.0 MB");
    expect(html).toContain("~/Gossamr/agents/acme/shop");
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toContain(">Delete permanently<");
  });

  it("names the confirm for the folder when the box is ticked, and says why a folder isn't offered", () => {
    const info = { path: "/p", removable: true, reason: null, bytes: 10 };
    expect(view({ asking: { id: "a1", info, removeWorktree: true, busy: false, refused: null } })).toContain("Delete run and remove folder");
    const outside = view({ asking: { id: "a1", info: { path: "/p", removable: false, reason: "Its worktree isn't in ~/Gossamr/agents, so Gossamr leaves it where it is.", bytes: null }, removeWorktree: false, busy: false, refused: null } });
    expect(outside).toContain("Gossamr leaves it where it is");
    expect(outside).not.toContain('type="checkbox"');
  });

  it("shows Claude's refusal and that nothing was deleted", () => {
    const html = view({ asking: { id: "a1", info: { path: "/p", removable: true, reason: null, bytes: 1 }, removeWorktree: true, busy: false, refused: "worktree has 1 unpushed commit" } });
    expect(html).toContain("worktree has 1 unpushed commit");
    expect(html).toContain("Nothing was deleted");
  });
});

describe("the Clear finished popover", () => {
  const preview: ClearPreview = { ids: Array(12).fill("x"), byState: { done: 12 }, kept: { draft: 1, needsYou: 2 } };
  const view = (over: Partial<ClearFinishedViewProps> = {}) =>
    renderToStaticMarkup(<ClearFinishedView open onToggle={vi.fn()} filter={DEFAULT_CLEAR} preview={preview} busy={false} onAge={vi.fn()} onState={vi.fn()} onConfirm={vi.fn()} {...over} />);

  it("says what would be archived, with the age and states, and what it keeps", () => {
    const html = view();
    expect(html).toContain("Archive 12 runs older than 7 days: done, failed, stopped");
    expect(html).toContain("Kept: 1 with a draft to approve, 2 in Needs you.");
    expect(html).toContain("Archive 12 runs");
    expect(html).toMatch(/<input[^>]*checked[^>]*\/?>\s*Done/);
  });

  it("is a closed button until opened, and cannot confirm an empty choice", () => {
    expect(view({ open: false })).not.toContain("role=\"dialog\"");
    const empty = view({ preview: { ids: [], byState: {}, kept: { draft: 0, needsYou: 0 } } });
    expect(empty).toContain("Nothing to archive with these choices.");
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>Archive<\/button>/);
  });
});

describe("the run sheet's Archive", () => {
  const actions = (): RunSheetActions => new Proxy({ archive: vi.fn() } as unknown as RunSheetActions, { get: (t, k) => (k in t ? (t as never)[k] : vi.fn()) });
  const sheet = (r: Run) =>
    renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="T" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} brief={null} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} />);
  const base = new MockBackend().runs.list();

  it("is enabled for a finished run and disabled, with the reason, while it is going", () => {
    const done = base.find((r) => r.state === "done")!;
    const working = base.find((r) => r.state === "working")!;
    expect(sheet(done)).toMatch(/<button[^>]*data-archive[^>]*>/);
    expect(sheet(done)).not.toMatch(/<button[^>]*data-archive[^>]*disabled=""/);
    expect(sheet(working)).toMatch(/<button[^>]*data-archive[^>]*disabled=""/);
    expect(sheet(working)).toContain("Stop it first, then archive it.");
  });
});
