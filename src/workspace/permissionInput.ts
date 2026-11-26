import type { PermissionKind } from "../types";

/** A run of plain text, or what a terminal would hide, shown as a marked placeholder with a name a screen reader says. */
/** `lossy`: the placeholder stands for more than it shows, as a count of combining marks does for which marks they are. */
export type Seg = { text: string } | { hidden: string; label: string; lossy?: true };

/** A field of a request's input, by its own name: plain text as lines, or a change as the lines it removes and adds. */
export type InputField = { name: Seg[]; type: "text"; lines: Seg[][]; valueType?: string } | { name: Seg[]; type: "change"; removed: Seg[][]; added: Seg[][]; valueType?: string };

const NAMES: Record<number, string> = { 0x00: "NUL", 0x07: "BEL", 0x08: "BS", 0x0b: "VT", 0x0c: "FF", 0x0d: "CR", 0x1b: "ESC", 0x7f: "DEL" };

/**
 * What a terminal hides, or shows as something else: control characters (ESC starts an ANSI escape), format characters
 * such as the bidirectional marks that can make a command read backwards, line and paragraph separators, private-use and
 * unassigned code points, and every character Unicode says to draw as nothing (zero-width spaces, U+034F, Hangul fillers,
 * variation selectors, tag characters). The placeholder's own brackets are marked too, so typed text can't pass for one.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u27e8\u27e9]/u;

/** Whether a terminal would hide `code`, or it could pass for a placeholder. A tab and a line break stay as they are. */
export function hides(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return HIDDEN.test(String.fromCodePoint(code));
}

const codeName = (code: number) => NAMES[code] ?? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
export const placeholder = (code: number) => `⟨${codeName(code)}⟩`;

/** A combining mark, drawn on the character before it. */
const MARK = /[\p{Mn}\p{Me}]/u;

/** Combining marks on one character from which they are one placeholder: more stack over the lines around them. */
const MARKS_SHOWN = 2;

/** `text` with every character a terminal would hide marked, and a stack of combining marks counted, as segments. */
export function segments(text: string): Seg[] {
  const out: Seg[] = [];
  const chars = Array.from(text);
  let plain = "";
  const mark = (seg: Seg) => {
    if (plain) out.push({ text: plain });
    plain = "";
    out.push(seg);
  };
  for (let i = 0; i < chars.length; ) {
    const code = chars[i].codePointAt(0)!;
    if (hides(code)) {
      mark({ hidden: placeholder(code), label: `hidden character ${codeName(code)}` });
      i++;
      continue;
    }
    let end = i;
    while (end < chars.length && MARK.test(chars[end]) && !hides(chars[end].codePointAt(0)!)) end++;
    if (end - i > MARKS_SHOWN) {
      mark({ hidden: `⟨${end - i} combining marks⟩`, label: `${end - i} combining marks`, lossy: true });
      i = end;
    } else if (end > i) {
      plain += chars.slice(i, end).join("");
      i = end;
    } else {
      plain += chars[i];
      i++;
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** Blank lines in a row from which they are one marked line, so a gap can't push what follows out of mind. */
const BLANK_RUN = 3;

/** `text` as its lines, each with its hidden characters marked, and a run of blank lines as one marked line. */
export function lines(text: string): Seg[][] {
  const out: Seg[][] = [];
  const all = text.split("\n");
  for (let i = 0; i < all.length; ) {
    let end = i;
    // Blank is empty or spaces and tabs: a line of anything else, even what trim() drops, is shown and marked.
    while (end < all.length && /^[ \t]*$/.test(all[end])) end++;
    if (end - i >= BLANK_RUN) {
      out.push([{ hidden: `⟨${end - i} blank lines⟩`, label: `${end - i} blank lines` }]);
      i = end;
    } else {
      out.push(segments(all[i]));
      i++;
    }
  }
  return out;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value));
/** The type of a value that isn't text, named beside its field, so `false` the value and "false" the text read apart. */
const typeOf = (value: unknown): string | undefined => (typeof value === "string" ? undefined : value === null ? "null" : Array.isArray(value) ? "list" : typeof value);
const text = (name: string, value: unknown): InputField => ({ name: segments(name), type: "text", lines: lines(asText(value)), ...(typeOf(value) ? { valueType: typeOf(value) } : {}) });
/** The types of a change's sides that aren't text, so a content of `false` reads apart from one of "false". */
const typesOf = (...values: unknown[]) => [...new Set(values.filter((v) => v != null && v !== "").map(typeOf).filter((t): t is string => !!t))].join(", ") || undefined;
const change = (name: string, removed: unknown, added: unknown): InputField => ({ name: segments(name), type: "change", removed: removed == null || removed === "" ? [] : lines(asText(removed)), added: added == null || added === "" ? [] : lines(asText(added)), ...(typesOf(removed, added) ? { valueType: typesOf(removed, added) } : {}) });

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
    if (Array.isArray(edits) && edits.length > 0 && edits.every(isRecord)) {
      edits.forEach((edit, i) => out.push(...editFields(`edits[${i}].`, edit)));
      done.add("edits");
    }
  }
  return [...out, ...Object.entries(value).filter(([key]) => !done.has(key)).map(([key, v]) => text(key, v))];
}

/**
 * Why an input can't be shown exactly as an Allow would pass it, or null when it can: a stack of combining marks is shown
 * as a count, not as which marks; an integer past 2^53 arrives rounded, so the page would show another number than the
 * agent runs. Keys and values, at any depth.
 */
export function inexactIn(value: unknown): "marks" | "number" | null {
  if (typeof value === "string") return segments(value).some((seg) => "lossy" in seg) ? "marks" : null;
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value) ? "number" : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const why = inexactIn(item);
      if (why) return why;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const why = inexactIn(key) ?? inexactIn(item);
      if (why) return why;
    }
  }
  return null;
}
