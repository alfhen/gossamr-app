import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speakQuietToasts, useToasts } from "./toasts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  useToasts.getState().clear();
  vi.useRealTimers();
});

const texts = () => useToasts.getState().toasts.map((t) => t.text);
const offer = (text: string) => useToasts.getState().push(text, "info", { label: "Undo", run: () => undefined }, { keep: true });

describe("stacked Undo offers (G3)", () => {
  it("shows the newest offer first, with the older one behind it", () => {
    offer("Brought 2 runs on CA-401 here.");
    offer("Brought 1 run on CA-402 here.");
    offer("Brought 3 runs on CA-403 here.");
    expect(texts()).toEqual(["Brought 3 runs on CA-403 here.", "Brought 1 run on CA-402 here.", "Brought 2 runs on CA-401 here."]);
  });

  it("still queues behind an error on screen", () => {
    useToasts.getState().push("Couldn't post", "error");
    offer("Held CA-401.");
    offer("Held CA-402.");
    expect(texts()).toEqual(["Couldn't post", "Held CA-402.", "Held CA-401."]);
  });

  it("replaces an offer with the same words, on screen or not", () => {
    offer("Held CA-401.");
    offer("Held CA-401.");
    expect(texts()).toEqual(["Held CA-401."]);
  });
});

describe("a toast already said elsewhere (G6)", () => {
  it("keeps spoken: false only when it was given, so the live region can stay quiet", () => {
    useToasts.getState().push("Skipped the draft.", "info", undefined, { spoken: false });
    useToasts.getState().push("Held CA-401.", "info");
    const [first, second] = useToasts.getState().toasts;
    expect(first.spoken).toBe(false);
    expect(second.spoken).toBeUndefined();
  });
});

describe("speakQuietToasts (G6)", () => {
  it("lets a quiet toast speak after all, and leaves the others alone", () => {
    useToasts.getState().push("Skipped the draft.", "info", undefined, { spoken: false });
    speakQuietToasts();
    expect(useToasts.getState().toasts[0].spoken).toBeUndefined();
  });
});
