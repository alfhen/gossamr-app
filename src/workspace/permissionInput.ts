import type { PermissionKind } from "../types";

/** A run of plain text, or a character a terminal would hide, shown as a marked placeholder. */
export type Seg = { text: string } | { hidden: string };

/** A field of a request's input, by its own name: plain text as lines, or a change as the lines it removes and adds. */
export type InputField = { name: Seg[]; type: "text"; lines: Seg[][] } | { name: Seg[]; type: "change"; removed: Seg[][]; added: Seg[][] };

const NAMES: Record<number, string> = { 0x00: "NUL", 0x07: "BEL", 0x08: "BS", 0x0b: "VT", 0x0c: "FF", 0x0d: "CR", 0x1b: "ESC", 0x7f: "DEL" };

/**
 * Whether a terminal would hide `code`, or show it as something else: control characters (ESC starts an ANSI escape),
 * bidirectional marks, which can make a command read backwards, and zero-width characters. A tab and a line break stay.
 */
export function hides(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x061c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

export const placeholder = (code: number) => `⟨${NAMES[code] ?? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`}⟩`;

/** `text` with every character a terminal would hide marked, as segments. */
export function segments(text: string): Seg[] {
  const out: Seg[] = [];
  let plain = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (!hides(code)) {
      plain += ch;
      continue;
    }
    if (plain) out.push({ text: plain });
    plain = "";
    out.push({ hidden: placeholder(code) });
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** `text` as its lines, each with its hidden characters marked. */
export const lines = (text: string): Seg[][] => text.split("\n").map(segments);

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value));
const text = (name: string, value: unknown): InputField => ({ name: segments(name), type: "text", lines: lines(asText(value)) });
const change = (name: string, removed: unknown, added: unknown): InputField => ({ name: segments(name), type: "change", removed: removed == null || removed === "" ? [] : lines(asText(removed)), added: added == null || added === "" ? [] : lines(asText(added)) });

/** The fields a kind puts first, in the order a person reads them. */
const FIRST: Partial<Record<PermissionKind, readonly string[]>> = {
  command: ["command"],
  file_change: ["file_path", "path", "notebook_path"],
};

/** One edit's fields: its old and new text as one change, and anything else it carries by name. */
function editFields(prefix: string, edit: Record<string, unknown>): InputField[] {
  const changes = "old_string" in edit || "new_string" in edit;
  const rest = Object.entries(edit).filter(([key]) => !changes || (key !== "old_string" && key !== "new_string"));
  return [...(changes ? [change(`${prefix}old_string → ${prefix}new_string`, edit.old_string, edit.new_string)] : []), ...rest.map(([key, value]) => text(`${prefix}${key}`, value))];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Every field of a request's input, so a person sees all an allow passes the agent: the command or path first, a file's
 * content or an edit's old and new text as a change, then every other field by its name. Nothing is cut or dropped; a
 * value that is not text is shown as JSON.
 */
export function inputFields(kind: PermissionKind, input: unknown): InputField[] {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [text("input", value)];
    }
  }
  if (value == null) return [];
  if (!isRecord(value)) return [text("input", value)];
  const first = (FIRST[kind] ?? []).filter((key) => key in value);
  const out = first.map((key) => text(key, value[key]));
  const done = new Set(first);
  if (kind === "file_change") {
    if ("old_string" in value || "new_string" in value) {
      out.push(change("old_string → new_string", value.old_string, value.new_string));
      done.add("old_string").add("new_string");
    }
    if ("content" in value) {
      out.push(change("content", null, value.content));
      done.add("content");
    }
    const edits = value.edits;
    if (Array.isArray(edits) && edits.every(isRecord)) {
      edits.forEach((edit, i) => out.push(...editFields(`edits[${i}].`, edit)));
      done.add("edits");
    }
  }
  return [...out, ...Object.entries(value).filter(([key]) => !done.has(key)).map(([key, v]) => text(key, v))];
}
