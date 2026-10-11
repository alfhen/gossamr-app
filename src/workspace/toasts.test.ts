import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIFETIME_MS, MAX_QUEUED, STALE_MS, useToasts } from "./toasts";

const texts = () => useToasts.getState().toasts.map((t) => t.text);
const shown = () => useToasts.getState().toasts[0]?.text;

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.getState().clear();
  });
  afterEach(() => {
    useToasts.getState().clear();
    vi.useRealTimers();
  });

  it("queues in order and shows only the head", () => {
    useToasts.getState().push("Agent started", "info");
    useToasts.getState().push("Watching 4 repositories", "info");
    expect(texts()).toEqual(["Agent started", "Watching 4 repositories"]);
    expect(shown()).toBe("Agent started");
    expect(useToasts.getState().toasts.slice(-1)[0].text).toBe("Watching 4 repositories");
  });

  it("starts a toast's clock only once it is the one on screen", () => {
    useToasts.getState().push("first", "info");
    vi.advanceTimersByTime(LIFETIME_MS.info - STALE_MS + 100);
    useToasts.getState().push("second", "info");
    vi.advanceTimersByTime(STALE_MS - 101);
    expect(texts()).toEqual(["first", "second"]);
    vi.advanceTimersByTime(1);
    expect(texts()).toEqual(["second"]);
    // The second waited less than STALE_MS, so it shows, for its own whole lifetime from when it came up.
    vi.advanceTimersByTime(LIFETIME_MS.info - 100);
    expect(shown()).toBe("second");
    vi.advanceTimersByTime(100);
    expect(texts()).toEqual([]);
  });

  it("drops a note that waited too long behind another rather than show it late, but never an error", () => {
    useToasts.getState().push("Watching 4 repositories", "info");
    useToasts.getState().push("Agent started on CA-402", "info");
    useToasts.getState().push("Couldn't reach Jira");
    vi.advanceTimersByTime(LIFETIME_MS.info);
    // The error went ahead of the note and comes up next; the note, older than STALE_MS by then, is gone.
    expect(texts()).toEqual(["Couldn't reach Jira"]);
    expect(STALE_MS).toBeLessThan(LIFETIME_MS.info);
  });

  it("puts an error ahead of the notes waiting, behind the one on screen and earlier errors", () => {
    useToasts.getState().push("on screen", "info");
    useToasts.getState().push("note 1", "info");
    useToasts.getState().push("error 1");
    useToasts.getState().push("note 2", "info");
    useToasts.getState().push("error 2");
    expect(texts()).toEqual(["on screen", "error 1", "error 2", "note 1", "note 2"]);
  });

  it("keeps an error on screen longer than a note", () => {
    useToasts.getState().push("Couldn't post it");
    expect(useToasts.getState().toasts[0].tone).toBe("error");
    vi.advanceTimersByTime(LIFETIME_MS.info + 1);
    expect(shown()).toBe("Couldn't post it");
    vi.advanceTimersByTime(LIFETIME_MS.error - LIFETIME_MS.info);
    expect(texts()).toEqual([]);
    expect(LIFETIME_MS.error).toBeGreaterThan(LIFETIME_MS.info);
  });

  it("shows the next one when the head is dismissed, with a fresh clock", () => {
    useToasts.getState().push("first", "info");
    vi.advanceTimersByTime(LIFETIME_MS.info - 10);
    useToasts.getState().push("second", "info");
    useToasts.getState().dismiss(useToasts.getState().toasts[0].id);
    expect(shown()).toBe("second");
    vi.advanceTimersByTime(LIFETIME_MS.info - 1);
    expect(shown()).toBe("second");
    vi.advanceTimersByTime(1);
    expect(texts()).toEqual([]);
  });

  it("drops a repeat of a toast that is on screen or waiting", () => {
    useToasts.getState().push("same", "info");
    useToasts.getState().push("other", "info");
    useToasts.getState().push("other", "info");
    useToasts.getState().push("same", "info");
    expect(texts()).toEqual(["same", "other"]);
  });

  it("keeps the action a toast carries", () => {
    const run = vi.fn();
    useToasts.getState().push("Stopped", "info", { label: "Undo", run });
    useToasts.getState().toasts[0].action!.run();
    expect(run).toHaveBeenCalled();
  });

  it("lets the oldest waiting toast give way past the cap, never the one on screen", () => {
    for (let i = 0; i < MAX_QUEUED + 3; i++) useToasts.getState().push(`t${i}`, "info");
    expect(texts()).toHaveLength(MAX_QUEUED);
    expect(shown()).toBe("t0");
    expect(texts().slice(-1)[0]).toBe(`t${MAX_QUEUED + 2}`);
    // An error waiting outlasts the notes when the queue is full.
    useToasts.getState().clear();
    useToasts.getState().push("on screen", "info");
    useToasts.getState().push("an error");
    for (let i = 0; i < MAX_QUEUED + 3; i++) useToasts.getState().push(`n${i}`, "info");
    expect(texts()).toHaveLength(MAX_QUEUED);
    expect(texts().slice(0, 2)).toEqual(["on screen", "an error"]);
  });
});
