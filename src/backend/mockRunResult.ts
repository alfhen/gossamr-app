import type { CodeChange, JiraNote } from "../types";

const KEY = /\b[A-Za-z][A-Za-z0-9_]*-\d+\b/g;

const bare = (line: string) => line.trim().replace(/^[#>]+/, "").replace(/^[*_`\s]+/, "");

function afterHeading(line: string): string | null {
  const b = bare(line);
  if (b.slice(0, 8).toLowerCase() !== "for jira") return null;
  const rest = b.slice(8).replace(/^[*_`\s]+/, "");
  if (rest.startsWith(":")) return rest.slice(1).replace(/^[*_`\s]+/, "");
  return line.trim().startsWith("#") && !rest.trim() ? "" : null;
}

function endsSection(raw: string): boolean {
  const t = raw.trim();
  const label = /^\p{Lu}[^:]{0,39}:$/u.test(t) && t.split(/\s+/).length <= 5;
  return t.startsWith("#") || /^([-*_])\1{2,}$/.test(t) || /^\*\*[^*]+(?::\*\*|\*\*:?)$/.test(t) || label || afterHeading(t) !== null;
}

const plain = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^#{1,6} /, "").replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** A small stand-in for the backend's parser of a result's `For Jira:` section, enough for the sample data. */
export function jiraNote(result: string): JiraNote {
  const lines = result.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => afterHeading(l) !== null);
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

export const ticketKeys = (text: string): string[] => [...new Set((text.match(KEY) ?? []).map((k) => k.toUpperCase()))];

/** The comment as the backend first drafts it, for the sample data. */
export function commentText(note: JiraNote, change: CodeChange | null): string {
  const parts = ["Looked into this with an agent (it was asked to only read code and change nothing)."];
  if (!note.fromMarker) parts.push("The agent didn't mark anything for Jira, so this is its whole answer, shortened:");
  parts.push(note.text);
  if (change?.kind === "pullRequest") parts.push(`Pull request: ${change.url}`);
  return parts.join("\n\n");
}
