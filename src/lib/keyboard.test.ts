import { describe, expect, it } from "vitest";
import { commandFor, type KeyInput } from "./keyboard";

const key = (k: string, over: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  typing: false,
  ...over,
});

describe("commandFor", () => {
  it("maps single-key shortcuts", () => {
    expect(commandFor(key("j"))).toBe("next");
    expect(commandFor(key("t"))).toBe("transition");
    expect(commandFor(key("e"))).toBe("done");
  });

  it("ignores single-key shortcuts while typing", () => {
    expect(commandFor(key("e", { typing: true }))).toBeNull();
    expect(commandFor(key("j", { typing: true }))).toBeNull();
  });

  it("keeps ⌘K, ⌘J and Escape working while typing", () => {
    expect(commandFor(key("k", { metaKey: true, typing: true }))).toBe("palette");
    expect(commandFor(key("j", { metaKey: true, typing: true }))).toBe("claude");
    expect(commandFor(key("Escape", { typing: true }))).toBe("escape");
  });

  it("does not treat modified keys as plain shortcuts", () => {
    expect(commandFor(key("c", { metaKey: true }))).toBeNull();
    expect(commandFor(key("e", { altKey: true }))).toBeNull();
  });
});
