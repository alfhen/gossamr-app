import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { HINTS, KEY_LABEL, keyIntent } from "../workspace/keyMap";
import { ShortcutHint } from "../workspace/ShortcutHint";
import { SHORTCUTS, footerHints, isTypingTarget, pressed, showOf, stepOf, type FooterOn, type KeyLike } from "./keys";

const el = (tagName: string, editable = false) => ({ tagName, isContentEditable: editable });
/** A child of an editable: not editable itself, but inside one, as a span in a rich-text field. */
const inEditable = (tagName: string) => ({ tagName, isContentEditable: false, closest: (s: string) => (s.startsWith("[contenteditable]") ? {} : null) });
const TYPING = [el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", true), inEditable("SPAN")];
const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: k, ...over });

describe("the shortcut table", () => {
  it("gives no two shortcuts the same key with the same modifiers in a screen or the app, which overlaps every screen (Escape is shared on purpose: each screen's Back and the app's Close are one press)", () => {
    const at = (s: (typeof SHORTCUTS)[number], scope: string, k: string) => `${scope}:${s.mod ? "mod+" : ""}${k}`;
    const seen = new Map<string, string>();
    const scopes = [...new Set(SHORTCUTS.map((s) => s.scope))].filter((x) => x !== "app");
    for (const s of SHORTCUTS) {
      for (const k of s.keys) {
        if (k === "Escape") continue;
        for (const scope of s.scope === "app" ? scopes : [s.scope]) {
          const id = at(s, scope, k);
          expect(seen.get(id), `${id} is ${seen.get(id)} and ${s.scope}.${s.id}`).toBeUndefined();
          seen.set(id, `${s.scope}.${s.id}`);
        }
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

  it("shows only keys the row itself has, or its partner's named in `with`", () => {
    const shown = (k: string) => (k.startsWith("⌘") ? k.slice(1).toLowerCase() : k);
    for (const s of SHORTCUTS.filter((x) => x.show)) {
      const partner = s.with ? SHORTCUTS.find((x) => x.scope === s.scope && x.id === s.with) : undefined;
      if (s.with) expect(partner, `${s.scope}.${s.id} names ${s.with}`).toBeDefined();
      const own = [...s.keys, ...(partner?.keys ?? [])].map((k) => KEY_LABEL[k] ?? k);
      for (const t of s.show!.split(" ")) expect(own, `${s.scope}.${s.id} shows ${t}`).toContain(shown(t));
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
  it("never fires a key a handler reads through the table while the person types in an input, a textarea, a select, an editable or a child of one", () => {
    const read = [["canvas", "step"], ["canvas", "menu"], ["inbox", "step"], ["inbox", "markRead"], ["work", "ask"], ["peek", "reply"]] as const;
    for (const target of TYPING) {
      for (const [scope, id] of read) {
        for (const k of SHORTCUTS.find((x) => x.scope === scope && x.id === id)!.keys) expect(pressed(key(k, { target }), scope, id), `${scope}.${id} on ${target.tagName}`).toBe(false);
      }
      expect(stepOf(key("j", { target }), "canvas")).toBe(0);
      expect(pressed(key("z", { ctrlKey: true, target }), "work", "undo")).toBe(false);
    }
  });

  it("never reads a list key as an intent while the person types in an input, a textarea, a select, an editable or a child of one", () => {
    for (const target of TYPING) {
      for (const s of SHORTCUTS.filter((x) => x.scope === "list")) {
        for (const k of s.keys) {
          expect(keyIntent(key(k, { target })), `list.${s.id} on ${target.tagName}`).toBeNull();
          expect(keyIntent(key(k, { target: el("BUTTON") })), `list.${s.id} on a button`).toBe(s.id);
        }
      }
    }
  });

  it("replies to a comment on R, Shift+R and Caps Lock R, and on no other modifier", () => {
    expect(pressed(key("r"), "peek", "reply")).toBe(true);
    expect(pressed(key("R", { shiftKey: true }), "peek", "reply")).toBe(true);
    expect(pressed(key("R"), "peek", "reply")).toBe(true);
    expect(pressed(key("r", { metaKey: true }), "peek", "reply")).toBe(false);
    expect(pressed(key("r", { altKey: true }), "peek", "reply")).toBe(false);
    expect(pressed(key("r", { target: el("TEXTAREA") }), "peek", "reply")).toBe(false);
  });

  it("steps on a capital J or K from Caps Lock, but not with Shift", () => {
    expect(stepOf(key("J"), "canvas")).toBe(1);
    expect(stepOf(key("K"), "inbox")).toBe(-1);
    expect(stepOf(key("J", { shiftKey: true }), "canvas")).toBe(0);
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
    expect(isTypingTarget(inEditable("SPAN"))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
