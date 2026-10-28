import { describe, expect, it } from "vitest";
import { needsKey, nextRegion, regionStep, wrapTab, type KeyEventLike, type NeedsKeyState } from "./workKeys";

const key = (k: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over });
const at = (over: Partial<NeedsKeyState> = {}): NeedsKeyState => ({ overlay: false, count: 4, at: 1, kind: "group", ...over });

/** A stand-in for an element: its tag, and whether it sits inside something editable. */
const el = (tagName: string, editable = false) => ({ tagName, isContentEditable: editable, closest: (s: string) => (editable && s.includes("contenteditable") ? {} : null) });

describe("needsKey: plain keys stay out of fields and overlays", () => {
  it("j, k and Enter are null in an input, a textarea, a select or anything editable", () => {
    for (const target of [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", true)]) {
      for (const k of ["j", "k", "Enter", "ArrowDown"]) expect(needsKey(key(k, { target }), at())).toBeNull();
    }
  });

  it("j, k and Enter are null while a dialog, the palette or the peek is open", () => {
    for (const k of ["j", "k", "Enter", " "]) expect(needsKey(key(k), at({ overlay: true }))).toBeNull();
  });

  it("leaves the keys to the page when the keyboard is on no row", () => {
    for (const k of ["Enter", "ArrowUp", "a", "s"]) expect(needsKey(key(k), at({ kind: null }))).toBeNull();
  });

  it("never acts with a modifier held", () => {
    expect(needsKey(key("j", { metaKey: true }), at())).toBeNull();
    expect(needsKey(key("Enter", { ctrlKey: true }), at())).toBeNull();
    expect(needsKey(key("k", { shiftKey: true }), at())).toBeNull();
  });

  it("Ctrl+Z and Cmd+Z undo, outside fields and overlays, and only plain with the modifier", () => {
    expect(needsKey(key("z", { ctrlKey: true }), at())).toEqual({ type: "undo" });
    expect(needsKey(key("Z", { metaKey: true }), at({ kind: null }))).toEqual({ type: "undo" });
    expect(needsKey(key("z"), at())).toBeNull();
    expect(needsKey(key("z", { ctrlKey: true, shiftKey: true }), at())).toBeNull();
    expect(needsKey(key("z", { ctrlKey: true, altKey: true }), at())).toBeNull();
    expect(needsKey(key("z", { ctrlKey: true, target: el("TEXTAREA") }), at())).toBeNull();
    expect(needsKey(key("z", { ctrlKey: true }), at({ overlay: true }))).toBeNull();
  });
});

describe("needsKey: stepping and opening", () => {
  it("j and ArrowDown go down, k and ArrowUp up", () => {
    expect(needsKey(key("j"), at({ at: 1 }))).toEqual({ type: "focus", index: 2 });
    expect(needsKey(key("ArrowDown"), at({ at: 1 }))).toEqual({ type: "focus", index: 2 });
    expect(needsKey(key("k"), at({ at: 1 }))).toEqual({ type: "focus", index: 0 });
    expect(needsKey(key("ArrowUp"), at({ kind: "need", at: 3 }))).toEqual({ type: "focus", index: 2 });
  });

  it("clamps at either end", () => {
    expect(needsKey(key("k"), at({ at: 0 }))).toEqual({ type: "focus", index: 0 });
    expect(needsKey(key("j"), at({ at: 3 }))).toEqual({ type: "focus", index: 3 });
  });

  it("from nothing focused, j starts at the top and k at the bottom; with nothing to step through, nothing", () => {
    expect(needsKey(key("j"), at({ at: -1, kind: "group" }))).toEqual({ type: "focus", index: 0 });
    expect(needsKey(key("k"), at({ at: -1, kind: "group" }))).toEqual({ type: "focus", index: 3 });
    expect(needsKey(key("j"), at({ count: 0, at: -1 }))).toBeNull();
  });

  describe("inside the open decision", () => {
    const inPane = (over: Partial<NeedsKeyState> = {}) => at({ kind: null, at: -1, pane: true, inPane: true, ...over });
    it("a, e, d and s act and Esc goes back", () => {
      expect(needsKey(key("s"), inPane())).toEqual({ type: "act", act: "skip" });
      expect(needsKey(key("a"), inPane())).toEqual({ type: "act", act: "approve" });
      expect(needsKey(key("e"), inPane())).toEqual({ type: "act", act: "edit" });
      expect(needsKey(key("d"), inPane())).toEqual({ type: "act", act: "dismiss" });
      expect(needsKey(key("Escape"), inPane())).toEqual({ type: "closePane" });
    });

    it("leaves Enter, Space, j and other keys to the focused button", () => {
      for (const k of ["Enter", " ", "j", "k", "x"]) expect(needsKey(key(k), inPane())).toBeNull();
    });

    it("ignores keys typed in the answer box, and with the pane not open or a modifier held", () => {
      for (const k of ["s", "a", "e", "d"]) expect(needsKey(key(k, { target: el("TEXTAREA") }), inPane())).toBeNull();
      expect(needsKey(key("s"), inPane({ pane: false }))).toBeNull();
      expect(needsKey(key("s"), inPane({ inPane: false }))).toBeNull();
      expect(needsKey(key("s", { metaKey: true }), inPane())).toBeNull();
      expect(needsKey(key("s"), inPane({ overlay: true }))).toBeNull();
    });
  });

  describe("on the Needs you list", () => {
    for (const kind of ["group", "need"] as const) {
      it(`${kind}: Enter, o, Space and → open the decision, ← folds, and a, e, d and s act on it`, () => {
        for (const k of ["Enter", "o", " ", "ArrowRight"]) expect(needsKey(key(k), at({ kind }))).toEqual({ type: "decide" });
        expect(needsKey(key("ArrowLeft"), at({ kind }))).toEqual({ type: "collapse" });
        expect(needsKey(key("a"), at({ kind }))).toEqual({ type: "act", act: "approve" });
        expect(needsKey(key("d"), at({ kind }))).toEqual({ type: "act", act: "dismiss" });
        expect(needsKey(key("s"), at({ kind }))).toEqual({ type: "act", act: "skip" });
        expect(needsKey(key("e"), at({ kind }))).toEqual({ type: "act", act: "edit" });
      });

      it(`${kind}: j and k still move, and Esc goes back from an open decision, else is left alone`, () => {
        expect(needsKey(key("j"), at({ kind, at: 1 }))).toEqual({ type: "focus", index: 2 });
        expect(needsKey(key("k"), at({ kind, at: 1 }))).toEqual({ type: "focus", index: 0 });
        expect(needsKey(key("Escape"), at({ kind, pane: true }))).toEqual({ type: "closePane" });
        expect(needsKey(key("Escape"), at({ kind, pane: false }))).toBeNull();
      });

      it(`${kind}: once a key asked for Enter, Enter confirms and every other key only cancels it`, () => {
        expect(needsKey(key("Enter"), at({ kind, asking: true }))).toEqual({ type: "confirm" });
        for (const k of ["a", "d", "e", "s", "o", "j", "k", "Escape", "ArrowRight", " ", "x"]) expect(needsKey(key(k), at({ kind, asking: true }))).toEqual({ type: "cancel" });
      });
    }

    it("leaves a key to a field while the person types, and to the page behind an overlay or a modifier", () => {
      expect(needsKey(key("a", { target: { tagName: "TEXTAREA" } }), at({ kind: "need" }))).toBeNull();
      expect(needsKey(key("a"), at({ kind: "need", overlay: true }))).toBeNull();
      expect(needsKey(key("a", { metaKey: true }), at({ kind: "need" }))).toBeNull();
    });
  });
});

describe("Tab at the last stop", () => {
  it("goes round to the first stop, only from the last, and only without a modifier", () => {
    expect(wrapTab(key("Tab"), ["a", "b", "c"], "c", true)).toBe("a");
    expect(wrapTab(key("Tab"), ["a", "b", "c"], "b", true)).toBeNull();
    expect(wrapTab(key("Tab", { shiftKey: true }), ["a", "b", "c"], "c", true)).toBeNull();
    expect(wrapTab(key("Tab"), ["a", "b", "c"], "c", false)).toBeNull();
  });
});

describe("the toast as an F6 stop", () => {
  it("is a stop in the workspace layout, after Pip's pane, only while a toast is shown", () => {
    const all = ["main", "peek", "pip", "toast"] as const;
    expect(nextRegion(all, "pip", 1)).toBe("toast");
    expect(nextRegion(all, "toast", 1)).toBe("main");
    expect(nextRegion(all, "main", -1)).toBe("toast");
    expect(nextRegion(["main", "pip"], "pip", 1)).toBe("main");
    expect(nextRegion(["main", "toast"], "main", 1)).toBe("toast");
  });
});

describe("the workspace layout's regions (D29)", () => {
  it("steps main, peek and Pip in order with F6, back with Shift+F6, wrapping and passing what isn't open", () => {
    const all = ["main", "peek", "pip"] as const;
    expect(nextRegion(all, "pip", 1)).toBe("main");
    expect(nextRegion(all, "main", 1)).toBe("peek");
    expect(nextRegion(all, "main", -1)).toBe("pip");
    expect(nextRegion(["main", "pip"], "main", 1)).toBe("pip");
    expect(nextRegion(["main", "pip"], "pip", 1)).toBe("main");
    expect(nextRegion(["main"], "main", 1)).toBe("main");
  });

  it("takes F6 from Pip's composer too, never from another field, and nothing with a modifier", () => {
    expect(regionStep(key("F6", { target: { tagName: "TEXTAREA", id: "pip-input" } }))).toBe(1);
    expect(regionStep(key("F6", { shiftKey: true }))).toBe(-1);
    expect(regionStep(key("F6", { target: { tagName: "TEXTAREA", id: "answer" } }))).toBe(0);
    expect(regionStep(key("F6", { target: { tagName: "INPUT", id: "search" } }))).toBe(1);
    expect(regionStep(key("F6", { shiftKey: true, target: { tagName: "INPUT" } }))).toBe(-1);
    expect(regionStep(key("F6", { ctrlKey: true }))).toBe(0);
    expect(regionStep(key("Tab"))).toBe(0);
  });
});
