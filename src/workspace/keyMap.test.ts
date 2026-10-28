import { describe, expect, it } from "vitest";
import { agentKey } from "./agentKeys";
import { draftKeyAction } from "./draftKeys";
import { HINTS, KEY_BINDINGS, KEY_LABEL, isActionKey, keyHint, keyIntent, type KeyItem } from "./keyMap";
import { needsKey, type NeedsKeyState } from "./workKeys";
import { keyAction } from "./AgentsView";
import type { Proposal } from "../types";

const press = (key: string, over: Partial<Parameters<typeof keyIntent>[0]> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

describe("the one key model", () => {
  it("maps j and k (and the arrows) to move, Enter and o to open, a to approve, e to edit, d to dismiss, s to skip and Esc to back", () => {
    expect(["j", "ArrowDown"].map((k) => keyIntent(press(k)))).toEqual(["next", "next"]);
    expect(["k", "ArrowUp"].map((k) => keyIntent(press(k)))).toEqual(["prev", "prev"]);
    expect(["Enter", "o"].map((k) => keyIntent(press(k)))).toEqual(["open", "open"]);
    expect(keyIntent(press("a"))).toBe("approve");
    expect(keyIntent(press("e"))).toBe("edit");
    expect(keyIntent(press("d"))).toBe("dismiss");
    expect(keyIntent(press("s"))).toBe("skip");
    expect(keyIntent(press("Escape"))).toBe("back");
  });

  it("means nothing for any other key, and nothing with a modifier held", () => {
    for (const k of ["x", "A", "S", " ", "Tab", "F6", "c", "u", "m", "t"]) expect(keyIntent(press(k))).toBeNull();
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) for (const k of ["a", "d", "s", "e", "o", "j", "Enter"]) expect(keyIntent(press(k, { [mod]: true }))).toBeNull();
  });

  it("gives each key one intent only", () => {
    const keys = KEY_BINDINGS.flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("knows which keys a field being typed in must keep", () => {
    expect(["a", "e", "d", "s", "o"].every(isActionKey)).toBe(true);
    expect(["j", "k", "x", "Enter"].some(isActionKey)).toBe(false);
  });
});

describe("every list takes the same keys the same way", () => {
  const needs = (kind: "need" | "group"): NeedsKeyState => ({ overlay: false, count: 4, at: 1, kind });
  const comment = {
    id: "p1",
    state: { type: "pending" },
    intent: { type: "comment", item: { connectionId: "mock", externalId: "CA-1", key: "CA-1" }, body: { blocks: [] } },
  } as unknown as Proposal;

  it("the Needs you list", () => {
    const at = (k: string) => needsKey({ ...press(k), target: null }, needs("need"));
    expect(at("j")).toEqual({ type: "focus", index: 2 });
    expect(at("k")).toEqual({ type: "focus", index: 0 });
    expect(at("Enter")).toEqual({ type: "decide" });
    expect(at("o")).toEqual({ type: "decide" });
    expect(at("a")).toEqual({ type: "act", act: "approve" });
    expect(at("e")).toEqual({ type: "act", act: "edit" });
    expect(at("d")).toEqual({ type: "act", act: "dismiss" });
    expect(at("s")).toEqual({ type: "act", act: "skip" });
  });

  it("a draft card", () => {
    expect(draftKeyAction(comment, "Enter")).toBe("open");
    expect(draftKeyAction(comment, "o")).toBe("open");
    expect(draftKeyAction(comment, "a")).toBe("approve");
    expect(draftKeyAction(comment, "e")).toBe("edit");
    expect(draftKeyAction(comment, "d")).toBe("skip");
    expect(draftKeyAction(comment, "s")).toBe("skip");
  });

  it("the Agents list", () => {
    const on = (k: string) => agentKey(press(k), true, false);
    expect(on("o")).toEqual({ type: "open" });
    expect(on("a")).toEqual({ type: "act", act: "approve" });
    expect(on("e")).toEqual({ type: "act", act: "edit" });
    expect(on("d")).toEqual({ type: "act", act: "dismiss" });
    expect(on("s")).toEqual({ type: "act", act: "skip" });
    expect(keyAction("j", null, ["r1", "r2"])).toEqual({ type: "select", id: "r1" });
    expect(keyAction("k", "r2", ["r1", "r2"])).toEqual({ type: "select", id: "r1" });
    expect(keyAction("Escape", "r2", ["r1", "r2"])).toEqual({ type: "clear" });
  });

  it("the Agents list leaves a key pressed away from a card, or with a modifier, alone, and only cancels or confirms a waiting key", () => {
    expect(agentKey(press("a"), false, false)).toBeNull();
    expect(agentKey(press("a", { metaKey: true }), true, false)).toBeNull();
    expect(agentKey(press("Enter"), true, true)).toEqual({ type: "confirm" });
    for (const k of ["a", "d", "s", "e", "o", "j", "Escape"]) expect(agentKey(press(k), true, true)).toEqual({ type: "cancel" });
    expect(agentKey(press("x"), true, false)).toBeNull();
  });
});

describe("the hint lines", () => {
  it("name only keys the model has, with the words each list uses", () => {
    const labelled = new Set(KEY_BINDINGS.flatMap((b) => b.keys.map((k) => KEY_LABEL[k] ?? k)));
    for (const kind of Object.keys(HINTS) as KeyItem[]) {
      for (const [keys] of HINTS[kind]) {
        for (const k of keys.split(" ")) expect(labelled.has(k) || k === "Esc" || k === "↵").toBe(true);
      }
    }
    expect(keyHint("draft")).toBe("j k move · ↵ open · a approve · e edit · d s skip · Esc back");
    expect(keyHint("need")).toContain("d dismiss or deny");
    expect(keyHint("run")).toBe("j k move · ↵ open · a allow or retry · d dismiss or deny · Esc back");
  });
});
