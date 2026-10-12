/**
 * What the sample backend stands in for when Pip checks a ticket's readiness. The app's Pip and Triage judge a ticket
 * against four things: its goal, how anyone will know it is done (acceptance criteria), what is in and out of scope, and
 * who asked and who is waiting on it. The sample can't judge, so it recognises one deliberately vague kind of ticket: a
 * description of one short line. A ticket with no description or a real one is left alone, so the sample tickets the
 * other flows use read as ready.
 */

import { docFromText } from "../lib/docs";
import { READINESS_COMMENT_LABEL } from "../lib/proposals";
import type { PersonRef, WorkDoc, WorkInline } from "../types";

/** A description is thin when it is a single non-empty line of fewer than `THIN_LIMIT` characters. */
export const THIN_LIMIT = 40;

export function thinDescription(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t !== "" && !t.includes("\n") && t.length < THIN_LIMIT;
}

/** What a ticket's description leaves out, as the sentence that names it would say it ("what done looks like"). */
export type Gap = "what done looks like" | "what's in or out of scope" | "who is waiting on it";

/** The readiness gaps of a thin description: the cues the sample looks for are the words a description would use for each. */
export function readinessGaps(text: string): Gap[] {
  const gaps: Gap[] = [];
  if (!/accept|done when|definition of done|criteria|so that/i.test(text)) gaps.push("what done looks like");
  if (!/scope|only|out of|not include|won't/i.test(text)) gaps.push("what's in or out of scope");
  if (!/asked|requested|waiting|stakeholder|needs it|for the .+ team/i.test(text)) gaps.push("who is waiting on it");
  return gaps;
}

/** `CA-408 doesn't say what done looks like, what's in or out of scope, or who is waiting on it.` */
export function gapsSentence(key: string, gaps: readonly Gap[]): string {
  const list = gaps.length > 1 ? `${gaps.slice(0, -1).join(", ")}, or ${gaps[gaps.length - 1]}` : gaps[0];
  return `${key} doesn't say ${list}.`;
}

/**
 * What a sample triage of a ticket with a thin description finishes with: it can't size the work, says `Ready to plan: no`
 * and lists what it would need to know. It still says `Plan recommended: yes`, so a managed workstream shows that the
 * readiness stop, not the recommendation, is what holds the plan back.
 */
export function unclearTriageResult(key: string): string {
  return [
    `${key}'s description is one short line, so I can't size it with any confidence.`,
    "",
    "Ready to plan: no",
    "Open questions:",
    `- What does done look like for ${key}? Which behaviour or number should change?`,
    "- What is in scope and what is out?",
    "- Who asked for this, and who is waiting on it?",
    "",
    "Plan recommended: yes",
    "",
    "For Jira:",
    "Triage could not size this: the description is one line. Three questions are open before it can be planned.",
  ].join("\n");
}

export const UNCLEAR_TRIAGE_SUMMARY = "Triage complete: the ticket isn't clear enough to size, three questions open";

/** What the approve button of the comment to the reporter says, as `READINESS_LABEL` in src-tauri/src/inbox/workstreams.rs. */
export const READINESS_LABEL = READINESS_COMMENT_LABEL;

/**
 * The comment "Ask the reporter" drafts, as `reporter_comment` in src-tauri/src/inbox/workstreams.rs: a fixed frame around
 * the questions the Triage listed, or around the four things a ticket needs when it listed none.
 */
export function reporterComment(key: string, reporter: string | null, questions: readonly string[]): string {
  const hello = reporter ? `Hi @${reporter},` : "Hi,";
  const asks = questions.length
    ? questions.map((q) => `- ${q}`).join("\n")
    : "- What is the goal?\n- How will we know it is done (the acceptance criteria)?\n- What is in scope, and what is out?\n- Who asked for it, and who is waiting on it?";
  return `${hello}\n\nBefore ${key} can be planned we need a few things cleared up:\n\n${asks}\n\nCould you answer them here on the ticket? Thanks.`;
}

/** `reporterComment` as a document, with the reporter's greeting a real mention when they are known. */
export function reporterDoc(text: string, reporter: { person: PersonRef; name: string } | null): WorkDoc {
  const doc = docFromText(text);
  const first = doc.blocks[0];
  if (!reporter || first?.type !== "paragraph") return doc;
  const greeting: WorkInline[] = [
    { type: "text", text: "Hi ", marks: [] },
    { type: "mention", person: reporter.person, name: reporter.name },
    { type: "text", text: ",", marks: [] },
  ];
  return { blocks: [{ ...first, content: [...greeting, ...first.content.slice(1)] }, ...doc.blocks.slice(1)] };
}
