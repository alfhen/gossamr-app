import { describe, expect, it } from "vitest";
import { holdWhilePressed } from "./draftCardKeys";
import { setDraftEditIntent, takeDraftEditIntent } from "./draftKeys";
import { showPause } from "./DraftCard";

/** A window that only keeps its listeners, so a test can fire them. */
const fakeWindow = () => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
};

describe("holdWhilePressed", () => {
  it("runs nothing until the press is over, then once, after the click has been dispatched", () => {
    const win = fakeWindow();
    const queued: (() => void)[] = [];
    let ran = 0;
    holdWhilePressed(win as unknown as Window, () => ran++, (run) => queued.push(run));
    expect([ran, queued.length]).toEqual([0, 0]);
    win.fire("pointerup");
    // Deferred past the click: only the timer runs it.
    expect([ran, queued.length]).toEqual([0, 1]);
    queued[0]();
    expect(ran).toBe(1);
    // Both listeners are gone, so a later press does not run it again.
    expect(win.count()).toBe(0);
    win.fire("pointerup");
    win.fire("pointercancel");
    expect(queued.length).toBe(1);
  });

  it("ends with a cancelled press too", () => {
    const win = fakeWindow();
    const queued: (() => void)[] = [];
    holdWhilePressed(win as unknown as Window, () => {}, (run) => queued.push(run));
    win.fire("pointercancel");
    expect(queued.length).toBe(1);
    expect(win.count()).toBe(0);
  });
});

describe("e on a compact card (G8)", () => {
  it("is taken once by the full card of that draft, and not by another or a late one", async () => {
    setDraftEditIntent("d1", 1000);
    expect(takeDraftEditIntent("d2", 1100)).toBe(false);
    expect(takeDraftEditIntent("d1", 1100)).toBe(true);
    expect(takeDraftEditIntent("d1", 1100)).toBe(true);
    await Promise.resolve();
    expect(takeDraftEditIntent("d1", 1100)).toBe(false);
    setDraftEditIntent("d1", 1000);
    expect(takeDraftEditIntent("d1", 9000)).toBe(false);
  });
});

describe("the posting pause (G5)", () => {
  it("puts the keyboard on Keep editing and brings the note and the actions into view", () => {
    const seen: string[] = [];
    const node = (name: string) => ({ focus: () => seen.push(`focus ${name}`), scrollIntoView: () => seen.push(`scroll ${name}`) });
    const nodes: Record<string, unknown> = { "[data-post-pause-keep]": node("keep"), "[data-draft-actions]": node("actions") };
    showPause({ querySelector: (s: string) => nodes[s] ?? null } as unknown as ParentNode);
    expect(seen).toEqual(["focus keep", "scroll keep", "scroll actions"]);
  });

  it("does nothing once the pause is gone", () => {
    expect(() => showPause({ querySelector: () => null } as unknown as ParentNode)).not.toThrow();
  });
});
