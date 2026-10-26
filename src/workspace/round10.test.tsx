import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PaletteView, START_WORKSTREAM_NOTE } from "./Palette";
import { goneOnRouteChange } from "./ToastHost";

describe("round 10 backlog", () => {
  it("G31: the palette's workstream step says it starts no agent and posts nothing; other steps have no such line", () => {
    const view = (note?: string) => renderToStaticMarkup(<PaletteView query="" results={[]} active={0} note={note} onQuery={vi.fn()} onActive={vi.fn()} onRun={vi.fn()} onClose={vi.fn()} />);
    expect(START_WORKSTREAM_NOTE).toBe("Opens a workstream; starts no agent and posts nothing.");
    expect(view(START_WORKSTREAM_NOTE)).toContain(`data-palette-note="true" class=`);
    expect(view(START_WORKSTREAM_NOTE)).toContain(START_WORKSTREAM_NOTE);
    expect(view()).not.toContain("data-palette-note");
  });

  it("G32: a route change takes away the toasts that offer no Undo and keeps the ones that do", () => {
    const undo = { label: "Undo", run: () => {} };
    expect(goneOnRouteChange([{ id: 1, at: 0 }, { id: 2, at: 0, action: undo }, { id: 3, at: 0 }], 10_000)).toEqual([1, 3]);
    expect(goneOnRouteChange([], 10_000)).toEqual([]);
    // One pushed with the change, as "Drafted a new ticket" is as Drafts opens, is about the page it lands on.
    expect(goneOnRouteChange([{ id: 1, at: 9_900 }, { id: 2, at: 1_000 }], 10_000)).toEqual([2]);
  });
});
