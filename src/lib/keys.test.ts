import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { HINTS, KEY_LABEL } from "../workspace/keyMap";
import { ShortcutHint } from "../workspace/ShortcutHint";
import { SHORTCUTS, footerHints, isTypingTarget, pressed, showOf, stepOf, type FooterOn, type KeyLike } from "./keys";

const el = (tagName: string, editable = false) => ({ tagName, isContentEditable: editable });
const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: k, ...over });

describe("the shortcut table", () => {
  it("gives no two shortcuts in a screen the same key with the same modifiers", () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      for (const k of s.keys) {
        const at = `${s.scope}:${s.mod ? "mod+" : ""}${k}`;
        expect(seen.get(at), `${at} is ${seen.get(at)} and ${s.id}`).toBeUndefined();
        seen.set(at, s.id);
      }
    }
  });

  it("gives every shortcut a label, and every id once in its screen", () => {
    expect(SHORTCUTS.every((s) => s.label.length > 0 && s.keys.length > 0)).toBe(true);
    expect(new Set(SHORTCUTS.map((s) => `${s.scope}.${s.id}`)).size).toBe(SHORTCUTS.length);
  });

  it("lists in each footer exactly the shortcuts the table puts there, in its order", () => {
    for (const on of ["canvas", "work"] as FooterOn[]) {
      const fromTable = SHORTCUTS.filter((s) => s.footer?.[on]).map((s) => ({ id: `${s.scope}.${s.id}`, keys: s.show!.split(" "), text: s.footer![on]!.text }));
      const html = renderToStaticMarkup(createElement(ShortcutHint, { on }));
      const shown = [...html.matchAll(/<span class="[^"]*">(?: · )?((?:<span>(?: )?<kbd[^>]*>[^<]+<\/kbd><\/span>)+) ([^<]+)<\/span>/g)];
      expect(footerHints(on).map((h) => ({ id: h.id, keys: h.keys, text: h.text }))).toEqual(fromTable);
      expect(shown.map((m) => m[2])).toEqual(fromTable.map((h) => h.text));
      expect(shown.map((m) => [...m[1].matchAll(/<kbd[^>]*>([^<]+)<\/kbd>/g)].map((k) => k[1]))).toEqual(fromTable.map((h) => h.keys));
    }
  });

  it("shows every shortcut it shows with keys it has, and names the hint lines' keys from it", () => {
    const shown = new Set(SHORTCUTS.flatMap((s) => (s.show ? s.show.split(" ") : [])));
    const named = new Set(SHORTCUTS.filter((s) => s.scope === "list").flatMap((s) => s.keys.map((k) => KEY_LABEL[k] ?? k)));
    for (const kind of Object.keys(HINTS) as (keyof typeof HINTS)[]) {
      for (const [keys] of HINTS[kind]) for (const k of keys.split(" ")) expect(named.has(k) || shown.has(k), k).toBe(true);
    }
    expect(showOf("app", "pip")).toBe("⌘J");
    expect(showOf("app", "jump")).toBe("⌘K");
  });
});

describe("pressing a shortcut", () => {
  it("never fires a plain key while the person types in an input, a textarea, a select or an editable", () => {
    for (const target of [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", true)]) {
      for (const s of SHORTCUTS.filter((x) => !x.mod && !x.inFields)) {
        for (const k of s.keys) expect(pressed(key(k, { target }), s.scope, s.id), `${s.scope}.${s.id} on ${target.tagName}`).toBe(false);
      }
      expect(stepOf(key("j", { target }), "canvas")).toBe(0);
      expect(pressed(key("z", { ctrlKey: true, target }), "work", "undo")).toBe(false);
    }
  });

  it("fires the same keys outside a field", () => {
    expect(pressed(key("n", { target: el("BUTTON") }), "work", "ask")).toBe(true);
    expect(stepOf(key("j"), "canvas")).toBe(1);
    expect(stepOf(key("k"), "inbox")).toBe(-1);
    expect(stepOf(key("x"), "canvas")).toBe(0);
    expect(pressed(key("z", { ctrlKey: true }), "work", "undo")).toBe(true);
  });

  it("fires the app's jump, Pip and region keys in a field, with exactly the modifiers they name", () => {
    expect(pressed(key("k", { metaKey: true, target: el("TEXTAREA") }), "app", "jump")).toBe(true);
    expect(pressed(key("J", { ctrlKey: true, target: el("INPUT") }), "app", "pip")).toBe(true);
    expect(pressed(key("k", { metaKey: true, shiftKey: true }), "app", "jump")).toBe(false);
    expect(pressed(key("k", { metaKey: true, altKey: true }), "app", "jump")).toBe(false);
    expect(pressed(key("k"), "app", "jump")).toBe(false);
    expect(pressed(key("j", { metaKey: true }), "canvas", "step")).toBe(false);
    expect(pressed(key("F6", { shiftKey: true, target: el("TEXTAREA") }), "app", "regions")).toBe(true);
    expect(pressed(key("F6", { ctrlKey: true }), "app", "regions")).toBe(false);
  });

  it("tells typing targets apart", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("textarea"))).toBe(true);
    expect(isTypingTarget(el("SPAN", true))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
