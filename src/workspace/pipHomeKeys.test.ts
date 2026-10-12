import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipHomeHints } from "./footerHints";
import { isTypingTarget, nextRegion, pipHomeKey, regionStep, type PipHomeKeyEvent, type PipHomeKeyState } from "./pipHomeKeys";
import { ShortcutHint } from "./ShortcutHint";

const key = (k: string, over: Partial<PipHomeKeyEvent> = {}): PipHomeKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over });
const at = (over: Partial<PipHomeKeyState> = {}): PipHomeKeyState => ({ column: "list", overlay: false, count: 4, at: 1, kind: "row", ...over });

/** A stand-in for an element: its tag, and whether it sits inside something editable. */
const el = (tagName: string, editable = false) => ({ tagName, isContentEditable: editable, closest: (s: string) => (editable && s.includes("contenteditable") ? {} : null) });

describe("pipHomeKey: columns", () => {
  it("F6 goes right and Shift+F6 left, wrapping around", () => {
    expect(pipHomeKey(key("F6"), at({ column: "list" }))).toEqual({ type: "column", to: "conversation" });
    expect(pipHomeKey(key("F6"), at({ column: "conversation" }))).toEqual({ type: "column", to: "rail" });
    expect(pipHomeKey(key("F6"), at({ column: "rail" }))).toEqual({ type: "column", to: "list" });
    expect(pipHomeKey(key("F6", { shiftKey: true }), at({ column: "list" }))).toEqual({ type: "column", to: "rail" });
    expect(pipHomeKey(key("F6", { shiftKey: true }), at({ column: "conversation" }))).toEqual({ type: "column", to: "list" });
  });

  it("Cmd+] and Ctrl+] go right, Cmd+[ and Ctrl+[ left", () => {
    expect(pipHomeKey(key("]", { metaKey: true }), at({ column: "list" }))).toEqual({ type: "column", to: "conversation" });
    expect(pipHomeKey(key("]", { ctrlKey: true }), at({ column: "rail" }))).toEqual({ type: "column", to: "list" });
    expect(pipHomeKey(key("[", { metaKey: true }), at({ column: "conversation" }))).toEqual({ type: "column", to: "list" });
    expect(pipHomeKey(key("[", { ctrlKey: true }), at({ column: "list" }))).toEqual({ type: "column", to: "rail" });
  });

  it("works from the composer, like Cmd/Ctrl+J, but not from another field, nor with Alt, nor with a plain ] or [", () => {
    const composer = { ...el("TEXTAREA"), id: "pip-input" };
    expect(pipHomeKey(key("F6", { target: composer }), at({ column: "conversation" }))).toEqual({ type: "column", to: "rail" });
    expect(pipHomeKey(key("]", { metaKey: true, target: composer }), at({ column: "conversation" }))).toEqual({ type: "column", to: "rail" });
    // A budget field on the rail, or an answer to a run: the person is typing there.
    for (const target of [el("INPUT"), el("TEXTAREA"), el("DIV", true)]) {
      expect(pipHomeKey(key("F6", { target }), at({ column: "rail" }))).toBeNull();
      expect(pipHomeKey(key("[", { ctrlKey: true, target }), at({ column: "rail" }))).toBeNull();
    }
    expect(pipHomeKey(key("F6", { altKey: true }), at())).toBeNull();
    expect(pipHomeKey(key("]"), at())).toBeNull();
    expect(pipHomeKey(key("[", { metaKey: true, shiftKey: true }), at())).toBeNull();
  });

  it("does nothing while something is open over Pip home", () => {
    expect(pipHomeKey(key("F6"), at({ overlay: true }))).toBeNull();
    expect(pipHomeKey(key("]", { ctrlKey: true }), at({ overlay: true }))).toBeNull();
  });
});

describe("pipHomeKey: plain keys stay out of fields and overlays", () => {
  it("j, k and Enter are null in an input, a textarea, a select or anything editable", () => {
    for (const target of [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", true)]) {
      for (const k of ["j", "k", "Enter", "ArrowDown"]) expect(pipHomeKey(key(k, { target }), at())).toBeNull();
    }
  });

  it("j, k and Enter are null while a dialog, the palette or the peek is open", () => {
    for (const k of ["j", "k", "Enter", " "]) expect(pipHomeKey(key(k), at({ overlay: true }))).toBeNull();
  });

  it("leaves the conversation's keys to its cards and composer", () => {
    for (const k of ["j", "k", "Enter", "ArrowUp"]) expect(pipHomeKey(key(k), at({ column: "conversation", kind: "draft" }))).toBeNull();
  });

  it("never acts with a modifier held", () => {
    expect(pipHomeKey(key("j", { metaKey: true }), at())).toBeNull();
    expect(pipHomeKey(key("Enter", { ctrlKey: true }), at())).toBeNull();
    expect(pipHomeKey(key("k", { shiftKey: true }), at())).toBeNull();
  });

  it("tells typing targets apart", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("textarea"))).toBe(true);
    expect(isTypingTarget(el("SPAN", true))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("pipHomeKey: stepping and opening", () => {
  it("j and ArrowDown go down, k and ArrowUp up, in the list and the rail alike", () => {
    expect(pipHomeKey(key("j"), at({ at: 1 }))).toEqual({ type: "focus", index: 2 });
    expect(pipHomeKey(key("ArrowDown"), at({ at: 1 }))).toEqual({ type: "focus", index: 2 });
    expect(pipHomeKey(key("k"), at({ at: 1 }))).toEqual({ type: "focus", index: 0 });
    expect(pipHomeKey(key("ArrowUp"), at({ column: "rail", kind: "chip", at: 3 }))).toEqual({ type: "focus", index: 2 });
  });

  it("clamps at either end", () => {
    expect(pipHomeKey(key("k"), at({ at: 0 }))).toEqual({ type: "focus", index: 0 });
    expect(pipHomeKey(key("j"), at({ at: 3 }))).toEqual({ type: "focus", index: 3 });
    expect(pipHomeKey(key("j"), at({ column: "rail", count: 6, at: 5, kind: "chip" }))).toEqual({ type: "focus", index: 5 });
  });

  it("from nothing focused, j starts at the top and k at the bottom; with nothing to step through, nothing", () => {
    expect(pipHomeKey(key("j"), at({ at: -1, kind: null }))).toEqual({ type: "focus", index: 0 });
    expect(pipHomeKey(key("k"), at({ at: -1, kind: null }))).toEqual({ type: "focus", index: 3 });
    expect(pipHomeKey(key("j"), at({ count: 0, at: -1, kind: null }))).toBeNull();
  });

  it("Enter or Space opens a workstream's row and toggles a chip", () => {
    expect(pipHomeKey(key("Enter"), at({ kind: "row" }))).toEqual({ type: "open" });
    expect(pipHomeKey(key(" "), at({ kind: "row" }))).toEqual({ type: "open" });
    expect(pipHomeKey(key("Enter"), at({ column: "rail", kind: "chip" }))).toEqual({ type: "toggle" });
    expect(pipHomeKey(key(" "), at({ column: "rail", kind: "chip" }))).toEqual({ type: "toggle" });
  });

  describe("on the Needs you list", () => {
    for (const kind of ["group", "need"] as const) {
      it(`${kind}: Enter, o, Space and → open the decision, ← folds, and a, e, d and s act on it`, () => {
        for (const k of ["Enter", "o", " ", "ArrowRight"]) expect(pipHomeKey(key(k), at({ kind }))).toEqual({ type: "decide" });
        expect(pipHomeKey(key("ArrowLeft"), at({ kind }))).toEqual({ type: "collapse" });
        expect(pipHomeKey(key("a"), at({ kind }))).toEqual({ type: "act", act: "approve" });
        expect(pipHomeKey(key("d"), at({ kind }))).toEqual({ type: "act", act: "dismiss" });
        expect(pipHomeKey(key("s"), at({ kind }))).toEqual({ type: "act", act: "skip" });
        expect(pipHomeKey(key("e"), at({ kind }))).toEqual({ type: "act", act: "edit" });
      });

      it(`${kind}: j and k still move, and Esc goes back from an open decision, else is left alone`, () => {
        expect(pipHomeKey(key("j"), at({ kind, at: 1 }))).toEqual({ type: "focus", index: 2 });
        expect(pipHomeKey(key("k"), at({ kind, at: 1 }))).toEqual({ type: "focus", index: 0 });
        expect(pipHomeKey(key("Escape"), at({ kind, pane: true }))).toEqual({ type: "closePane" });
        expect(pipHomeKey(key("Escape"), at({ kind, pane: false }))).toBeNull();
      });

      it(`${kind}: once a key asked for Enter, Enter confirms and every other key only cancels it`, () => {
        expect(pipHomeKey(key("Enter"), at({ kind, asking: true }))).toEqual({ type: "confirm" });
        for (const k of ["a", "d", "e", "s", "o", "j", "k", "Escape", "ArrowRight", " ", "x"]) expect(pipHomeKey(key(k), at({ kind, asking: true }))).toEqual({ type: "cancel" });
      });
    }

    it("leaves a, d, e and s to the page on a workstream's row, a chip and a card, and to a field while the person types", () => {
      for (const kind of ["row", "chip", "run", "draft"] as const) for (const k of ["a", "d", "e", "s"]) expect(pipHomeKey(key(k), at({ kind }))).toBeNull();
      expect(pipHomeKey(key("a", { target: { tagName: "TEXTAREA" } }), at({ kind: "need" }))).toBeNull();
      expect(pipHomeKey(key("a"), at({ kind: "need", overlay: true }))).toBeNull();
      expect(pipHomeKey(key("a", { metaKey: true }), at({ kind: "need" }))).toBeNull();
    });
  });

  it("Enter or o opens a run card on the rail; a draft card there keeps its own keys", () => {
    expect(pipHomeKey(key("Enter"), at({ column: "rail", kind: "run" }))).toEqual({ type: "open" });
    expect(pipHomeKey(key("o"), at({ column: "rail", kind: "run" }))).toEqual({ type: "open" });
    expect(pipHomeKey(key(" "), at({ column: "rail", kind: "run" }))).toBeNull();
    expect(pipHomeKey(key("Enter"), at({ column: "rail", kind: "draft" }))).toBeNull();
    expect(pipHomeKey(key("Enter"), at({ kind: null, at: -1 }))).toBeNull();
  });
});

describe("Pip home's footer hint", () => {
  it("names the Needs you list's keys in place of the draft keys while a row has the keyboard", () => {
    const hints = pipHomeHints(true);
    expect(hints.map((h) => h.keys.join(" "))).toEqual(["F6 ⌘]", "j k", "↵ o", "a e d s", "⌘↵", "Esc", "⌘K"]);
    expect(hints.find((h) => h.id === "needs")?.text).toBe("approve or allow (then ↵), edit, dismiss or deny, skip");
    expect(hints.some((h) => h.keys.join(" ") === "a s")).toBe(false);
    expect(pipHomeHints().some((h) => h.id === "needs")).toBe(false);
  });

  it("names the column keys first, then j and k, Enter or o, the draft keys, ⌘↵ and Esc, each kept by rank as it narrows", () => {
    const hints = pipHomeHints();
    expect(hints.map((h) => h.keys.join(" "))).toEqual(["F6 ⌘]", "j k", "↵ o", "a e d s", "⌘↵", "Esc", "⌘K"]);
    expect(hints.slice(0, 2).every((h) => h.rank === 0)).toBe(true);
    const html = renderToStaticMarkup(createElement(ShortcutHint, { view: "list", hints }));
    expect(html).toContain("<kbd");
    expect(html).toContain("next column");
    expect(html).not.toContain("Drag a card");
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
    expect(regionStep(key("F6", { ctrlKey: true }))).toBe(0);
    expect(regionStep(key("Tab"))).toBe(0);
  });
});
