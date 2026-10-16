import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIFETIME_MS, UNDO_LIFETIME_MS, useToasts } from "./toasts";
import { UNDO_VALID_MS, UndoLog, hideUndoToast, offerUndo, undoLog } from "./undo";

/** A log with a clock the test moves and a record of what it told the person. */
function setup(valid = UNDO_VALID_MS) {
  let now = 1_000;
  const told: [string, string][] = [];
  const log = new UndoLog(() => now, (text, tone) => void told.push([text, tone]), valid);
  return { log, told, advance: (ms: number) => void (now += ms) };
}

describe("the undo state machine", () => {
  it("settles an offer once, however many times it is asked to undo", async () => {
    const settled = vi.fn();
    const log = new UndoLog(() => 1_000, () => {}, UNDO_VALID_MS, settled);
    const id = log.offer({ text: "Skipped the draft.", undo: async () => {} });
    expect(await log.run(id)).toBe("undone");
    expect(await log.run(id)).toBe("spent");
    expect(settled.mock.calls).toEqual([[id]]);
  });

  it("withdraws an offer once: it is spent, settled once, and cannot be undone", async () => {
    const settled = vi.fn();
    const log = new UndoLog(() => 1_000, () => {}, UNDO_VALID_MS, settled);
    const undo = vi.fn(async () => {});
    const id = log.offer({ text: "Held CA-401.", undo });
    log.withdraw(id);
    log.withdraw(id);
    expect(log.get(id)?.state).toBe("withdrawn");
    expect(log.latest()).toBeNull();
    expect(await log.run(id)).toBe("spent");
    expect(undo).not.toHaveBeenCalled();
    expect(settled.mock.calls).toEqual([[id]]);
  });

  it("offers, undoes once, and says so", async () => {
    const { log, told } = setup();
    const undo = vi.fn(async () => {});
    const id = log.offer({ text: "Skipped the draft.", undone: "The draft is back.", undo });
    expect(log.get(id)).toMatchObject({ state: "offered", text: "Skipped the draft." });
    expect(await log.run(id)).toBe("undone");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(log.get(id)?.state).toBe("undone");
    expect(told).toEqual([["The draft is back.", "info"]]);
  });

  it("shows what came back once it is undone, and not when the undo failed; a failing show leaves the undo standing", async () => {
    const { log } = setup();
    const shown = vi.fn();
    expect(await log.run(log.offer({ text: "x", undo: async () => {}, restored: shown }))).toBe("undone");
    expect(shown).toHaveBeenCalledTimes(1);
    const never = vi.fn();
    expect(await log.run(log.offer({ text: "y", undo: async () => false, restored: never }))).toBe("failed");
    expect(never).not.toHaveBeenCalled();
    expect(await log.run(log.offer({ text: "z", undo: async () => {}, restored: () => { throw new Error("no pane"); } }))).toBe("undone");
  });

  it("says plain 'Undone.' when the offer gave no words", async () => {
    const { log, told } = setup();
    await log.run(log.offer({ text: "Held CA-401.", undo: async () => {} }));
    expect(told).toEqual([["Undone.", "info"]]);
  });

  it("never undoes twice: a second ask, even in the same tick, does nothing", async () => {
    const { log } = setup();
    const undo = vi.fn(async () => {});
    const id = log.offer({ text: "x", undo });
    const [first, second] = await Promise.all([log.run(id), log.run(id)]);
    expect([first, second].sort()).toEqual(["spent", "undone"]);
    expect(await log.run(id)).toBe("spent");
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("is too late once the offer has been good for too long, and says so without undoing", async () => {
    const { log, told, advance } = setup(60_000);
    const undo = vi.fn(async () => {});
    const id = log.offer({ text: "x", undo });
    advance(60_000);
    expect(log.get(id)?.state).toBe("offered");
    advance(1);
    expect(log.get(id)?.state).toBe("expired");
    expect(await log.run(id)).toBe("expired");
    expect(undo).not.toHaveBeenCalled();
    expect(told).toEqual([["Too late to undo that.", "info"]]);
    expect(log.latest()).toBeNull();
  });

  it("tells the person when the undo is refused, and the offer is then spent", async () => {
    const { log, told } = setup();
    const id = log.offer({ text: "x", undo: async () => Promise.reject(new Error("that draft was skipped too long ago to bring back")) });
    expect(await log.run(id)).toBe("failed");
    expect(log.get(id)?.state).toBe("failed");
    expect(told).toEqual([["Couldn't undo that. that draft was skipped too long ago to bring back", "error"]]);
    expect(await log.run(id)).toBe("spent");
    // A undo that says it didn't put anything back is a failure too.
    const none = log.offer({ text: "y", undo: async () => false });
    expect(await log.run(none)).toBe("failed");
  });

  it("knows the newest offer still good, for the palette", async () => {
    const { log, advance } = setup(10_000);
    expect(log.latest()).toBeNull();
    const a = log.offer({ text: "a", undo: async () => {} });
    advance(1);
    const b = log.offer({ text: "b", undo: async () => {} });
    expect(log.latest()?.id).toBe(b);
    await log.run(b);
    expect(log.latest()?.id).toBe(a);
    advance(20_000);
    expect(log.latest()).toBeNull();
  });

  it("keeps only the latest few offers and can forget them all", () => {
    const { log } = setup();
    const ids = Array.from({ length: 30 }, (_, i) => log.offer({ text: String(i), undo: async () => {} }));
    expect(log.get(ids[0])).toBeNull();
    expect(log.get(ids[29])?.state).toBe("offered");
    log.clear();
    expect(log.get(ids[29])).toBeNull();
    expect(log.latest()).toBeNull();
  });

  it("restores nothing for an offer it doesn't know", async () => {
    expect(await setup().log.run(999)).toBe("spent");
  });
});

describe("the Undo toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.getState().clear();
    undoLog.clear();
  });
  afterEach(() => {
    useToasts.getState().clear();
    vi.useRealTimers();
  });

  it("says what happened with an Undo button, for about 8 seconds", () => {
    offerUndo({ text: "Skipped the draft on CA-401.", undo: async () => {} });
    const [toast] = useToasts.getState().toasts;
    expect(toast).toMatchObject({ text: "Skipped the draft on CA-401.", tone: "info", action: { label: "Undo" }, lifetime: UNDO_LIFETIME_MS, keep: true });
    expect(UNDO_LIFETIME_MS).toBe(8000);
    expect(UNDO_LIFETIME_MS).toBeGreaterThan(LIFETIME_MS.info);
    vi.advanceTimersByTime(UNDO_LIFETIME_MS - 1);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("Undo runs the undo once", async () => {
    const undo = vi.fn(async () => {});
    offerUndo({ text: "Held CA-401.", undone: "CA-401 is free again.", undo });
    const toast = useToasts.getState().toasts[0];
    toast.action!.run();
    toast.action!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("CA-401 is free again.");
  });

  it("hides one offer's toast and keeps the offer for the palette's Undo", async () => {
    const undo = vi.fn(async () => {});
    const older = offerUndo({ text: "Removed CA-1 from the plan.", undo });
    offerUndo({ text: "Removed CA-2 from the plan.", undo: async () => {} });
    hideUndoToast(older);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Removed CA-2 from the plan."]);
    expect(undoLog.get(older)?.state).toBe("offered");
    expect(await undoLog.run(older)).toBe("undone");
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("takes the toast down when the offer is undone from the palette's path, and when it failed", async () => {
    const id = offerUndo({ text: "Held CA-401.", undone: "CA-401 is free again.", undo: async () => {} });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Held CA-401."]);
    expect(await undoLog.run(id)).toBe("undone");
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["CA-401 is free again."]);
    const bad = offerUndo({ text: "Skipped it.", undo: async () => false });
    expect(await undoLog.run(bad)).toBe("failed");
    expect(useToasts.getState().toasts.map((t) => t.text)).not.toContain("Skipped it.");
  });

  it("push returns the toast's id", () => {
    const id = useToasts.getState().push("Hello", "info");
    expect(useToasts.getState().toasts[0].id).toBe(id);
    expect(useToasts.getState().push("Hello", "info")).toBeNull();
  });

  it("comes to the front over a note, is never dropped for waiting, and waits behind an error", () => {
    const { push } = useToasts.getState();
    push("A note.", "info");
    push("Another note.", "info");
    offerUndo({ text: "Dismissed R3 from Needs you.", undo: async () => {} });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Dismissed R3 from Needs you.", "A note.", "Another note."]);
    vi.advanceTimersByTime(UNDO_LIFETIME_MS);
    // The offer is gone; the note that waited more than STALE_MS behind it is dropped, not shown late.
    expect(useToasts.getState().toasts.map((t) => t.text)).not.toContain("Dismissed R3 from Needs you.");

    useToasts.getState().clear();
    push("It broke.", "error");
    offerUndo({ text: "Held CA-401.", undo: async () => {} });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["It broke.", "Held CA-401."]);
    // Behind an error for longer than a note may wait, the offer is still there when its turn comes.
    vi.advanceTimersByTime(LIFETIME_MS.error + 1);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Held CA-401."]);
  });

  it("shows the newest offer first with the older one behind it (G3), and replaces one with the same words", () => {
    offerUndo({ text: "Skipped the draft.", undo: async () => {} });
    offerUndo({ text: "Dismissed R1 from Needs you.", undo: async () => {} });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Dismissed R1 from Needs you.", "Skipped the draft."]);
    offerUndo({ text: "Dismissed R1 from Needs you.", undo: async () => {} });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Dismissed R1 from Needs you.", "Skipped the draft."]);
  });
});

describe("refocus once an Undo is done (G7)", () => {
  it("runs after the thing is back, so the keyboard the toast took away lands somewhere", async () => {
    const { log } = setup();
    const seen: string[] = [];
    const id = log.offer({ text: "Closed.", undo: async () => void seen.push("undo"), restored: () => seen.push("restored"), refocus: () => seen.push("refocus") });
    expect(await log.run(id)).toBe("undone");
    expect(seen).toEqual(["undo", "restored", "refocus"]);
  });

  it("does not run when the undo failed, and its own failure does not undo the undo", async () => {
    const { log } = setup();
    const seen: string[] = [];
    const bad = log.offer({ text: "A", undo: async () => false, refocus: () => seen.push("refocus") });
    expect(await log.run(bad)).toBe("failed");
    const ok = log.offer({ text: "B", undo: async () => {}, refocus: () => { throw new Error("gone"); } });
    expect(await log.run(ok)).toBe("undone");
    expect(seen).toEqual([]);
  });
});
