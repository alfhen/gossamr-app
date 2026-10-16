import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipHomeHints } from "./footerHints";
import { NOTICE, isTypingTarget, nextRegion, pipHomeKey, regionStep, type PipHomeKeyEvent, type PipHomeKeyState } from "./pipHomeKeys";
import { regionColumn } from "./pipHomeStore";
import { ShortcutHint } from "./ShortcutHint";

const key = (k: string, over: Partial<PipHomeKeyEvent> = {}): PipHomeKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over });
const at = (over: Partial<PipHomeKeyState> = {}): PipHomeKeyState => ({ column: "list", overlay: false, count: 4, at: 1, kind: "row", ...over });

/** A stand-in for an element: its tag, and whether it sits inside something editable. */
const el = (tagName: string, editable = false) => ({ tagName, isContentEditable: editable, closest: (s: string) => (editable && s.includes("contenteditable") ? {} : null) });

const ALL = ["needs", "week", "workstreams", "day", "pane", "timeline", "rail", "composer"] as const;
const SHOWN = ["needs", "workstreams", "timeline", "rail", "composer"] as const;
const f6 = (region: PipHomeKeyState["region"], over: Partial<PipHomeKeyEvent> = {}, state: Partial<PipHomeKeyState> = {}) => pipHomeKey(key("F6", over), at({ region, regions: ALL, ...state }));

describe("pipHomeKey: regions", () => {
  it("F6 goes through Needs you, the workstreams, the day card, the decision pane, the timeline, the steps and the composer, wrapping around", () => {
    const order = ["needs", "week", "workstreams", "day", "pane", "timeline", "rail", "composer", "needs"] as const;
    for (let i = 0; i < order.length - 1; i++) expect(f6(order[i])).toEqual({ type: "region", to: order[i + 1] });
    for (let i = order.length - 1; i > 0; i--) expect(f6(order[i], { shiftKey: true })).toEqual({ type: "region", to: order[i - 1] });
    expect(f6("needs", { shiftKey: true })).toEqual({ type: "region", to: "composer" });
  });

  it("meets the decision before the timeline, the order they sit on screen (G28)", () => {
    expect(f6("day")).toEqual({ type: "region", to: "pane" });
    expect(f6("pane")).toEqual({ type: "region", to: "timeline" });
    expect(f6("timeline", { shiftKey: true })).toEqual({ type: "region", to: "pane" });
  });

  it("This week is a stop between Needs you and the workstreams while it is shown, and passed by while it is not", () => {
    expect(f6("needs")).toEqual({ type: "region", to: "week" });
    expect(f6("week")).toEqual({ type: "region", to: "workstreams" });
    expect(f6("workstreams", { shiftKey: true })).toEqual({ type: "region", to: "week" });
    expect(f6("needs", {}, { regions: SHOWN })).toEqual({ type: "region", to: "workstreams" });
    expect(f6("week", {}, { regions: SHOWN })).toEqual({ type: "region", to: "workstreams" });
    expect(regionColumn("week")).toBe("list");
  });

  it("passes the decision pane by while none is open, and the steps while a workstream gives none", () => {
    // The clarity notice is a stop of its own while one is shown, at the top of the steps column (G26), and skipped otherwise.
    const noticed = ["needs", "workstreams", "timeline", "notice", "rail", "composer"] as const;
    expect(f6("timeline", {}, { regions: noticed })).toEqual({ type: "region", to: "notice" });
    expect(f6("notice", {}, { regions: noticed })).toEqual({ type: "region", to: "rail" });
    expect(f6("rail", { shiftKey: true }, { regions: noticed })).toEqual({ type: "region", to: "notice" });
    expect(f6("notice", { shiftKey: true }, { regions: noticed })).toEqual({ type: "region", to: "timeline" });
    expect(f6("workstreams", {}, { regions: SHOWN })).toEqual({ type: "region", to: "timeline" });
    expect(f6("timeline", {}, { regions: SHOWN })).toEqual({ type: "region", to: "rail" });
    expect(f6("rail", { shiftKey: true }, { regions: SHOWN })).toEqual({ type: "region", to: "timeline" });
    expect(f6("timeline", {}, { regions: ["needs", "workstreams", "timeline", "composer"] })).toEqual({ type: "region", to: "composer" });
    // Left in a region that is not on screen, the keys still leave it.
    expect(f6("pane", {}, { regions: SHOWN })).toEqual({ type: "region", to: "timeline" });
    expect(f6("pane", { shiftKey: true }, { regions: SHOWN })).toEqual({ type: "region", to: "workstreams" });
  });

  it("passes the day card by while neither Plan my week nor Start my day is shown", () => {
    expect(f6("workstreams", {}, { regions: SHOWN })).toEqual({ type: "region", to: "timeline" });
    expect(f6("timeline", { shiftKey: true }, { regions: SHOWN })).toEqual({ type: "region", to: "workstreams" });
    expect(f6("workstreams")).toEqual({ type: "region", to: "day" });
  });

  it("starts from the column's own region when none is given", () => {
    expect(pipHomeKey(key("F6"), at({ column: "list" }))).toEqual({ type: "region", to: "week" });
    expect(pipHomeKey(key("F6"), at({ column: "conversation" }))).toEqual({ type: "region", to: "needs" });
    expect(pipHomeKey(key("F6"), at({ column: "rail" }))).toEqual({ type: "region", to: "composer" });
  });

  it("Cmd+] and Ctrl+] go on, Cmd+[ and Ctrl+[ back", () => {
    expect(pipHomeKey(key("]", { metaKey: true }), at({ region: "needs", regions: ALL }))).toEqual({ type: "region", to: "week" });
    expect(pipHomeKey(key("]", { ctrlKey: true }), at({ region: "rail", regions: ALL }))).toEqual({ type: "region", to: "composer" });
    expect(pipHomeKey(key("[", { metaKey: true }), at({ region: "timeline", regions: ALL }))).toEqual({ type: "region", to: "pane" });
    expect(pipHomeKey(key("[", { ctrlKey: true }), at({ region: "needs", regions: ALL }))).toEqual({ type: "region", to: "composer" });
  });

  it("works from the composer, like Cmd/Ctrl+J, but not from another field, nor with Alt, nor with a plain ] or [", () => {
    const composer = { ...el("TEXTAREA"), id: "pip-input" };
    expect(f6("composer", { target: composer })).toEqual({ type: "region", to: "needs" });
    expect(pipHomeKey(key("[", { metaKey: true, target: composer }), at({ region: "composer", regions: ALL }))).toEqual({ type: "region", to: "rail" });
    // A budget field on the rail, or an answer to a run: the person is typing there.
    for (const target of [el("INPUT"), el("TEXTAREA"), el("DIV", true)]) {
      // F6 types nothing, so a single-line input lets it go (G7); a textarea and an editable div keep it.
      if (target.tagName !== "INPUT") expect(f6("rail", { target })).toBeNull();
      expect(pipHomeKey(key("[", { ctrlKey: true, target }), at({ region: "rail" }))).toBeNull();
    }
    const planAdd = { ...el("INPUT"), id: "data-plan-add" };
    expect(f6("week", { target: planAdd })).toEqual({ type: "region", to: "workstreams" });
    expect(f6("week", { target: planAdd, shiftKey: true })).toEqual({ type: "region", to: "needs" });
    expect(pipHomeKey(key("]", { metaKey: true, target: planAdd }), at({ region: "week", regions: ALL }))).toBeNull();
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

  it("Ctrl+Z and Cmd+Z undo, outside fields and overlays, and only plain with the modifier", () => {
    expect(pipHomeKey(key("z", { ctrlKey: true }), at())).toEqual({ type: "undo" });
    expect(pipHomeKey(key("Z", { metaKey: true }), at({ column: "conversation" }))).toEqual({ type: "undo" });
    expect(pipHomeKey(key("z"), at())).toBeNull();
    expect(pipHomeKey(key("z", { ctrlKey: true, shiftKey: true }), at())).toBeNull();
    expect(pipHomeKey(key("z", { ctrlKey: true, altKey: true }), at())).toBeNull();
    expect(pipHomeKey(key("z", { ctrlKey: true, target: el("TEXTAREA") }), at())).toBeNull();
    expect(pipHomeKey(key("z", { ctrlKey: true }), at({ overlay: true }))).toBeNull();
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

  describe("inside the open decision", () => {
    const inPane = (over: Partial<PipHomeKeyState> = {}) => at({ column: "conversation", kind: null, at: -1, pane: true, inPane: true, ...over });
    it("a, e, d and s act and Esc goes back, though the column is the conversation", () => {
      expect(pipHomeKey(key("s"), inPane())).toEqual({ type: "act", act: "skip" });
      expect(pipHomeKey(key("a"), inPane())).toEqual({ type: "act", act: "approve" });
      expect(pipHomeKey(key("e"), inPane())).toEqual({ type: "act", act: "edit" });
      expect(pipHomeKey(key("d"), inPane())).toEqual({ type: "act", act: "dismiss" });
      expect(pipHomeKey(key("Escape"), inPane())).toEqual({ type: "closePane" });
    });

    it("leaves Enter, Space, j and other keys to the focused button", () => {
      for (const k of ["Enter", " ", "j", "k", "x"]) expect(pipHomeKey(key(k), inPane())).toBeNull();
    });

    it("ignores keys typed in the answer box, and with the pane not open or a modifier held", () => {
      for (const k of ["s", "a", "e", "d"]) expect(pipHomeKey(key(k, { target: el("TEXTAREA") }), inPane())).toBeNull();
      expect(pipHomeKey(key("s"), inPane({ pane: false }))).toBeNull();
      expect(pipHomeKey(key("s"), inPane({ inPane: false }))).toBeNull();
      expect(pipHomeKey(key("s", { metaKey: true }), inPane())).toBeNull();
      expect(pipHomeKey(key("s"), inPane({ overlay: true }))).toBeNull();
    });
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

  it("names the region keys first, then j and k, Enter or o, the draft keys, ⌘↵ and Esc, each kept by rank as it narrows", () => {
    const hints = pipHomeHints();
    expect(hints.map((h) => h.keys.join(" "))).toEqual(["F6 ⌘]", "j k", "↵ o", "a e d s", "⌘↵", "Esc", "⌘K"]);
    expect(hints.slice(0, 2).every((h) => h.rank === 0)).toBe(true);
    const html = renderToStaticMarkup(createElement(ShortcutHint, { view: "list", hints }));
    expect(html).toContain("<kbd");
    expect(html).toContain("next region");
    expect(html).not.toContain("Drag a card");
  });
});

describe("the toast as an F6 stop", () => {
  it("comes after the composer on Pip home, and F6 from it goes back to the first region; passed by while no toast shows", () => {
    expect(f6("composer", {}, { regions: ["needs", "workstreams", "timeline", "rail", "composer", "toast"] })).toEqual({ type: "region", to: "toast" });
    expect(f6("toast", {}, { regions: ["needs", "workstreams", "timeline", "rail", "composer", "toast"] })).toEqual({ type: "region", to: "needs" });
    expect(f6("needs", { shiftKey: true }, { regions: ["needs", "workstreams", "timeline", "rail", "composer", "toast"] })).toEqual({ type: "region", to: "toast" });
    expect(f6("composer", {}, { regions: SHOWN })).toEqual({ type: "region", to: "needs" });
  });

  it("is a stop in the workspace layout too, after Pip's pane, only while a toast is shown", () => {
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
    expect(regionStep(key("F6", { target: { tagName: "INPUT", id: "data-plan-add" } }))).toBe(1);
    expect(regionStep(key("F6", { shiftKey: true, target: { tagName: "INPUT" } }))).toBe(-1);
    expect(regionStep(key("F6", { ctrlKey: true }))).toBe(0);
    expect(regionStep(key("Tab"))).toBe(0);
  });
});

describe("F6's notice stop (G7)", () => {
  it("covers the Under General offer as well as the clarity notice", () => {
    expect(NOTICE).toBe(":is([data-adopt-notice], [data-clarity-notice])");
  });
});
