/**
 * What the sample backend stands in for when Pip checks a ticket's readiness. The app's Pip and Triage judge a ticket
 * against four things: its goal, how anyone will know it is done (acceptance criteria), what is in and out of scope, and
 * who asked and who is waiting on it. The sample's Triage can't judge, so it recognises one deliberately vague kind of
 * ticket: a description of one short line. A ticket with no description or a real one is left alone, so the sample tickets
 * the other flows use read as ready. (Pip's and the page's earlier word check is `clarityGaps` in src/lib/ticketClarity.ts,
 * which the sample runs for real.)
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

/** The open questions a sample triage lists; the first holds two, which every reader lists one each (`oneQuestionEach`). */
const unclearQuestions = (key: string) => [`What does done look like for ${key}? Which behaviour or number should change?`, "What is in scope and what is out?", "Who asked for this, and who is waiting on it?"];

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
    ...unclearQuestions(key).map((q) => `- ${q}`),
    "",
    "Plan recommended: yes",
    "",
    "For Jira:",
    "The ticket cannot be sized yet: the description is one line. Before it can be planned it needs an answer on what done looks like, what is in and out of scope, and who asked for it and who is waiting on it.",
  ].join("\n");
}

/**
 * What a sample triage of the same ticket finishes with once the reporter has answered in a comment: the comments are in
 * its prompt, so the answers count, nothing is left open and it says `Ready to plan: yes`. Its note for Jira is neutral
 * and says the answers in the comments were used.
 */
export function answeredTriageResult(key: string): string {
  return [
    `${key}'s description is one short line, but the reporter's answers in the comments cover what it leaves out, so I could size it.`,
    "",
    "Size: 3 points (about a day).",
    "",
    "Ready to plan: yes",
    "",
    "Plan recommended: yes",
    "",
    "For Jira:",
    "Size: 3 points (about a day). The answers in the ticket's comments were used for what done looks like, what is in and out of scope, and who is waiting on it, so no questions are open.",
  ].join("\n");
}

export const answeredTriageSummary = () => "Triage complete: the reporter's answers in the comments were used, size 3, no questions open";

const COUNTED = ["no", "one", "two", "three", "four", "five", "six"];

/** The summary of that triage: it counts the questions as they are listed (one each), so it never says three over four bullets. */
export const unclearTriageSummary = (key: string) => {
  const n = oneQuestionEach(unclearQuestions(key)).length;
  return `Triage complete: the ticket isn't clear enough to size, ${COUNTED[n] ?? n} ${n === 1 ? "question" : "questions"} open`;
};

/** What the approve button of the comment to the reporter says, as `READINESS_LABEL` in src-tauri/src/inbox/workstreams.rs. */
export const READINESS_LABEL = READINESS_COMMENT_LABEL;

/** A listed question that holds several ("What is done? Which number changes?") as one each, so the reporter answers one thing per bullet; as `one_question_each` in src-tauri/src/inbox/workstreams.rs. */
export function oneQuestionEach(questions: readonly string[]): string[] {
  return questions.flatMap((q) => q.trim().split(/(?<=\?)\s+(?=\p{Lu})/u)).filter((q) => q !== "");
}

/**
 * The comment "Ask the reporter" drafts, as `reporter_comment` in src-tauri/src/inbox/workstreams.rs: a fixed frame around
 * the questions the Triage listed, or around the four things a ticket needs when it listed none. The ticket's key is left
 * out (the comment is on the ticket) and one line says why the questions are asked. `replied`: the reporter has
 * answered since the last ask, so the frame thanks them and says what is still open.
 */
export function reporterComment(reporter: string | null, questions: readonly string[], replied = false): string {
  const hello = reporter ? `Hi @${reporter},` : "Hi,";
  const asks = questions.length
    ? oneQuestionEach(questions).map((q) => `- ${q}`).join("\n")
    : "- What is the goal?\n- What has to be true for this to be done (the acceptance criteria)?\n- What is in scope, and what is out?\n- Who asked for it, and who is waiting on it?";
  // The reporter has answered since the last ask: thank them and say what is still open, rather than repeat the first ask.
  if (replied) return `${hello}\n\nThanks for your answer above. A few things are still open to make this ticket clear to work on:\n\n${asks}\n\nCould you answer these here on the ticket? Thanks.`;
  return `${hello}\n\nA few things need clearing up to make this ticket clear to work on:\n\n${asks}\n\nCould you answer them here on the ticket? Thanks.`;
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
