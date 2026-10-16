import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_KEY_OFF } from "./commands";
import { useToasts } from "./toasts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  useToasts.getState().clear();
  vi.useRealTimers();
});

const texts = () => useToasts.getState().toasts.map((t) => t.text);

describe("a note that answers a keypress (G30)", () => {
  it("takes the screen from a note about something else instead of queuing behind it", () => {
    const toasts = useToasts.getState();
    toasts.push("Agent started on CA-402", "info");
    toasts.push("Held CA-401", "info");
    toasts.push(GENERAL_KEY_OFF, "info", undefined, { now: true });
    expect(texts()).toEqual([GENERAL_KEY_OFF, "Held CA-401"]);
  });

  it("shows at once when nothing is on screen, and an ordinary note still queues", () => {
    const toasts = useToasts.getState();
    toasts.push(GENERAL_KEY_OFF, "info", undefined, { now: true });
    toasts.push("Later", "info");
    expect(texts()).toEqual([GENERAL_KEY_OFF, "Later"]);
  });

  it("waits behind an error or an offer to undo, ahead of the notes waiting", () => {
    const toasts = useToasts.getState();
    toasts.push("Couldn't post", "error");
    toasts.push("A note", "info");
    toasts.push(GENERAL_KEY_OFF, "info", undefined, { now: true });
    expect(texts()).toEqual(["Couldn't post", GENERAL_KEY_OFF, "A note"]);
    useToasts.getState().clear();
    toasts.push("Skipped the draft.", "info", undefined, { keep: true });
    toasts.push(GENERAL_KEY_OFF, "info", undefined, { now: true });
    expect(texts()).toEqual(["Skipped the draft.", GENERAL_KEY_OFF]);
  });

  it("is on the clock of its own once it is the one on screen", () => {
    const toasts = useToasts.getState();
    toasts.push("Agent started on CA-402", "info");
    toasts.push(GENERAL_KEY_OFF, "info", undefined, { now: true });
    vi.advanceTimersByTime(5_100);
    expect(texts()).toEqual([]);
  });
});
