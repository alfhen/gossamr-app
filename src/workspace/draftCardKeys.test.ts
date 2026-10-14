import { describe, expect, it } from "vitest";
import { holdWhilePressed } from "./draftCardKeys";

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
