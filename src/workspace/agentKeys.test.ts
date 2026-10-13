import { describe, expect, it, vi } from "vitest";
import { agentKey, ownKey } from "./agentKeys";

const press = (key: string, over: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) => ({ key, stopPropagation: vi.fn(), ...over });

describe("a button on a run's card", () => {
  it("keeps a plain key from the list's own keys", () => {
    for (const key of ["j", "a", "Enter", " ", "0"]) {
      const ev = press(key);
      ownKey(ev);
      expect(ev.stopPropagation, key).toHaveBeenCalledTimes(1);
    }
  });

  it("lets Cmd/Ctrl shortcuts through to the global keys, Ctrl+0 to Pip home among them", () => {
    for (const ev of [press("0", { ctrlKey: true }), press("0", { metaKey: true }), press("k", { metaKey: true }), press("j", { ctrlKey: true })]) {
      ownKey(ev);
      expect(ev.stopPropagation).not.toHaveBeenCalled();
    }
  });
});

describe("the Agents list's keys on a card", () => {
  it("acts only for a plain key on the card itself", () => {
    expect(agentKey({ key: "o" }, true, false)).toEqual({ type: "open" });
    expect(agentKey({ key: "o" }, false, false)).toBeNull();
    expect(agentKey({ key: "0", ctrlKey: true }, true, false)).toBeNull();
  });
});
