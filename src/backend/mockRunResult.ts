import { SUMMARY_ONLY, type CodeChange, type ItemRef, type JiraNote, type ReportView, type ResultSource, type ReviewFinding, type ReviewSeverity, type ReviewVerdict, type ReviewView, type RunKind, type TicketProposal, type WorkItemKind } from "../types";

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

/** A review keeps at most this many findings, each cut to this length; as `runs/report/tool.rs`. */
export const FINDINGS_MAX = 20;
export const FINDING_TEXT_LIMIT = 600;
const SEVERITY_ORDER: Record<ReviewSeverity, number> = { blocking: 0, "should-fix": 1, nit: 2 };

const cutTo = (text: string, limit: number) => {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("").trimEnd()}…`;
};

/** A severity as an answer writes it, as `Severity::parse` in `runs/report/mod.rs`. */
function severityOf(label: string): ReviewSeverity | null {
  const word = label.trim().toLowerCase().replace(/[ _]/g, "-");
  if (word === "blocking" || word === "blocker") return "blocking";
  if (word === "should-fix" || word === "shouldfix") return "should-fix";
  if (word === "nit") return "nit";
  return null;
}

/** A list line that starts with a severity in brackets or before a colon, as `finding_line` in `runs/result.rs`. */
function findingLine(line: string): ReviewFinding | null {
  const listed = listText(line);
  if (listed === null) return null;
  const item = listed.replace(/^[*_`]+/, "");
  let label: string;
  let rest: string;
  if (item.startsWith("[")) {
    const close = item.indexOf("]");
    if (close < 0) return null;
    [label, rest] = [item.slice(1, close), item.slice(close + 1)];
  } else {
    const colon = [...item].slice(0, 24).indexOf(":");
    if (colon < 0) return null;
    const chars = [...item];
    [label, rest] = [chars.slice(0, colon).join(""), chars.slice(colon + 1).join("")];
  }
  const severity = severityOf(label.replace(/^[*_`\s]+|[*_`\s]+$/g, ""));
  if (!severity) return null;
  const text = rest.replace(/^[*_:\s]+/, "").replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "$1").split(/\s+/).filter(Boolean).join(" ");
  return text ? { severity, text: cutTo(text, FINDING_TEXT_LIMIT), where: null } : null;
}

const bySeverity = (findings: ReviewFinding[]) => findings.map((f, i) => [f, i] as const).sort(([a, i], [b, j]) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || i - j).map(([f]) => f);

/**
 * A review's verdict and findings from its written answer, as `review_verdict` in `runs/result.rs`: the last
 * `Verdict: pass|blocking` line before the `For Jira:` note, outside a code fence and not quoted, and the severity list
 * lines before it. Null without one, and when the verdict contradicts its findings.
 */
export function reviewVerdict(result: string): { verdict: ReviewVerdict; findings: ReviewFinding[] } | null {
  const lines = result.replace(/\r\n/g, "\n").split("\n");
  const inside = fenceTracker();
  let found: { at: number; verdict: ReviewVerdict } | null = null;
  for (const [i, l] of lines.entries()) {
    if (inside(l)) continue;
    // The note is where a reviewer quotes what others claim, so nothing from it on counts, nor a quoted line.
    if (headingRest(l, "for jira") !== null) break;
    if (l.trimStart().startsWith(">")) continue;
    const rest = headingRest(l, "verdict");
    const word = rest === null ? null : (/^[^\p{L}\p{N}]*([\p{L}\p{N}]*)/u.exec(rest)?.[1] ?? "").toLowerCase();
    if (word === "pass" || word === "blocking") found = { at: i, verdict: word };
  }
  if (!found) return null;
  const { at, verdict } = found as { at: number; verdict: ReviewVerdict };
  const before = fenceTracker();
  const findings = lines.slice(0, at).filter((l) => !before(l)).map(findingLine).filter((f): f is ReviewFinding => f !== null);
  // A verdict that contradicts its findings, as the report tool refuses, is no verdict.
  if (findings.some((f) => f.severity === "blocking") !== (verdict === "blocking")) return null;
  return { verdict, findings: bySeverity(findings).slice(0, FINDINGS_MAX) };
}

/** A review's verdict for the sheet and card, as `review_view` in `inbox/run_results.rs`. */
export function reviewView(resolved: Pick<Resolved, "verdict" | "findings" | "verdictStructured">): ReviewView | null {
  if (!resolved.verdict) return null;
  const count = (s: ReviewSeverity) => resolved.findings.filter((f) => f.severity === s).length;
  return { verdict: resolved.verdict, blocking: count("blocking"), shouldFix: count("should-fix"), nits: count("nit"), findings: resolved.findings, source: resolved.verdictStructured ? "structured" : "written" };
}

export const SUBTASK_MAX = 8;
const BARE_REFUSALS = ["none", "n/a", "na", "nothing"];
const REFUSAL_OPENERS = ["no subtasks", "no subtask", "no breakdown", "no need", "nothing to split", "not needed", "not required", "not necessary", "not applicable", "not worth"];

/** An answer that declines the breakdown rather than naming a task, as `declines_breakdown` in `runs/result.rs`. */
const declinesBreakdown = (text: string) => {
  const lower = text.toLowerCase().trim();
  const boundary = (rest: string) => !/^[\p{L}\p{N}]/u.test(rest);
  return REFUSAL_OPENERS.some((p) => lower.startsWith(p) && boundary(lower.slice(p.length))) || BARE_REFUSALS.some((p) => lower.startsWith(p) && /^(?:[-–—:.,;!(]|$)/.test(lower.slice(p.length).trimStart()));
};

const listText = (line: string): string | null => /^\s*(?:[-*+•]|\d{1,3}[.)])[ \t]+(.*)$/.exec(line)?.[1] ?? null;
const indentOf = (line: string) => line.length - line.trimStart().length;

/** The summaries in a result's `Subtasks:` section, as `subtask_proposals` in `runs/result.rs` reads them. */
export function subtaskProposals(result: string): string[] {
  const lines = result.replace(/\r\n/g, "\n").split("\n");
  const start = headingOutsideFences(lines, "subtasks");
  if (start < 0) return [];
  let section = [headingRest(lines[start], "subtasks") ?? ""];
  const inside = fenceTracker();
  for (const l of lines.slice(start + 1)) {
    const t = l.trim();
    if (inside(l) || endsSection(t) || headingRest(t, "new ticket") !== null) break;
    section.push(l);
  }
  const listed = section.filter((l) => listText(l) !== null);
  if (listed.length) {
    const least = Math.min(...listed.map(indentOf));
    section = listed.filter((l) => indentOf(l) === least);
  }
  const out: string[] = [];
  for (const line of section) {
    const text = titleCut(oneLine((listText(line) ?? line.trim()).replace(/^(\[ \]|\[[xX]\])/, "")));
    if (!text || text.startsWith("#") || text.endsWith(":") || declinesBreakdown(text) || out.some((o) => o.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length === SUBTASK_MAX) break;
  }
  return out;
}

/** What the backend adds under a ticket made from a run. */
export const FOUND_BY = "Found by an agent that was asked to only read code and change nothing.";

export const ticketBody = (t: TicketProposal) => (t.body ? `${t.body}\n\n${FOUND_BY}` : FOUND_BY);

export const ticketKeys = (text: string): string[] => [...new Set((text.match(KEY) ?? []).map((k) => k.toUpperCase()))];

/** The comment as the backend first drafts it, for the sample data. */
export function commentText(note: JiraNote, change: CodeChange | null, kind: RunKind = "investigate", summaryOnly = false, blocked = false): string {
  const intro: Partial<Record<RunKind, string>> = {
    investigate: "Looked into this with an agent (it was asked to only read code and change nothing).",
    plan: "Planned this with an agent (it was asked to only read code and change nothing).",
  };
  const parts = [intro[kind] ?? "An agent worked on this."];
  if (blocked) parts.push("The agent reports it could not finish.");
  if (summaryOnly) parts.push(SUMMARY_ONLY);
  else if (!note.fromMarker) parts.push("The agent didn't mark anything for Jira, so this is its whole answer, shortened:");
  parts.push(note.text);
  if (change?.kind === "pullRequest") parts.push(`Pull request: ${change.url}`);
  return parts.join("\n\n");
}

/** Jira refuses comments of about 32,000 characters; as `PLAN_COMMENT_LIMIT` in `runs/result.rs`. */
export const PLAN_COMMENT_LIMIT = 24_000;

/** A plan run's answer with control characters and our data markers dropped, markdown kept; a sample of `plan_answer`. */
export function planAnswer(result: string): string {
  const clean = result.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
  let out = clean;
  while (/<<<(?:TICKET|FOCUS|PLAN|BUILD|AGENT_OUTPUT)|(?:TICKET|FOCUS|PLAN|BUILD|AGENT_OUTPUT)>>>/.test(out)) out = out.replace(/<<<(?:TICKET|FOCUS|PLAN|BUILD|AGENT_OUTPUT)|(?:TICKET|FOCUS|PLAN|BUILD|AGENT_OUTPUT)>>>/g, "");
  return out.trim();
}

/** The plan without its closing `For Jira:` note, as `plan_without_note` in `runs/result.rs`: only the last such heading outside a code fence, and only when nothing after it starts a section or a code block. */
export function planWithoutNote(result: string): string {
  const clean = planAnswer(result);
  const lines = clean.split("\n");
  const inside = fenceTracker();
  let at = -1;
  lines.forEach((l, i) => {
    if (!inside(l) && headingRest(l, "for jira") !== null) at = i;
  });
  if (at < 0) return clean;
  const after = fenceTracker();
  if (lines.slice(at + 1).some((l) => after(l) || endsSection(l))) return clean;
  const before = lines.slice(0, at);
  while (before.length && (!before[before.length - 1].trim() || /^([-*_])\1{2,}$/.test(before[before.length - 1].trim()))) before.pop();
  return before.length ? before.join("\n") : clean;
}

export interface Fitted {
  text: string;
  total: number;
  cut: boolean;
}

/** `text` within `limit` characters, cut at the end of a paragraph, then a sentence, then a word, with `note` after it. */
export function fit(text: string, limit: number, note: (total: number) => string): Fitted {
  const chars = [...text];
  const total = chars.length;
  if (total <= limit) return { text, total, cut: false };
  const tail = note(total);
  const room = Math.max(0, limit - [...tail].length);
  const window = chars.slice(0, room).join("");
  const floor = Math.floor(room / 2);
  const paragraph = window.lastIndexOf("\n\n");
  let sentence = -1;
  for (const m of window.matchAll(/[.!?](?=\s)/g)) if ([...window.slice(0, m.index)].length >= floor) sentence = m.index + 1;
  const word = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  const cutAt = [paragraph, sentence, word].find((i) => i >= 0 && [...window.slice(0, i)].length >= floor) ?? window.length;
  return { text: `${window.slice(0, cutAt).trimEnd()}\n\n${tail}`, total, cut: true };
}

/** What an agent reported through the run-report tool, as `runs/report` stores it. */
export interface MockReport {
  status: "done" | "blocked";
  note?: string;
  newTicket?: TicketProposal;
  subtasks?: string[];
  plan?: string;
  /** For a review: its verdict and findings. */
  verdict?: ReviewVerdict;
  findings?: ReviewFinding[];
}

/** A run's report row: whether it was offered the tool, and what came of it. */
export interface MockReportRow {
  offered: boolean;
  report: MockReport | null;
  revision: number;
  calls: number;
  rejections: number;
  /** The person answered or carried on after the report was made. */
  stale: boolean;
}

export const MAX_REPORT_CALLS = 12;
export const MAX_REPORT_REJECTIONS = 5;

export interface Resolved {
  source: ResultSource | null;
  note: JiraNote | null;
  ticket: TicketProposal | null;
  subtasks: string[];
  keys: string[];
  plan: string | null;
  status: "done" | "blocked" | null;
  /** The agent's own account rather than Claude's one-line summary of it. */
  complete: boolean;
  /** For a review: from the report when it gave one, else from the `Verdict:` line of the whole written answer. */
  verdict: ReviewVerdict | null;
  findings: ReviewFinding[];
  verdictStructured: boolean;
}

interface Resolvable {
  result?: string | null;
  resultComplete?: boolean;
  item: ItemRef | null;
  spec: { kind: RunKind };
}

/** Which result a run's drafts and sheet use, as `runs::report::resolve`: a current report wins wholesale, else the written answer. */
export function resolveResult(run: Resolvable, row: MockReportRow | null): Resolved {
  const resolved = readResult(run, row);
  if (run.spec.kind !== "review") return resolved;
  const current = row?.report && !row.stale ? row.report : null;
  const reported = current?.verdict ? { verdict: current.verdict, findings: current.findings ?? [] } : null;
  const written = !reported && run.result && run.resultComplete !== false ? reviewVerdict(run.result) : null;
  const found = reported ?? written;
  return { ...resolved, verdict: found?.verdict ?? null, findings: found?.findings ?? [], verdictStructured: !!reported };
}

function readResult(run: Resolvable, row: MockReportRow | null): Resolved {
  const result = run.result?.trim() || undefined;
  const own = run.item?.key.toUpperCase();
  const onTicket = !!run.item;
  const current = row?.report && !row.stale ? row.report : null;
  if (current) {
    const keys = [...new Set([...(result ? ticketKeys(result) : []), ...ticketKeys(current.note ?? "")])].filter((k) => k !== own);
    return {
      source: "structured",
      note: current.note ? { text: current.note, fromMarker: true } : null,
      ticket: current.newTicket ?? null,
      subtasks: run.spec.kind === "triage" && onTicket ? (current.subtasks ?? []) : [],
      keys,
      plan: current.plan ?? null,
      status: current.status,
      complete: true,
      verdict: null,
      findings: [],
      verdictStructured: false,
    };
  }
  const note = result ? jiraNote(result) : null;
  const source: ResultSource | null = !result ? null : run.resultComplete === false ? "summaryOnly" : note?.fromMarker ? "section" : "whole";
  return {
    source,
    note,
    ticket: result && !onTicket ? ticketProposal(result) : null,
    subtasks: result && onTicket && run.spec.kind === "triage" ? subtaskProposals(result) : [],
    keys: result ? ticketKeys(result).filter((k) => k !== own) : [],
    plan: null,
    status: null,
    complete: source !== null && source !== "summaryOnly",
    verdict: null,
    findings: [],
    verdictStructured: false,
  };
}

/** What the sheet shows of the report tool's part in a run; null when the run was never asked to use it. */
export function reportView(row: MockReportRow | null, asked: boolean, resolved: Resolved): ReportView | null {
  if (!row && !asked) return null;
  const r = row ?? { offered: false, report: null, revision: 0, calls: 0, rejections: 0, stale: false };
  return {
    offered: r.offered,
    status: resolved.status,
    revision: r.revision,
    calls: r.calls,
    rejections: r.rejections,
    stale: r.stale && !!r.report,
    locked: r.calls >= MAX_REPORT_CALLS || r.rejections >= MAX_REPORT_REJECTIONS,
    firstAt: null,
    lastAt: null,
  };
}
