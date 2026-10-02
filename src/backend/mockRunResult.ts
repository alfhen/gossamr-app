import type { CodeChange, JiraNote, RunKind, TicketProposal, WorkItemKind } from "../types";

const KEY = /\b[A-Za-z][A-Za-z0-9_]*-\d+\b/g;

const bare = (line: string) => line.trim().replace(/^[#>]+/, "").replace(/^[*_`\s]+/, "");

function headingRest(line: string, name: string): string | null {
  const b = bare(line);
  if (b.slice(0, name.length).toLowerCase() !== name) return null;
  const rest = b.slice(name.length).replace(/^[*_`\s]+/, "");
  if (rest.startsWith(":")) return rest.slice(1).replace(/^[*_`\s]+/, "");
  return line.trim().startsWith("#") && !rest.trim() ? "" : null;
}

const afterHeading = (line: string) => headingRest(line, "for jira");

/**
 * Follows fenced code blocks line by line as `Fences` in `runs/result.rs` does: three or more backticks or tildes,
 * indented at most three spaces, open one, only the same character at least as long with nothing after it closes it, and one left open runs to the end.
 * The returned function is true for a fence marker or a line inside a fence.
 */
function fenceTracker(): (line: string) => boolean {
  let open: { ch: string; len: number } | null = null;
  return (line) => {
    const indent = /^ */.exec(line)![0].length;
    const t = line.slice(indent);
    const ch = indent <= 3 && (t[0] === "`" || t[0] === "~") ? t[0] : null;
    let run = 0;
    while (ch && t[run] === ch) run++;
    const rest = t.slice(run);
    if (open) {
      if (ch === open.ch && run >= open.len && !rest.trim()) open = null;
      return true;
    }
    if (ch && run >= 3 && !(ch === "`" && rest.includes("`"))) {
      open = { ch, len: run };
      return true;
    }
    return false;
  };
}

/** The first line that is the `name` heading and not inside a code fence, or -1. */
function headingOutsideFences(lines: string[], name: string): number {
  const inside = fenceTracker();
  return lines.findIndex((l) => !inside(l) && headingRest(l, name) !== null);
}

function endsSection(raw: string): boolean {
  const t = raw.trim();
  const label = /^\p{Lu}[^:]{0,39}:$/u.test(t) && t.split(/\s+/).length <= 5;
  return t.startsWith("#") || /^([-*_])\1{2,}$/.test(t) || /^\*\*[^*]+(?::\*\*|\*\*:?)$/.test(t) || label || afterHeading(t) !== null;
}

/** Headings lose their `#`s and bold pairs their `**`, except inside code fences. */
function plain(text: string): string {
  const inside = fenceTracker();
  const lines = text.split("\n").map((l) => {
    if (inside(l)) return l.trimEnd();
    return l.replace(/^#{1,6} /, "").replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1").trimEnd();
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A small stand-in for the backend's parser of a result's `For Jira:` section, enough for the sample data. */
export function jiraNote(result: string): JiraNote {
  const lines = result.replace(/\r\n/g, "\n").split("\n");
  const start = headingOutsideFences(lines, "for jira");
  if (start >= 0) {
    const kept = [afterHeading(lines[start]) ?? ""];
    for (const l of lines.slice(start + 1)) {
      if (endsSection(l)) break;
      kept.push(l);
    }
    const text = plain(kept.join("\n"));
    if (text) return { text, fromMarker: true };
  }
  return { text: plain(result), fromMarker: false };
}

const TITLE_LIMIT = 120;
const BODY_LIMIT = 6_000;
const KINDS: WorkItemKind[] = ["task", "bug", "story"];

const titleCut = (title: string) => {
  const chars = [...title];
  return chars.length <= TITLE_LIMIT ? title : `${chars.slice(0, TITLE_LIMIT - 1).join("").trimEnd()}…`;
};

const oneLine = (text: string) => text.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1").split(/\s+/).filter(Boolean).join(" ").replace(/^[*_`\s]+|[*_`\s]+$/g, "");

function field(line: string, name: string): string | null {
  const b = line.trim().replace(/^[#>-]+/, "").replace(/^[*_`\s]+/, "");
  if (b.slice(0, name.length).toLowerCase() !== name) return null;
  const rest = b.slice(name.length).replace(/^[*_`\s]+/, "");
  return rest.startsWith(":") ? rest.slice(1).replace(/^[*_`\s]+/, "") : null;
}

/** The ticket in a result's `New ticket:` section, as `ticket_proposal` in `runs/result.rs` reads it. */
export function ticketProposal(result: string): TicketProposal | null {
  const lines = result.replace(/\r\n/g, "\n").split("\n");
  const start = headingOutsideFences(lines, "new ticket");
  if (start < 0) return null;
  const section = [headingRest(lines[start], "new ticket") ?? ""];
  const inside = fenceTracker();
  for (const l of lines.slice(start + 1)) {
    if (!inside(l) && headingRest(l, "for jira") !== null) break;
    section.push(l);
  }
  let title: string | null = null;
  let kind: WorkItemKind | null = null;
  let at = 0;
  while (at < section.length) {
    const line = section[at];
    const t = field(line, "title");
    const k = field(line, "kind");
    if (!line.trim() || /^([-*_])\1{2,}$/.test(line.trim())) at++;
    else if (title === null && t !== null) {
      const next = section.findIndex((l, i) => i > at && l.trim() !== "");
      if (t) (title = oneLine(t)), at++;
      else if (next >= 0 && field(section[next], "kind") === null) (title = oneLine(section[next])), (at = next + 1);
      else (title = ""), at++;
    } else if (kind === null && k !== null) {
      const word = /[A-Za-z]+/.exec(k)?.[0].toLowerCase();
      kind = KINDS.find((x) => x === word) ?? null;
      at++;
    } else break;
  }
  if (!title) return null;
  const body = plain(section.slice(at).join("\n"));
  return { title: titleCut(title), kind: kind ?? "task", body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT).trimEnd()}…` : body };
}

/** A draft ticket from an answer that has no `New ticket:` section: its first line is the title. */
export function ticketFromAnswer(result: string): TicketProposal | null {
  const text = plain(result);
  const first = text.split("\n").map((l) => oneLine(l.replace(/^[-*> ]+/, ""))).find(Boolean);
  return first ? { title: titleCut(first), kind: "task", body: text.length > 3_000 ? `${text.slice(0, 3_000).trimEnd()}…` : text } : null;
}

/** What the backend adds under a ticket made from a run. */
export const FOUND_BY = "Found by an agent that was asked to only read code and change nothing.";

export const ticketBody = (t: TicketProposal) => (t.body ? `${t.body}\n\n${FOUND_BY}` : FOUND_BY);

export const ticketKeys = (text: string): string[] => [...new Set((text.match(KEY) ?? []).map((k) => k.toUpperCase()))];

/** The comment as the backend first drafts it, for the sample data. */
export function commentText(note: JiraNote, change: CodeChange | null, kind: RunKind = "investigate"): string {
  const parts = [kind === "investigate" ? "Looked into this with an agent (it was asked to only read code and change nothing)." : "An agent worked on this."];
  if (!note.fromMarker) parts.push("The agent didn't mark anything for Jira, so this is its whole answer, shortened:");
  parts.push(note.text);
  if (change?.kind === "pullRequest") parts.push(`Pull request: ${change.url}`);
  return parts.join("\n\n");
}
