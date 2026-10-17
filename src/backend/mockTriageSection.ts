import type { Proposal, WorkBlock, WorkDoc, WorkInline } from "../types";
import { isPlanExpand, planSectionOf, planStartOf } from "./mockPlanSection";
import { docFromMarkdown, markdownOf } from "./mockMarkdown";

/** The marker of a description's triage section, as `TRIAGE_HEADING` in `domain/doc/triage.rs`. */
export const TRIAGE_HEADING = "Triage";
const NEW_LEVEL = 2;
/** What stands over the list of open questions inside the section, as `QUESTIONS_LEAD` in `domain/doc/triage.rs`. */
export const QUESTIONS_LEAD = "Open questions:";

const textOf = (content: WorkInline[]) => content.map((i) => (i.type === "text" || i.type === "link" ? i.text : "")).join("");
const isMarker = (b: WorkBlock) => b.type === "heading" && textOf(b.content).trim().replace(/:+$/, "").trim().toLowerCase() === TRIAGE_HEADING.toLowerCase();

/** The first triage heading and where its section ends: at the next heading of the same or a higher level, or at the plan's expand. */
function range(doc: WorkDoc): { at: number; end: number; level: number } | null {
  const at = doc.blocks.findIndex(isMarker);
  const head = doc.blocks[at];
  if (head?.type !== "heading") return null;
  const next = doc.blocks.slice(at + 1).findIndex((b) => (b.type === "heading" && b.level <= head.level) || isPlanExpand(b));
  return { at, end: next < 0 ? doc.blocks.length : at + 1 + next, level: head.level };
}

/** What stands under the triage heading, without the heading. As `triage_section`. */
export function triageSectionOf(doc: WorkDoc): WorkDoc | null {
  const r = range(doc);
  return r ? { blocks: doc.blocks.slice(r.at + 1, r.end) } : null;
}

/** The document without its triage section, heading included. As `without_triage_section`. */
export function withoutTriageSection(doc: WorkDoc): WorkDoc {
  const r = range(doc);
  return r ? { blocks: [...doc.blocks.slice(0, r.at), ...doc.blocks.slice(r.end)] } : doc;
}

/**
 * `doc` with `note` and, when there are any, `questions` as its triage section: replacing the one it has, in place and at
 * its heading level, or added after the description and before the plan section. The note is Markdown whose headings
 * become plain paragraphs, so that none can end the section. As `with_triage_section`.
 */
export function withTriageSection(doc: WorkDoc, note: string, questions: readonly string[]): WorkDoc {
  const r = range(doc);
  const at = r ? r.at : (planStartOf(doc) ?? doc.blocks.length);
  const before = doc.blocks.slice(0, at);
  const after = r ? doc.blocks.slice(r.end) : doc.blocks.slice(at);
  const level = r?.level ?? NEW_LEVEL;
  let text = note.trim();
  if (questions.length) text = `${text ? `${text}\n\n` : ""}${QUESTIONS_LEAD}\n\n${questions.map((q) => `- ${q.trim()}`).join("\n")}`;
  const own = docFromMarkdown(text).blocks.map((b): WorkBlock => (b.type === "heading" ? { type: "paragraph", content: b.content } : b));
  const heading: WorkBlock = { type: "heading", level, content: [{ type: "text", text: TRIAGE_HEADING, marks: [] }] };
  return { blocks: [...before, heading, ...own, ...after] };
}

/** The questions listed under `Open questions:` in the triage section, one per bullet. As `triage_questions`. */
export function triageQuestionsOf(doc: WorkDoc): string[] {
  const section = triageSectionOf(doc);
  if (!section) return [];
  const at = section.blocks.findIndex((b) => b.type === "paragraph" && textOf(b.content).trim() === QUESTIONS_LEAD);
  const list = at >= 0 ? section.blocks[at + 1] : undefined;
  if (list?.type !== "list" || list.ordered) return [];
  return list.items.map((item) => markdownOf({ blocks: item }).replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

/**
 * Whether the draft is a description update an agent run left that adds or replaces the description's triage section and
 * leaves its plan section as it was: what a finished Triage drafts in place of a comment. As `is_triage_description`.
 */
export function isTriageDescription(p: Proposal): boolean {
  if (p.origin.type !== "run" || p.intent.type !== "rewrite" || p.intent.title || !p.intent.body) return false;
  const { from, to } = p.intent.body;
  const now = triageSectionOf(to);
  if (!now) return false;
  const was = triageSectionOf(from);
  const plan = (d: WorkDoc) => { const s = planSectionOf(d); return s ? markdownOf(s) : null; };
  return (!was || markdownOf(was) !== markdownOf(now)) && plan(to) === plan(from);
}
