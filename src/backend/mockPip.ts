import { and } from "../lib/filter";
import { ANSWERS_COMMENT_LABEL, REVIEW_IS_THE_USERS, WORKSTREAM_PENDING_CAP, capRefusal, isRunDraft, leftByRun, targetOf } from "../lib/proposals";
import { followUpBlocker } from "../workspace/followUp";
import { docFromText, docText } from "../lib/docs";
import type { BasisField, Intent, ItemRef, Proposal, ReviewComment, Run, RunKind, ScreenContext, WorkFilter } from "../types";
import { APPROVE_PLAN, liveCounts, liveWords, needsPerson, planOpenQuestions, resultHeadline, runTitle, stateView } from "../workspace/agentsLogic";
import type { ImageData } from "../lib/pipImages";
import { jiraNote, subtaskProposals } from "./mockRunResult";
import type { AskRequest, ClaudeEvent, EventMeta } from "./claude";
import { mockPipTurns, mockUsage } from "./mockPipTurns";
import { GENERAL_CONVERSATION, workstreamOfConversation } from "../lib/conversations";
import { labelsByRun } from "../lib/workstreamStage";
import { heldText } from "../lib/workstreamHold";
import { draftPhrase, runPhrase } from "../lib/runNames";
import { statusId } from "./mockConnector";
import type { LastTrip } from "./mockWorkstreams";
import { clarityText, type ClarityGap } from "../lib/ticketClarity";

/** What the scripted Pip does for one question. */
export interface PipScript {
  steps: string[];
  text: string;
  filter: { filter: WorkFilter; note: string } | null;
  draft: { intent: Intent; label: string | null } | null;
  /** An agent run to propose on a ticket: its kind, the run it follows (a build or review needs one) and an optional focus note. */
  runDraft?: { item: ItemRef; kind: RunKind; fromRun: string | null; focus: string | null } | null;
  /** An investigation with no ticket to propose: a watched repository, when the request named one, and the question. */
  ticketlessRun?: { repo: string | null; prompt: string } | null;
  /** A change to the text of a comment, new-ticket or breakdown draft that came from a run; for a review draft its summary (`body`) and its complete new list of comments. */
  revise?: { id: string; body?: string; title?: string; description?: string; summaries?: string[]; comments?: ReviewComment[] } | null;
  /** A new description or title to draft for a ticket, shown to the person as a diff. */
  rewrite?: { item: ItemRef; part: "title" | "description" } | null;
  /** A follow-up to propose for a finished run, the way propose_follow_up does. */
  followUp?: { runId: string; message: string; reason: string } | null;
  /** Answers to suggest to runs that are asking a question, the way propose_answer does: one per run. */
  answers?: { runId: string; message: string }[];
  /** The draft this turn was about, remembered for the rest of the conversation. */
  discussed?: string;
}

const FILTERS: { pattern: RegExp; filter: WorkFilter; note: string }[] = [
  { pattern: /\b(stale|quiet|old)\b/, filter: { type: "stale", days: 5 }, note: "Tickets untouched for 5 days or more" },
  { pattern: /\b(blocked|stuck)\b/, filter: { type: "blocked" }, note: "Blocked tickets" },
  { pattern: /\b(unassigned|no owner)\b/, filter: { type: "unassigned" }, note: "Tickets with no owner" },
  { pattern: /\b(mine|my)\b|assigned to me/, filter: { type: "mine" }, note: "Tickets assigned to you" },
];

const asksToShow = /\b(show|filter|find|list|only|which)\b/;
const asksAboutAgents = /\bmy agents\b|\bagents?\b.*\b(doing|up to|status|running)\b|\bwhat.*\bagents?\b/;
const asksForAgent = /\b(start|launch|run|kick off)\b.*\b(agent|investigation)\b|\binvestigate\b/;
const REPO = /\b(acme\/[a-z][\w.-]*)\b/i;

/** The question in a request to investigate with no ticket, and the repository it names; null when there is no question in it. */
export function ticketlessQuestion(prompt: string): { repo: string | null; prompt: string } | null {
  const text = prompt.trim().replace(/^(?:please\s+)?(?:can you\s+)?(?:start|launch|kick off|run)\s+(?:an?\s+)?(?:agent|investigation)(?:\s+(?:to|and|that))?\s*|^(?:please\s+)?investigate\s+/i, "");
  const question = text.charAt(0).toUpperCase() + text.slice(1);
  return question.length < 12 ? null : { repo: REPO.exec(prompt)?.[1] ?? null, prompt: question };
}
const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const finishes = /new ticket draft (\S+), drafted from agent run (\S+?)\./i;
const talksBreakdown = /breakdown draft (\S+) on \S+, drafted from agent run (\S+?)\./i;
const proposesBreakdown = /propose subtasks for \S+ from run (\S+?):/i;
const asksForFewer = /\b(fewer|merge|combine)\b/;

/** A sample shortening of a summary's wording: it stops at "when" or after six words. */
const shortened = (summary: string) => {
  const cut = summary.split(" when ")[0].split(/\s+/);
  return cut.slice(0, 6).join(" ");
};
const talksDescription = /description update draft (\S+) on \S+, drafted from agent run (\S+?)\./i;
const discusses = /comment draft (\S+) on \S+, drafted from agent run (\S+?)\./i;
const EDIT_VERBS = "update|rewrite|revise|redraft|reword|edit|draft|write|fix|improve|tighten";
/** A verb that edits text, a few words on, and the description or title it edits: "draft an update to the ticket description". */
const asksForTextEdit = new RegExp(`\\b(?:${EDIT_VERBS})\\b(?:\\s+\\S+){0,6}?\\s+(?:the\\s+|this\\s+|its\\s+|that\\s+)?(?:description|title)\\b|\\b(?:description|title)\\b.*\\b(?:update|rewrite|revise|edit)\\b`);
/** A request whose object is a comment: the verb is followed, past only articles and adjectives, by "comment". Merely mentioning one is not. */
const COMMENT_VERBS = "draft|write|post|leave|add|make|compose|send|create|edit|revise|rewrite|update|reply|nudge|ping";
const actsOnComment = new RegExp(`\\b(?:${COMMENT_VERBS})\\b(?:\\s+(?:an?|the|my|this|that|your|jira|short|quick|brief|new|follow-?up|small)){0,3}\\s+comment\\b`);
const ANY_KEY = "([A-Za-z][A-Za-z0-9]+-\\d+)";
const TICKET_WORDS = "(?:ticket\\s+|issue\\s+)?";
const asksToRevise = /\b(shorten|shorter|tighten|trim|rewrite|reword|rephrase|revise)\b/;
const asksForShorter = /\b(shorten|shorter|tighten|trim)\b/;

const talksReview = /GitHub review draft (\S+) of \S+, drafted from agent run (\S+?)\./i;
const PLACE = "([\\w./-]+:\\d+)";
const softens = new RegExp(`\\bsoften\\b.*?\\b(?:comment|nit)\\s+(?:on|at)\\s+${PLACE}|\\bsoften (?:the )?comment (\\d+)\\b`, "i");
const drops = new RegExp(`\\bdrop (?:the )?nit\\b|\\bdrop (?:the )?comment (?:on|at)\\s+${PLACE}|\\bdrop (?:the )?comment (\\d+)\\b`, "i");
const adds = /\badd (?:a |another )?comment (?:on|at)\s+([\w./-]+):(\d+)\s+saying\s+(.+)$/is;

/** The words a review comment says, without the severity label Gossamr put in front. */
const reviewWords = (body: string) => body.replace(/^\*\*[^*]+:\*\*\s*/, "").trim();

/** A sample gentler wording of a review comment: a suggestion rather than a verdict. */
export const softenedComment = (body: string) => {
  const words = reviewWords(body);
  return `Suggestion, if you agree: ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
};

/** What the scripted Pip says when the backend refuses its revision of a review draft. */
export function reviewRefusal(why: string): string {
  return why === REVIEW_IS_THE_USERS
    ? `I can't change that draft: ${why}. You edited it, so it's yours and stays as you left it; nothing was posted.`
    : `I couldn't change the draft: ${why}. It is as it was, and nothing was posted.`;
}

/** `the CA-402 review` at the start of a sentence. */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STILL_A_DRAFT = "It's still a draft: nothing was posted to GitHub, and it goes there only when you post it.";

/** A turn about a GitHub review draft: talking it over, or softening, dropping or adding a comment. Null when the request isn't one. */
function reviewScript(prompt: string, drafts: readonly Proposal[], discussed: string | null): PipScript | null {
  const talk = talksReview.exec(prompt);
  const soften = softens.exec(prompt);
  const drop = drops.exec(prompt);
  const add = adds.exec(prompt);
  if (!talk && !soften && !drop && !add) return null;
  const reviews = drafts.filter((d) => d.state.type === "pending" && d.intent.type === "githubReview");
  // The one talked about, else the one the conversation discussed, else the only one waiting.
  const wanted = talk?.[1] ?? discussed;
  const draft = reviews.find((d) => d.id === wanted) ?? (!talk && reviews.length === 1 ? reviews[0] : undefined);
  if (!draft || draft.intent.type !== "githubReview") {
    if (!talk) return null;
    return { steps: [], text: "I can't find that review draft any more, or it has been decided already, so there is nothing to change.", filter: null, draft: null };
  }
  const review = draft.intent;
  const listed = review.comments.map((c, i) => `${i + 1}. \`${c.path}:${c.line}\`: ${reviewWords(c.body)}`).join("\n");
  if (talk) {
    return {
      steps: ["Read the draft in full", "Read the pull request's review comments"],
      text: `I read ${draftPhrase(draft)} in full, with the diff around each comment:\n\n${listed || "It has no inline comments."}\n\nTell me what to change, for example "soften the comment on ${review.comments[0] ? `${review.comments[0].path}:${review.comments[0].line}` : "a line"}" or "drop the nit", and I'll revise it. ${STILL_A_DRAFT}`,
      filter: null,
      draft: null,
      discussed: draft.id,
    };
  }
  const indexOf = (place: string | undefined, n: string | undefined) => (place ? review.comments.findIndex((c) => `${c.path}:${c.line}` === place) : n ? Number(n) - 1 : -1);
  const missing = (what: string): PipScript => ({ steps: ["Read the draft in full"], text: `The draft has no ${what}, so I left it as it is. ${STILL_A_DRAFT}`, filter: null, draft: null, discussed: draft.id });
  const revised = (comments: ReviewComment[], did: string, step: string): PipScript => ({ steps: ["Read the draft in full", step], text: `${did} ${STILL_A_DRAFT}`, filter: null, draft: null, discussed: draft.id, revise: { id: draft.id, comments } });
  if (soften) {
    const i = indexOf(soften[1], soften[2]);
    if (i < 0 || i >= review.comments.length) return missing(soften[1] ? `comment on ${soften[1]}` : `comment ${soften[2]}`);
    const c = review.comments[i];
    return revised(review.comments.map((x, j) => (j === i ? { ...x, body: softenedComment(x.body) } : x)), `I softened the comment on ${c.path}:${c.line} into a suggestion.`, "Softened a comment");
  }
  if (drop) {
    const i = drop[1] || drop[2] ? indexOf(drop[1], drop[2]) : review.comments.findIndex((c) => /^\*\*Nit:\*\*/i.test(c.body));
    if (i < 0 || i >= review.comments.length) return missing(drop[1] ? `comment on ${drop[1]}` : drop[2] ? `comment ${drop[2]}` : "nit");
    const c = review.comments[i];
    return revised(review.comments.filter((_, j) => j !== i), `I dropped the comment on ${c.path}:${c.line}.`, "Dropped a comment");
  }
  const [, path, line, said] = add!;
  return revised([...review.comments, { path, line: Number(line), side: "RIGHT", body: said.trim().replace(/^["“]|["”]$/g, "") }], `I added a comment on ${path}:${line}.`, "Added a comment");
}

const asksToSeeDraft = /\b(can|could|do|will) you (?:still )?(?:see|read|open|view)\b.*\b(?:draft|proposal)\b|\bwhat does (?:the|its|that|this) draft (?:say|contain)\b/i;

/** The lines under an "Open questions" heading (or after an "Open questions:" lead-in), or null when the text has none. */
export function openQuestions(markdown: string): string | null {
  const lines = markdown.split("\n");
  const at = lines.findIndex((l) => /^\s*(?:#{1,6}\s*|\*\*)?open questions\b/i.test(l));
  if (at < 0) return null;
  const inline = lines[at].replace(/^\s*(?:#{1,6}\s*|\*\*)?open questions[^:\n]*:?\**\s*/i, "").trim();
  const rest: string[] = inline ? [inline] : [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*#{1,6}\s/.test(l) || /^\s*for jira:/i.test(l)) break;
    rest.push(l);
  }
  const text = rest.join("\n").trim();
  return text || null;
}

const asksToSendBack = /another pass|second pass|\bsend (?:it|them|that|the agent|the run) back\b/i;

/** The next step a person asks for in a workstream's conversation, and the kind of finished run it follows. */
const CHAIN_ASKS: { pattern: RegExp; kind: RunKind; from: RunKind }[] = [
  { pattern: /\btriage (?:it|this)\b|^\s*triage [a-z][a-z0-9]+-\d+\b/, kind: "triage", from: "investigate" },
  { pattern: /\bplan (?:it|this)\b|^\s*plan [a-z][a-z0-9]+-\d+\b/, kind: "plan", from: "investigate" },
  { pattern: /\bbuild (?:it|this)\b/, kind: "build", from: "plan" },
  { pattern: /\breview (?:it|this)\b/, kind: "review", from: "build" },
];

const CHAIN_WORDS: Record<RunKind, string> = { investigate: "an investigation", triage: "a triage", plan: "a plan", build: "a build", review: "a review", verify: "a check" };

/** The conversation's workstream, as the scripted Pip knows it: its id, its ticket and why it is held, if it is. */
export interface PipWorkstream {
  id: string;
  item: ItemRef | null;
  heldReason?: string | null;
  /** The ticket fields whose drift held it, while it is held for that. */
  drifted?: readonly BasisField[] | null;
  /** The last tripwire that held it, while Pip hasn't been told of it in a wake since the person resumed it. */
  lastTrip?: LastTrip | null;
  /** Pip's first turn in this conversation, which opens with the readiness check of the ticket. */
  first?: boolean;
  /** The gaps Gossamr's own word check found in the ticket's description, while its notice shows (not dismissed, no triage yet): Pip's first line names them. */
  clarity?: readonly ClarityGap[] | null;
  /** The person chose "I'll answer" on a triage's open questions and no comment with their answers was drafted since: their next message holds the answers. */
  answersDue?: boolean;
  /** The comment with the person's answers was posted and no plan was drafted since: Pip's next turn proposes the plan. */
  planDue?: boolean;
}

/**
 * Pip's readiness check of a workstream's ticket in its first turn, as the Manager prompt asks (`MANAGER` in
 * src-tauri/src/agent/context.rs): the one sentence naming what the ticket leaves out, from the gaps Gossamr's own word check
 * found (`clarity_line` in agent/workstream.rs tells the real Pip the same), e.g. "CA-408 may be unclear: it has a very short
 * description and doesn't say what done looks like." Null when it isn't the first turn, there is no ticket, or the check
 * found nothing, or its notice is gone (dismissed, asked, or a triage ran).
 */
export function readinessLine(workstream: PipWorkstream | null): string | null {
  if (!workstream?.first || !workstream.item || !workstream.clarity?.length) return null;
  return clarityText(workstream.item.key, workstream.clarity);
}

/**
 * What Pip does with the person's next message after they chose "I'll answer": the comment "Answers to the open questions"
 * for the ticket, each answer under the question it answers (when the message splits into as many lines or sentences as
 * there are questions; else the questions quoted, then the answers as written), as a draft for approval. A comment, never a
 * rewrite of the description. The plan is not drafted beside it: Pip proposes it on the turn after the comment is posted
 * (`planAfterAnswers`). The message is the composer's prefill (`readinessPrompt`): the questions quoted, then "My answers:"
 * and what the person wrote. Null when no answers are due, or there is no ticket.
 */
export function answersScript(prompt: string, runs: readonly Run[], workstream: PipWorkstream | null): PipScript | null {
  const item = workstream?.item;
  if (!workstream?.answersDue || !item) return null;
  const at = prompt.indexOf("My answers:");
  const asked = at >= 0 ? prompt.slice(0, at) : "";
  const questions = [...asked.matchAll(/\u201c([^\u201d]*)\u201d/g)].map((m) => m[1].trim()).filter((q) => q && q !== "(it listed no questions)");
  const answer = (at >= 0 ? prompt.slice(at + "My answers:".length) : prompt).trim();
  // As many lines, or else as many sentences, as questions pair them up; any other shape gets every question, then the answer as it was written.
  const parts = [answer.split(/\n+/), answer.split(/(?<=[.!?])\s+/)].map((p) => p.map((l) => l.trim()).filter(Boolean));
  const split = questions.length > 1 ? parts.find((p) => p.length === questions.length) : undefined;
  const body = [ANSWERS_COMMENT_LABEL, ""];
  if (split) questions.forEach((q, i) => body.push(`\u201c${q}\u201d`, `Answer: ${split[i]}`, ""));
  else {
    questions.forEach((q) => body.push(`\u201c${q}\u201d`));
    if (questions.length) body.push("");
    body.push(questions.length === 1 ? `Answer: ${answer}` : `Answers: ${answer}`);
  }
  const triage = runs
    .filter((r) => r.spec.workstream === workstream.id && r.spec.kind === "triage" && r.state === "done")
    .sort((a, b) => (b.endedAt ?? b.queuedAt).localeCompare(a.endedAt ?? a.queuedAt))[0];
  return {
    steps: ["Read the open questions", "Drafted a comment with your answers"],
    text: `I drafted a comment on **${item.key}** with your answers, each under its question. It goes to the ticket as a comment, not a change to the description, and nothing is posted until you approve it.${triage ? " Once you post the answers, I'll draft the plan." : ""}`,
    filter: null,
    draft: { intent: { type: "comment", item, body: docFromText(body.join("\n").trim()) }, label: ANSWERS_COMMENT_LABEL },
  };
}

/**
 * The plan, proposed on Pip's turn after the person posted their answers: a run draft following the workstream's newest
 * finished Triage, which does not start until they read and start it. Null until the answers are posted (`planDue`), or
 * when the workstream has no finished Triage or no ticket.
 */
export function planAfterAnswers(runs: readonly Run[], workstream: PipWorkstream | null): PipScript | null {
  const item = workstream?.item;
  if (!workstream?.planDue || !item) return null;
  const triage = runs
    .filter((r) => r.spec.workstream === workstream.id && r.spec.kind === "triage" && r.state === "done")
    .sort((a, b) => (b.endedAt ?? b.queuedAt).localeCompare(a.endedAt ?? a.queuedAt))[0];
  if (!triage) return null;
  return {
    steps: ["Read the posted answers", "Drafted an agent run"],
    text: `Your answers are posted on **${item.key}**, so I drafted the plan, following the triage. It has not started. Open the draft to read the exact prompt, then start it.`,
    filter: null,
    draft: null,
    runDraft: { item, kind: "plan", fromRun: triage.id, focus: null },
  };
}

/**
 * The one line a wake adds after the person resumed a workstream its ticket's drift held, e.g. "The ticket's description
 * changed while I was held; I'll work from it as it reads now." Null for any other tripwire, or before the resume.
 */
export function driftLine(trip: LastTrip | null | undefined): string | null {
  if (trip?.kind !== "basis_drift" || !trip.resumedAt) return null;
  const changed = (["summary", "description"] as const).filter((f) => trip.fields.includes(f));
  const done = trip.fields.includes("status");
  const what = changed.length ? `The ticket's ${changed.join(" and ")} changed${done ? " and it was moved to Done" : ""}` : done ? "The ticket was moved to Done" : "The ticket changed";
  return `${what} while I was held; I'll work from it as it reads now.`;
}

/** A key the person named ("plan CA-401"), upper case, when it isn't the workstream's own: then it isn't this workstream's next step. */
const otherKey = (q: string, item: ItemRef | null) => {
  const named = /\b([a-z][a-z0-9]+-\d+)\b/.exec(q)?.[1]?.toUpperCase();
  return named && item && named !== item.key.toUpperCase() ? named : null;
};

/**
 * What Pip does when asked for the next step in a workstream: it drafts that kind and names as the run it follows the
 * workstream's newest finished run of the kind that comes before, else its newest of that kind at all, so the backend says
 * why it can't follow it yet; with none, no run, and the backend refuses. Whatever the draft carries from that run is
 * Gossamr's to fill in.
 */
function chainStep(prompt: string, context: ScreenContext, runs: readonly Run[], workstream: PipWorkstream): PipScript | null {
  const q = prompt.toLowerCase();
  const ask = CHAIN_ASKS.find((a) => a.pattern.test(q));
  if (!ask || otherKey(q, workstream.item)) return null;
  const item = workstream.item ?? context.item;
  if (!item) return { steps: [], text: "This workstream has no ticket, so there is nothing to run that on. Investigate a question instead.", filter: null, draft: null };
  const newest = (done: boolean) =>
    runs
      .filter((r) => r.spec.workstream === workstream.id && r.spec.kind === ask.from && (!done || r.state === "done"))
      .sort((a, b) => (b.endedAt ?? b.queuedAt).localeCompare(a.endedAt ?? a.queuedAt))[0];
  const source = newest(true) ?? (ask.kind === "build" || ask.kind === "review" ? newest(false) : undefined);
  const fromRun = source?.id ?? null;
  const following = source ? ` following ${runPhrase(source)}` : "";
  const carried = ask.kind === "build" ? " Gossamr filled in the plan from that run; I didn't write it." : ask.kind === "review" ? " Gossamr filled in the builder's account and pinned the pull request; I didn't write them." : "";
  return {
    steps: [`Looked up ${item.key}`, "Read the workstream's runs", "Drafted an agent run"],
    text: `I drafted ${CHAIN_WORDS[ask.kind]} of **${item.key}**${following}.${carried} It has not started. Open the draft to read the exact prompt, then start it.`,
    filter: null,
    draft: null,
    runDraft: { item, kind: ask.kind, fromRun, focus: null },
  };
}

const asksToMove = /^\s*(?:please\s+)?move\s+(?:it|this|([A-Z][A-Z0-9]*-\d+))\s+to\s+(.+?)\s*[.!]?\s*$/i;

/** "Move it to QA": a move of the named ticket, else the workstream's or the open one, drafted the way propose_transition does. */
function moveScript(prompt: string, context: ScreenContext, workstream: PipWorkstream | null): PipScript | null {
  const m = asksToMove.exec(prompt);
  if (!m) return null;
  const key = m[1]?.toUpperCase();
  const item: ItemRef | null = key ? { connectionId: workstream?.item?.connectionId ?? context.item?.connectionId ?? "mock", externalId: key, key } : (workstream?.item ?? context.item);
  if (!item) return { steps: [], text: "Which ticket should I move? Name it, or open it first.", filter: null, draft: null };
  const status = m[2].trim();
  return {
    steps: [`Checked the statuses for ${item.key}`, `Suggested a transition for ${item.key}`],
    text: `I drafted a move of **${item.key}** to **${status}**. Nothing changes in Jira until you approve it.`,
    filter: null,
    draft: { intent: { type: "transition", item, to: statusId(item.key.split("-")[0], status) }, label: status },
  };
}

/** Whether the screen line is Pip home's, "Pip home" and then its conversation (`screenLine` in src/workspace/screenContext.ts). */
const onPipHome = (view: string | null | undefined) => view === "Pip home" || !!view?.startsWith("Pip home · ");

const asksToApprovePlan = /^\s*approve the plan\b/i;
const asksWhyHeld = /^\s*why is (?:this|it|the workstream) held\b/i;
const asksWhileAway = /\bwhile i was away\b/i;
const asksWhatRunDoes = /^\s*what is (r\d+) doing\b/i;
const asksWhatWaitsToStart = /^\s*what is waiting to start\b/i;

/**
 * What Pip says to the workstream questions its chips ask: where the plan is approved (Pip approves nothing), why the
 * workstream is held, what its agents did, and what one of them is doing. Null for anything else.
 */
function workstreamAnswer(prompt: string, runs: readonly Run[], workstream: PipWorkstream, now: number): PipScript | null {
  const key = workstream.item?.key ?? "the ticket";
  const own = runs.filter((r) => r.spec.workstream === workstream.id);
  const say = (text: string, steps: string[] = []): PipScript => ({ steps, text, filter: null, draft: null });
  if (asksToApprovePlan.test(prompt))
    return say(`I can't approve anything myself. The plan's update to the description of **${key}** waits in the Plan step on the right, and in ${key}'s peek: read the change there and press Update description. The build starts only after that.`, ["Read the workstream's drafts"]);
  if (asksWhyHeld.test(prompt)) {
    const held = heldText(workstream.heldReason, workstream.drifted);
    return say(
      held
        ? `${held}. While it is held I'm not woken and nothing starts on its own; agents already running carry on. Resume it from the Steps column or type /resume.`
        : "This workstream isn't held. Its automatic steps run as its rules say, and every change to Jira still waits for you.",
    );
  }
  if (asksWhileAway.test(prompt)) return say(agentSummary(own, now), ["Read the workstream's runs"]);
  if (asksWhatWaitsToStart.test(prompt))
    return say(`A run I drafted for **${key}** waits in this conversation and under its step on the right. Press Review and start on it to read the exact prompt, then Start agent. Nothing runs before that, and I can't start it myself.`, ["Read the workstream's drafts"]);
  const named = asksWhatRunDoes.exec(prompt)?.[1]?.toUpperCase();
  if (named) {
    const run = own.find((r) => labelsByRun(runs).get(r.id) === named);
    return say(run ? `${named} is ${stateView(run, now).label.toLowerCase()}${run.lastDetail ? `: ${run.lastDetail}` : "."}` : `There is no ${named} in this workstream.`, ["Read the workstream's runs"]);
  }
  return null;
}

/** How a wake's prompt starts: the supervisor's event lines (`eventLine` in mockSupervisor.ts). */
const EVENT = "[Event] ";
const EVENT_LINE = /^\[Event\] (?:run (\S+)|a run) \((\w+)\) ([^;]+)(.*)$/;

const KIND_WORD: Record<RunKind, string> = { investigate: "Investigate", triage: "Triage", plan: "Plan", build: "Build", review: "Review", verify: "Verify" };

/** The reply Pip suggests to a run's question: the run's own suggestion when it made one, else a careful default grounded in its ticket. */
export function suggestedAnswer(run: Run): string {
  if (run.suggestedReply?.trim()) return run.suggestedReply.trim();
  const ticket = run.item ? `what ${run.item.key} asks for` : "what you were asked";
  return `Do what changes the least and still meets ${ticket}. If you're unsure, say why in your result instead of guessing.`;
}

/**
 * What Pip says when the supervisor wakes it: one short line for each event, at most three, from the event lines
 * alone. A run a rule started is "queued to start" until it shows Working, and nothing Pip says starts anything. A run
 * asking a question gets a suggested reply drafted for the person to check; Pip never sends it.
 */
function wakeScript(prompt: string, runs: readonly Run[], workstream: PipWorkstream | null = null): PipScript {
  const answers: { runId: string; message: string }[] = [];
  const labels = labelsByRun(runs);
  // A run by its workstream label (R1), else by ticket and step; never by its id.
  const name = (id: string | undefined) => (id ? (labels.get(id) ?? capital(runPhrase(runs.find((r) => r.id === id)))) : "A run");
  const startedState = (kind: string, label: string) => {
    const ws = runs.find((r) => labels.get(r.id) === label && r.spec.kind === kind);
    return ws?.state === "working" ? "is working on it" : "is queued to start automatically";
  };
  const lines = prompt
    .split("\n")
    .map((l) => EVENT_LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 3)
    .map(([, id, kind, state, rest]) => {
      const who = id && !labels.has(id) ? name(id) : `${KIND_WORD[kind as RunKind] ?? "The run"} ${name(id)}`;
      const started = /; started (\w+) (\S+) automatically/.exec(rest);
      if (started) return `${name(id)} finished. ${KIND_WORD[started[1] as RunKind] ?? started[1]} ${started[2]} ${startedState(started[1], started[2])}.`;
      const fix = /; sent fix round (\d+) to build (\S+)/.exec(rest);
      if (fix) return `${who} still blocks, so fix round ${fix[1]} went to build ${fix[2]}. A fresh review follows its new commit.`;
      if (rest.includes("; review still blocking after")) return "The review still blocks after 2 fix rounds. Over to you. Run another fix round, take it from here, or post the review as is.";
      if (rest.includes("; waiting for its pull request")) return `${who} finished. Its review starts once its pull request shows up.`;
      if (rest.includes("; plan recommended: no")) return `${who} finished and doesn't recommend a plan, so nothing starts on its own. Tell me if you want one.`;
      if (rest.includes("; verdict: pass")) return `${who} passed. Nothing else starts on its own; the pull request is yours to mark ready.`;
      if (state.trim() === "Done") {
        const drafts = /; (\d+) drafts?/.exec(rest)?.[1];
        const done = `${who} finished.${drafts ? ` It left ${drafts === "1" ? "a draft" : `${drafts} drafts`} for you.` : ""}`;
        // A plan that left no draft has no description update to approve.
        if (kind !== "plan" || !drafts) return done;
        // Approving the plan is approving its description update: say so, and what the plan left open for a person.
        const questions = planOpenQuestions(runs.find((r) => r.id === id)?.result);
        const open = questions.length ? `\n\nIt leaves ${questions.length === 1 ? "an open question" : `${questions.length} open questions`} for you, worth answering first if they change the plan:\n${questions.map((q) => `- ${q}`).join("\n")}` : "";
        return `${done} ${APPROVE_PLAN}${open}`;
      }
      const asking = state.trim() === "Needs an answer" ? runs.find((r) => r.id === id && r.state === "needsAnswer") : undefined;
      if (asking) {
        if (!answers.some((a) => a.runId === asking.id)) answers.push({ runId: asking.id, message: suggestedAnswer(asking) });
        return `${name(id)} asks${asking.needs ? `: “${asking.needs.trim()}”` : " a question."} I drafted a reply for you to check.`;
      }
      if (/^Needs|^Blocked/.test(state.trim())) return `${who} ${state.trim().toLowerCase()}. Open it to see what it asks.`;
      return `${who} ${state.trim().toLowerCase()}. Nothing starts after it; tell me what you want to do.`;
    });
  const drift = driftLine(workstream?.lastTrip);
  const said = lines.join("\n\n") || "Something changed in this workstream; nothing needs you yet.";
  return { steps: answers.length ? ["Read the run", "Drafted an answer for a run"] : [], text: drift ? `${drift}\n\n${said}` : said, filter: null, draft: null, answers };
}

/** What Pip does when asked to send a finished run back: only a run that left open questions gets a follow-up, and only one at a time. */
function sendBack(context: ScreenContext, runs: readonly Run[], drafts: readonly Proposal[], discussed: string | null): PipScript {
  const none = (text: string): PipScript => ({ steps: [], text, filter: null, draft: null });
  const from = drafts.find((d) => d.id === discussed)?.origin;
  const run = (context.run ? runs.find((r) => r.id === context.run) : undefined) ?? (from?.type === "run" ? runs.find((r) => r.id === from.runId) : undefined) ?? runs.find((r) => r.state === "done" && !!r.item && r.item.externalId === context.item?.externalId);
  if (!run) return none("Which run do you mean? Open the ticket it ran on, or use Discuss with Pip on one of its drafts, and ask again.");
  const blocker = followUpBlocker(run);
  if (blocker) return none(`I can't send ${runPhrase(run)} back: ${blocker}.`);
  const waiting = drafts.find((d) => d.state.type === "pending" && d.intent.type === "followUp" && d.intent.runId === run.id);
  if (waiting) return none(`A follow-up for ${runPhrase(run)} is already waiting for you. Read it, edit it if you like, and send it back.`);
  const questions = openQuestions(run.result ?? "");
  if (!questions) return { steps: ["Read the run", "Read the rest of its result"], text: `I read the whole result of ${runPhrase(run)}: it did its job and left nothing open, so I won't send it back.`, filter: null, draft: null };
  return {
    steps: ["Read the run", "Read the rest of its result", "Drafted a follow-up"],
    text: `${capital(runPhrase(run))} left open questions, so I drafted a follow-up with the exact message. Nothing is sent: read it, change it if you like, and press Send back.`,
    filter: null,
    draft: null,
    followUp: { runId: run.id, message: `Please settle the open questions you left in your plan, then update the plan to match.\n\nOpen questions:\n${questions}\n\nKeep everything else in the plan as it is.`, reason: "the plan left open questions" },
  };
}

/** The pending draft a question is about: the one discussed, else the only one on the open ticket. */
function draftInQuestion(drafts: readonly Proposal[], context: ScreenContext, discussed: string | null): Proposal | undefined {
  const pending = drafts.filter((d) => d.state.type === "pending");
  if (discussed) return pending.find((d) => d.id === discussed);
  const here = pending.filter((d) => !isRunDraft(d.intent) && targetOf(d.intent)?.externalId === context.item?.externalId && targetOf(d.intent)?.connectionId === context.item?.connectionId);
  return here.length === 1 ? here[0] : undefined;
}

const draftText = (d: Proposal): string | null => {
  switch (d.intent.type) {
    case "rewrite":
      return d.intent.body?.toText ?? d.intent.title?.to ?? null;
    case "comment":
      return docText(d.intent.body);
    default:
      return null;
  }
};

/** The comment a run left for the person, newest first, that Pip may revise. */
const runDrafts = (drafts: readonly Proposal[]) => drafts.filter((d) => d.state.type === "pending" && d.origin.type === "run" && d.intent.type === "comment");

/** A sample tightening of a ticket: the title loses a trailing possessive, and each paragraph keeps its first sentence. */
function tightenedTicket(title: string, body: string): { title: string; body: string } {
  const first = (paragraph: string) => /^.*?[.!?](?=\s|$)/s.exec(paragraph.trim())?.[0] ?? paragraph.trim();
  return { title: title.replace(/'s\s+\w+$/, ""), body: body.split(/\n{2,}|\n/).filter((p) => p.trim()).map(first).join("\n\n") };
}

/** A sample tightening of a description with a plan section: everything before it stays, and each line after the heading keeps its first sentence. */
function shorterPlan(markdown: string): string {
  const at = markdown.search(/^#{1,6} Gossamr Plan$/m);
  if (at < 0) return markdown;
  const first = (line: string) => /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  const plan = markdown
    .slice(at)
    .split("\n")
    .map((l) => (/^#|^\s*$/.test(l) ? l : first(l)));
  return `${markdown.slice(0, at)}${plan.join("\n")}`;
}

function revisedBody(text: string, shorter: boolean): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const note = lines.length > 1 ? lines.slice(1) : lines;
  return shorter ? (note[0] ?? text) : `Short version: ${(note[0] ?? text).replace(/\.$/, "")}. The rest is in the run.`;
}

/** What the agents are doing, one line each, from the runs the person has. */
export function agentSummary(runs: readonly Run[], now: number): string {
  if (!runs.length) return "You have no agent runs. Open a ticket and choose Agent to start one.";
  const waiting = runs.filter(needsPerson);
  const going = runs.filter((r) => r.state === "working" || r.state === "launching" || r.state === "queued");
  const done = runs.filter((r) => r.state === "done");
  const live = liveCounts(runs, now);
  const line = (r: Run) => `- **${r.item?.key ?? r.spec.repo}** ${stateView(r, now).label.toLowerCase()}${r.lastDetail ? `: ${r.lastDetail}` : r.needs ? `: ${r.needs}` : ""}`;
  const part = (title: string, list: readonly Run[]) => (list.length ? `${title}\n${list.slice(0, 5).map(line).join("\n")}` : "");
  return [
    // Counted as the Agents view's summary and Pip home's footer count them, quiet runs apart.
    `You have ${runs.length} agent ${runs.length === 1 ? "run" : "runs"}: ${[`${waiting.length} waiting on you`, ...(liveWords(live).length ? liveWords(live) : ["none running"]), ...(live.quiet ? [`${live.quiet} quiet`] : []), `${done.length} ready to review`].join(", ")}.`,
    part("Waiting on you", waiting),
    part("Working", going),
    part("Ready to review", done),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const FINDINGS_SHOWN = 5;

/** What the finished runs found, one line each: the part of the result meant for Jira, or its first line. */
/** What the run-done nudge asks (runNudges in src/workspace/pipRuns.ts): what one finished run found. */
const asksWhatRunFound = /^What did the agent find in run (\S+)\?$/;

/** What one run found, named as the person knows it: its note for the ticket, or that it left none. */
function runFound(run: Run | undefined): PipScript {
  if (!run) return { steps: [], text: "I can't find that run any more, so I can't say what it found.", filter: null, draft: null };
  const note = jiraNote(run.result ?? "").text.trim();
  return {
    steps: ["Read the run", "Read the rest of its result"],
    text: note ? `I read the whole result of ${runPhrase(run)}. It found:\n\n${note}` : `${capital(runPhrase(run))} finished without a written answer, so there is nothing to sum up.`,
    filter: null,
    draft: null,
  };
}

function findings(runs: readonly Run[]): string {
  const done = runs.filter((r) => r.state === "done");
  if (!done.length) return "No agent has finished yet.";
  const line = (r: Run) => `- **${r.item?.key ?? r.spec.repo}** ${resultHeadline(jiraNote(r.result ?? "").text) ?? "finished without a written answer"}`;
  return `${done.length} ${done.length === 1 ? "run has" : "runs have"} finished:\n${done.slice(0, FINDINGS_SHOWN).map(line).join("\n")}${done.length > FINDINGS_SHOWN ? `\n…and ${done.length - FINDINGS_SHOWN} more.` : ""}`;
}

/**
 * The ticket a text edit is for: the one the request attaches to the description or title ("description of CA-401", "CA-401's title"),
 * else the open one, else the first key written anywhere. A key mentioned in passing ("since CA-271 found") doesn't take the edit from the open ticket.
 */
function rewriteTarget(prompt: string, context: ScreenContext): ItemRef | null {
  const attached =
    new RegExp(`\\b${ANY_KEY}(?:'s|\u2019s)?\\s+(?:description|title)\\b`, "i").exec(prompt)?.[1] ??
    new RegExp(`\\b(?:description|title)s?(?:\\s+(?:update|edit|rewrite|revision|change))?\\s+(?:of|for|on|in|at)\\s+(?:the\\s+)?${TICKET_WORDS}${ANY_KEY}\\b`, "i").exec(prompt)?.[1];
  const key = (attached ?? (context.item ? null : new RegExp(`\\b${ANY_KEY}\\b`).exec(prompt)?.[1]))?.toUpperCase();
  if (!key) return context.item;
  if (context.item?.key.toUpperCase() === key) return context.item;
  return { connectionId: context.item?.connectionId ?? context.selection[0]?.connectionId ?? "mock", externalId: key, key };
}

/**
 * The scripted assistant the browser build talks to; it decides from keywords and the screen context alone. Its first
 * turn in a workstream opens with the readiness check of the ticket, whatever it was asked (`readinessLine`).
 */
export function scriptPip(prompt: string, context: ScreenContext, images: ImageData[] = [], runs: readonly Run[] = [], now = Date.now(), drafts: readonly Proposal[] = [], discussed: string | null = null, workstream: PipWorkstream | null = null): PipScript {
  const turn = scriptTurn(prompt, context, images, runs, now, drafts, discussed, workstream);
  // Their answers were posted: whatever else this turn does, it also proposes the plan they were waiting to follow.
  const plan = turn.runDraft ? null : planAfterAnswers(runs, workstream);
  const script = plan ? { ...turn, steps: [...turn.steps, ...plan.steps], text: `${turn.text}\n\n${plan.text}`, runDraft: plan.runDraft } : turn;
  const unclear = prompt.startsWith(EVENT) ? null : readinessLine(workstream);
  return unclear ? { ...script, steps: ["Read the ticket", ...script.steps], text: `${unclear}\n\n${script.text}` } : script;
}

/** The ways Pip words a check-in comment, one for each that already waits on the ticket. */
const NUDGES = ["Checking in on this one. Is it still on track, or does anything need to move?", "Following up here. Has anything changed since the last update?", "One more look at this. Is anything holding it up that we could clear?"];

/** The check-in wording for the next draft on `item`: the first the ticket's waiting drafts don't use yet, so two never say the same. */
function nudgeText(drafts: readonly Proposal[], item: ItemRef): string {
  const waiting = new Set(drafts.filter((d) => d.state.type === "pending" && d.intent.type === "comment" && d.intent.item.externalId === item.externalId).map((d) => (d.intent.type === "comment" ? docText(d.intent.body) : "")));
  return NUDGES.find((n) => !waiting.has(n)) ?? NUDGES[0];
}

function scriptTurn(prompt: string, context: ScreenContext, images: ImageData[], runs: readonly Run[], now: number, drafts: readonly Proposal[], discussed: string | null, workstream: PipWorkstream | null): PipScript {
  if (prompt.startsWith(EVENT)) return wakeScript(prompt, runs, workstream);
  const answers = answersScript(prompt, runs, workstream);
  if (answers) return answers;
  const q = prompt.toLowerCase();
  const foundIn = asksWhatRunFound.exec(prompt.trim());
  if (foundIn) return runFound(runs.find((r) => r.id === foundIn[1]));
  if (asksToSendBack.test(prompt)) return sendBack(context, runs, drafts, discussed);
  const move = moveScript(prompt, context, workstream);
  if (move) return move;
  const answer = workstream ? workstreamAnswer(prompt, runs, workstream, now) : null;
  if (answer) return answer;
  const step = workstream ? chainStep(prompt, context, runs, workstream) : null;
  if (step) return step;
  const review = reviewScript(prompt, drafts, discussed);
  if (review) return review;
  const finishing = finishes.exec(prompt);
  if (finishing) {
    const left = drafts.find((d) => d.id === finishing[1] && d.state.type === "pending" && d.origin.type === "run" && d.intent.type === "create");
    if (left?.intent.type !== "create") return { steps: [], text: "I can't find that ticket draft any more, or it has been decided already, so there is nothing for me to finish.", filter: null, draft: null };
    return {
      steps: ["Read the run", "Read the rest of its result", "Tightened the draft ticket"],
      text: "I read the whole run and tightened the draft: a shorter title and one sentence for each point. Nothing is created in Jira; read it, edit it, then approve it or skip it.",
      filter: null,
      draft: null,
      discussed: left.id,
      revise: { id: left.id, ...tightenedTicket(left.intent.fields.title, docText(left.intent.fields.body)) },
    };
  }
  const breakdownTalk = talksBreakdown.exec(prompt);
  const breakdown = (id: string | null | undefined) =>
    drafts.find((d) => d.id === id && d.state.type === "pending" && d.intent.type === "subtasks" && (d.createdBy === "pip" || leftByRun(d)));
  if (breakdownTalk) {
    const left = breakdown(breakdownTalk[1]);
    if (!left) return { steps: [], text: "I can't find that breakdown draft any more, or it has been decided already, so there is nothing to discuss.", filter: null, draft: null };
    return {
      steps: ["Read the run", "Read the rest of its result", "Looked at the breakdown"],
      text: `I read the whole run and checked it against ${draftPhrase(left, runs)}. Tell me what to change, for example "fewer" or "shorter", and I'll revise the summaries. Nothing is created in Jira until you approve it.`,
      filter: null,
      draft: null,
      discussed: left.id,
    };
  }
  const discussedBreakdown = breakdown(discussed);
  if (discussedBreakdown?.intent.type === "subtasks" && (asksForFewer.test(q) || asksForShorter.test(q))) {
    const fewer = asksForFewer.test(q);
    const summaries = discussedBreakdown.intent.summaries;
    return {
      steps: ["Read the run's full result", "Revised the breakdown"],
      text: `${fewer ? "I kept the three tasks that matter most." : "I shortened the wording of each task and kept them all."} It isn't created; read it and approve, edit or skip it.`,
      filter: null,
      draft: null,
      revise: { id: discussedBreakdown.id, summaries: fewer ? summaries.slice(0, 3) : summaries.map(shortened) },
    };
  }
  const proposed = proposesBreakdown.exec(q)?.[1];
  const breakdownRun = proposed ? runs.find((r) => r.id.toLowerCase() === proposed) : undefined;
  if (breakdownRun?.item) {
    const summaries = subtaskProposals(breakdownRun.result ?? "");
    if (!summaries.length) return { steps: ["Read the run"], text: `The run doesn't propose a breakdown, so I left **${breakdownRun.item.key}** as one piece.`, filter: null, draft: null };
    return {
      steps: ["Read the run", `Drafted subtasks on ${breakdownRun.item.key}`],
      text: `I drafted ${summaries.length} subtasks on **${breakdownRun.item.key}** from what the run proposed. Nothing is created; edit the list, then approve it or skip it.`,
      filter: null,
      draft: { intent: { type: "subtasks", parent: breakdownRun.item, summaries }, label: "From an agent run" },
    };
  }
  if (asksToSeeDraft.test(prompt)) {
    const seen = draftInQuestion(drafts, context, discussed);
    const text = seen && draftText(seen);
    if (!seen || !text) return { steps: [], text: "Which draft do you mean? Open its ticket or use Discuss with Pip on it, and I'll read it in full.", filter: null, draft: null };
    const questions = openQuestions(text);
    const open = questions ? ` It has open questions:\n\n${questions}` : " It has no open questions.";
    return {
      steps: ["Read the draft in full"],
      text: `Yes, I read ${draftPhrase(seen, runs)} in full, all ${text.split("\n").length} lines of it.${open}\n\nTell me what you want done and I'll revise it or send the agent back.`,
      filter: null,
      draft: null,
      discussed: seen.id,
    };
  }
  const descriptionTalk = talksDescription.exec(prompt);
  const description = (id: string | null | undefined) => drafts.find((d) => d.id === id && d.state.type === "pending" && leftByRun(d) && d.intent.type === "rewrite" && !!d.intent.body);
  if (descriptionTalk) {
    const left = description(descriptionTalk[1]);
    if (!left) return { steps: [], text: "I can't find that description draft any more, or it has been decided already, so there is nothing to discuss.", filter: null, draft: null };
    return {
      steps: ["Read the run", "Read the rest of its result", "Read the ticket", "Checked the draft"],
      text: `I read the whole run and the ticket and checked ${draftPhrase(left, runs)}: the ticket's description with the run's plan added under a "Gossamr Plan" heading. A build follows that plan, so only you change it. Tell me what you'd change, for example "shorter", and I'll suggest the words for you to put in. Nothing is written to Jira until you approve it.`,
      filter: null,
      draft: null,
      discussed: left.id,
    };
  }
  const discussedDescription = description(discussed);
  if (discussedDescription?.intent.type === "rewrite" && discussedDescription.intent.body && asksForShorter.test(q)) {
    // The plan a build follows is the person's to change, so Pip only suggests the words.
    const plan = shorterPlan(discussedDescription.intent.body.toText);
    const section = plan.slice(Math.max(0, plan.search(/^#{1,6} Gossamr Plan$/m)));
    return {
      steps: ["Read the run's full result", "Suggested a shorter plan"],
      text: `A build follows this plan, so I can't change the draft; edit it yourself if you like this. I'd keep the ticket's own text and shorten each point in the plan to its first sentence:\n\n${section}`,
      filter: null,
      draft: null,
    };
  }
  const talked = discusses.exec(prompt);
  if (talked) {
    const talkedOf = drafts.find((d) => d.id === talked[1]);
    return {
      steps: ["Read the run", "Read the rest of its result", "Looked at the draft"],
      text: `I read the whole run, not only the start of its result, and checked it against ${talkedOf ? draftPhrase(talkedOf, runs) : "the draft"}. The draft says what the run found. Tell me what to change, for example "shorter", and I'll revise it. It stays a draft until you approve it.`,
      filter: null,
      draft: null,
      discussed: talked[1],
    };
  }
  if (asksForTextEdit.test(q) && !actsOnComment.test(q)) {
    const target = rewriteTarget(prompt, context);
    if (!target) {
      return { steps: [], text: "Which ticket? Open it and ask again, and I'll draft the new text for you to review.", filter: null, draft: null };
    }
    const part = /\btitle\b/.test(q) && !/\bdescription\b/.test(q) ? "title" : "description";
    return {
      steps: [`Looked up ${target.key}`, `Drafted a new ${part} for ${target.key}`],
      text: `I drafted a new ${part} for **${target.key}**. Nothing is changed in Jira: read the before and after, edit the text if you like, then approve it or skip it. If the ticket is edited first, the draft is refused and I'll redraft from the new text.`,
      filter: null,
      draft: null,
      rewrite: { item: target, part },
    };
  }
  if (asksToRevise.test(q)) {
    const waiting = runDrafts(drafts);
    const onScreen = (d: Proposal) => d.intent.type === "comment" && !!context.item && d.intent.item.connectionId === context.item.connectionId && d.intent.item.externalId === context.item.externalId;
    const left = discussed ? waiting.find((d) => d.id === discussed) : waiting.length === 1 && onScreen(waiting[0]) ? waiting[0] : undefined;
    if (!left && waiting.length > 0) {
      return { steps: [], text: "Which comment draft do you mean? Use Discuss with Pip on it, then tell me what to change.", filter: null, draft: null };
    }
    if (left?.intent.type === "comment") {
      return {
        steps: ["Read the run's full result", `Revised the draft on ${left.intent.item.key}`],
        text: "I changed the draft. It isn't posted; read it and approve, edit or skip it.",
        filter: null,
        draft: null,
        revise: { id: left.id, body: revisedBody(docText(left.intent.body), asksForShorter.test(q)) },
      };
    }
  }
  const asked = /draft a jira comment from run (\S+?):/.exec(q)?.[1];
  const forRun = asked ? runs.find((r) => r.id.toLowerCase() === asked) : undefined;
  if (forRun?.item) {
    const note = jiraNote(forRun.result ?? "").text;
    const item = forRun.item;
    return {
      steps: ["Read the run", `Drafted a comment on ${item.key}`],
      text: `I drafted a short comment on **${item.key}** from what the run found. It isn't posted; approve, edit or skip it below.`,
      filter: null,
      draft: { intent: { type: "comment", item, body: docFromText(note || "It finished without a written answer.") }, label: "From an agent run" },
    };
  }
  const openRun = context.run ? runs.find((r) => r.id === context.run) : undefined;
  if (openRun?.item && openRun.state === "done" && /draft a comment from this run/.test(q)) {
    const item = openRun.item;
    return {
      steps: ["Read the run", `Drafted a comment on ${item.key}`],
      text: `I drafted a short comment on **${item.key}** from what the run found. It isn't posted; approve, edit or skip it below.`,
      filter: null,
      draft: { intent: { type: "comment", item, body: docFromText(jiraNote(openRun.result ?? "").text || "It finished without a written answer.") }, label: "From an agent run" },
    };
  }
  if (/\bfinished runs\b.*\bfind\b/.test(q)) return { steps: ["Read the finished runs"], text: findings(runs), filter: null, draft: null };
  if (asksAboutAgents.test(q) && !asksForAgent.test(q)) {
    return { steps: ["Looked at your agents"], text: agentSummary(runs, now), filter: null, draft: null };
  }
  if (asksForAgent.test(q)) {
    const key = KEY.exec(prompt)?.[1];
    const item: ItemRef | null = key
      ? context.item?.key === key
        ? context.item
        : { connectionId: context.item?.connectionId ?? context.selection[0]?.connectionId ?? "mock", externalId: key, key }
      : context.item;
    if (item) {
      const focus = /(?:focus on|look at|check)\s+(.+)$/i.exec(prompt.trim())?.[1]?.trim().slice(0, 300) ?? null;
      return {
        steps: [`Looked up ${item.key}`, "Drafted an agent run"],
        text: `I drafted an investigation of **${item.key}**${focus ? ` with a focus note: “${focus}”` : ""}. It has not started. Open the draft to read the exact prompt, then start it.`,
        filter: null,
        draft: null,
        runDraft: { item, kind: "investigate", fromRun: null, focus },
      };
    }
    const ask = ticketlessQuestion(prompt);
    if (ask) {
      return {
        steps: ["Drafted an agent run"],
        text: `No ticket covers this, so I drafted an investigation in **${ask.repo ?? "your repository"}** with no ticket: “${ask.prompt}” It has not started. Open the draft to read and edit the exact prompt, then start it. When the agent finishes, you get a draft ticket from what it found, and you approve that too.`,
        filter: null,
        draft: null,
        ticketlessRun: ask,
      };
    }
  }
  const wanted = FILTERS.find((f) => f.pattern.test(q));
  if (wanted && (asksToShow.test(q) || !context.item)) {
    const filter = context.filter ? and(context.filter, wanted.filter) : wanted.filter;
    return {
      steps: ["Searched the items"],
      // On Pip home no board is on screen: the filter lands on the workspace tab, there when the person goes back.
      text: `${wanted.note}. ${onPipHome(context.view) ? "I filtered your workspace tab for you; it is there when you go back to it. Undo it below if that wasn't what you meant." : "I filtered this view for you; undo it below if that wasn't what you meant."}`,
      filter: { filter, note: wanted.note },
      draft: null,
    };
  }
  if (context.item && /comment|reply|nudge|ping|draft/.test(q)) {
    const item: ItemRef = context.item;
    return {
      steps: [`Looked up ${item.key}`, `Drafted a comment on ${item.key}`],
      text: `I drafted a short comment on **${item.key}**. It isn't posted; approve, edit or skip it below.`,
      filter: null,
      draft: {
        // A comment asked for while one of these waits on the ticket says it in other words, so two drafts in a row don't post the same text twice.
        intent: { type: "comment", item, body: docFromText(nudgeText(drafts, item)) },
        label: null,
      },
    };
  }
  if (/(create|new|open|file)\b.*\b(ticket|task|issue)|follow-?up/.test(q)) {
    const container = context.item ? { connectionId: context.item.connectionId, externalId: context.item.key.split("-")[0] } : { connectionId: "mock", externalId: "DEVOPS" };
    const about = context.item ? ` after ${context.item.key}` : "";
    return {
      steps: ["Drafted a new ticket"],
      text: `I drafted a follow-up ticket${about}. It doesn't exist yet; open it to edit anything, then create it or skip it.`,
      filter: null,
      draft: {
        intent: {
          type: "create",
          container,
          fields: {
            title: "Follow up on the rollout",
            body: docFromText("Check that the change landed everywhere and write up anything that surprised us.\n\nOwner to confirm the date."),
            kind: "task",
            assignee: null,
            parent: null,
            priority: null,
            labels: [],
          },
          link: null,
        },
        label: null,
      },
    };
  }
  if (images.length) {
    const kinds = images.map((i) => i.mediaType.replace("image/", "").toUpperCase()).join(", ");
    return {
      steps: [],
      text: `I got ${images.length === 1 ? "your screenshot" : `your ${images.length} screenshots`} (${kinds}). This is the sample assistant, so I can't look at it; the real Pip describes what it sees and drafts from there.`,
      filter: null,
      draft: null,
    };
  }
  if (/prompt|paste|snippet/.test(q)) {
    return {
      steps: [],
      text: "Here is a prompt you can paste elsewhere:\n\n```\nSummarise the open tickets for this sprint.\nGroup them by assignee and flag anything blocked.\n```\n\nAnd a shell one-liner:\n\n```sh\ngit log --since=\"1 week ago\" --oneline\n```",
      filter: null,
      draft: null,
    };
  }
  if (openRun) {
    const doing = openRun.needs ?? openRun.lastDetail ?? resultHeadline(openRun.result);
    return {
      steps: ["Read the run"],
      text: `You have **${runTitle(openRun, null)}** open. Its state: ${stateView(openRun, now).label.toLowerCase()}${doing ? `. ${doing}` : "."}`,
      filter: null,
      draft: null,
    };
  }
  if (context.view?.startsWith("Agents")) return { steps: ["Looked at your agents"], text: agentSummary(runs, now), filter: null, draft: null };
  if (onPipHome(context.view))
    return { steps: [], text: "You're on Pip home. Pick a workstream on the left to talk about it, ask me what your agents are doing, or start a workstream on a ticket with ⌘K.", filter: null, draft: null };
  const where = context.view ?? "the workspace";
  const open = context.item ? ` and **${context.item.key}** is open` : "";
  return {
    steps: [],
    text: `You're looking at ${where}${open}. Ask me to show stale or blocked tickets, or to draft a comment on the open one.`,
    filter: null,
    draft: null,
  };
}

type Listener = (requestId: string, e: ClaudeEvent, meta?: EventMeta) => void;
type ViewListener = (requestId: string, filter: WorkFilter, note: string) => void;

/** The parts of a backend the scripted Pip writes to; only the sample backend has them. */
export interface PipDrafter {
  pipDraft(intent: Intent, label: string | null, requestId: string): Promise<unknown>;
  /** The runs Pip can read. */
  pipRuns(): Run[];
  /** The drafts Pip can see. */
  pipDrafts(): Proposal[];
  /** Revises a comment or new-ticket draft that came from a run, the way `revise_proposal` does. */
  pipRevise(id: string, change: string | { body?: string; title?: string; description?: string; summaries?: string[]; comments?: ReviewComment[] }, requestId?: string): Promise<unknown>;
  /** Drafts a title or description edit the way propose_description_edit does. */
  pipRewrite(item: ItemRef, part: "title" | "description", requestId: string): Promise<unknown>;
  /** Drafts a follow-up for a finished run the way propose_follow_up does. */
  pipFollowUp(runId: string, message: string, reason: string, requestId: string): Promise<unknown>;
  /** Drafts an answer to a run that is asking a question the way propose_answer does. */
  pipAnswer(runId: string, message: string, requestId: string): Promise<unknown>;
  /** Drafts a run the way propose_run does: Pip names the ticket, the kind, the run it follows and a focus note, the backend builds the rest. */
  pipRunDraft(item: ItemRef, kind: RunKind, fromRun: string | null, focus: string | null, requestId: string): Promise<unknown>;
  /** The ticket of workstream `id`, for a turn asked in its conversation. */
  pipWorkstreamItem(id: string): ItemRef | null;
  /** The gaps Gossamr's word check found in workstream `id`'s ticket while its notice shows, for Pip's readiness line in a first turn. */
  pipWorkstreamClarity?(id: string): readonly ClarityGap[] | null;
  /** Whether the person chose "I'll answer" in workstream `id` and no comment with their answers was drafted since. */
  pipWorkstreamAnswersDue?(id: string): boolean;
  /** Whether the answers comment of workstream `id` was posted and no plan was drafted or started since: Pip proposes the plan on its next turn. */
  pipWorkstreamPlanDue?(id: string): boolean;
  /** Why workstream `id` is held, or null; only the scripted answer to "Why is this held?" reads it. */
  pipWorkstreamHeld(id: string): string | null;
  /** The ticket fields whose drift held workstream `id`, while it is held for that. */
  pipWorkstreamDrifted?(id: string): readonly BasisField[] | null;
  /** The last tripwire that held workstream `id`, while no wake told Pip of it since the person resumed it; a wake's script reads it. */
  pipWorkstreamTrip?(id: string): LastTrip | null;
  /** Drafts an investigation with no ticket the way propose_run does: Pip gives a repository and a prompt, the backend builds the rest. */
  pipTicketlessRunDraft(repo: string | null, prompt: string, requestId: string): Promise<unknown>;
  /** Whether a draft from the question `requestId` is kept already. */
  pipDrafted(requestId: string): boolean;
  /** The person wrote in workstream `id`'s conversation, which counts its automatic turns from zero again. */
  pipPersonWrote(id: string): void;
}

const listeners = new Set<Listener>();
const viewListeners = new Set<ViewListener>();
const running = new Map<string, () => void>();
/** The draft each conversation last discussed, so "shorter" changes that one and no other. */
const discussing = new Map<string, string>();

export const mockPipEvents = {
  /** Tells every listener about `e`, as the app's `claude` event does; a wake's events say where they belong (`meta`). */
  emit(requestId: string, e: ClaudeEvent, meta?: EventMeta) {
    listeners.forEach((l) => l(requestId, e, meta));
  },
  on(cb: Listener) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
  onView(cb: ViewListener) {
    viewListeners.add(cb);
    return () => void viewListeners.delete(cb);
  },
};

/** Where the events of `req` belong: a wake's carry its conversation and event lines, as the app's do; a question's nothing. */
export const metaOf = (req: Pick<AskRequest, "kind" | "conversation" | "prompt">): EventMeta | undefined =>
  req.kind === "wake" ? { conversation: req.conversation ?? GENERAL_CONVERSATION, kind: "wake", prompt: req.prompt } : undefined;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** While set, every scripted turn waits after it starts, so a test can act while one is running (`__gossamrMock.holdPip`). */
let gate: { promise: Promise<void>; open(): void } | null = null;

/** Makes the scripted Pip wait after starting each turn (`on`), or lets the waiting turns go on. */
export function holdMockPip(on: boolean) {
  if (on && !gate) {
    let open = () => {};
    const promise = new Promise<void>((resolve) => (open = resolve));
    gate = { promise, open };
  } else if (!on && gate) {
    gate.open();
    gate = null;
  }
}

/** Streams the scripted answer for `req` and resolves with the session it used. `drafter` receives the draft the script proposes. */
export async function mockAsk(req: AskRequest, drafter: Partial<PipDrafter> | null, pace = 25): Promise<string> {
  let stopped = false;
  running.set(req.requestId, () => (stopped = true));
  const session = req.sessionId ?? `mock-session-${req.requestId}`;
  const meta = metaOf(req);
  const emit = (id: string, e: ClaudeEvent) => mockPipEvents.emit(id, e, meta);
  // Kept the way the app keeps a turn: the question now, steps as they come, the answer and its usage at the end.
  const wsId = workstreamOfConversation(req.conversation);
  // Pip's first turn in a workstream opens with the readiness check: no other turn is kept in its conversation (a turn waiting
  // in the queue is kept already, so this one's own entry doesn't count).
  const first = !!wsId && req.kind !== "wake" && mockPipTurns.turns(req.conversation ?? GENERAL_CONVERSATION).every((t) => t.requestId === req.requestId);
  mockPipTurns.begin(req.conversation ?? GENERAL_CONVERSATION, req.requestId, req.prompt, req.meta ?? { imageCount: req.images?.length ?? 0 }, "running", new Date(), undefined, req.kind ?? "user");
  const item = wsId ? (drafter?.pipWorkstreamItem?.(wsId) ?? null) : null;
  const workstream = wsId ? { id: wsId, item, heldReason: drafter?.pipWorkstreamHeld?.(wsId) ?? null, drifted: drafter?.pipWorkstreamDrifted?.(wsId) ?? null, lastTrip: drafter?.pipWorkstreamTrip?.(wsId) ?? null, first, clarity: drafter?.pipWorkstreamClarity?.(wsId) ?? null, answersDue: drafter?.pipWorkstreamAnswersDue?.(wsId) ?? false, planDue: drafter?.pipWorkstreamPlanDue?.(wsId) ?? false } : null;
  const script = scriptPip(req.prompt, req.context, req.images, drafter?.pipRuns?.() ?? [], Date.now(), drafter?.pipDrafts?.() ?? [], discussing.get(session) ?? null, workstream);
  if (script.discussed) discussing.set(session, script.discussed);
  emit(req.requestId, { type: "started", sessionId: session });
  let said = "";
  try {
    // Held by a test: wait, still answering, until let go or stopped.
    while (gate && !stopped) await Promise.race([gate.promise, pause(pace)]);
    for (const label of script.steps) {
      await pause(pace * 6);
      if (stopped) break;
      mockPipTurns.step(req.requestId, label);
      emit(req.requestId, { type: "tool", label });
    }
    // A refused draft is Pip's to report, as the tool's refusal is in a real turn, not a turn that failed. Pip puts the
    // draft cap, which is addressed to it, in the person's words.
    const refusal = (e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      return wsId && why === capRefusal(wsId) ? `this workstream already has ${WORKSTREAM_PENDING_CAP} drafts waiting for you. Decide some and I'll draft more` : why;
    };
    if (!stopped && script.draft) {
      const refused = await drafter?.pipDraft?.(script.draft.intent, script.draft.label, req.requestId).then(() => null, refusal);
      if (refused) script.text = `I couldn't draft that: ${refused}`;
    }
    if (!stopped && script.revise) {
      const { id, body, title, description, summaries, comments } = script.revise;
      const revising = drafter?.pipRevise?.(id, { body, title, description, summaries, ...(comments ? { comments } : {}) }, req.requestId);
      // A review's refusal is Pip's to report, as revise_proposal's is; the other kinds keep failing the turn as before.
      if (comments) {
        const refused = await revising?.then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
        if (refused) script.text = reviewRefusal(refused);
      } else await revising;
    }
    if (!stopped && script.rewrite) {
      const refused = await drafter?.pipRewrite?.(script.rewrite.item, script.rewrite.part, req.requestId).then(() => null, refusal);
      if (refused) script.text = `I couldn't draft that: ${refused}`;
    }
    if (!stopped && script.followUp) await drafter?.pipFollowUp?.(script.followUp.runId, script.followUp.message, script.followUp.reason, req.requestId);
    for (const answer of script.answers ?? []) {
      if (stopped) break;
      const refused = await drafter?.pipAnswer?.(answer.runId, answer.message, req.requestId).then(() => null, refusal);
      if (refused) script.text = `${script.text}\n\nI couldn't draft a reply for that run: ${refused}`;
    }
    if (!stopped && script.runDraft) {
      const { item, kind, fromRun, focus } = script.runDraft;
      const refused = await drafter?.pipRunDraft?.(item, kind, fromRun, focus, req.requestId).then(() => null, refusal);
      if (refused) script.text = `I couldn't draft that: ${refused}`;
    }
    if (!stopped && script.ticketlessRun) await drafter?.pipTicketlessRunDraft?.(script.ticketlessRun.repo, script.ticketlessRun.prompt, req.requestId);
    if (!stopped && script.filter) viewListeners.forEach((l) => l(req.requestId, script.filter!.filter, script.filter!.note));
    for (const word of script.text.match(/\S+\s*/g) ?? []) {
      if (stopped) break;
      await pause(pace);
      said += word;
      mockPipTurns.text(req.requestId, word);
      emit(req.requestId, { type: "text", text: word });
    }
    const usage = mockUsage(req.prompt, said);
    mockPipTurns.finish(req.requestId, { ok: !stopped, error: stopped ? "Stopped" : null, sessionId: session, usage });
    emit(req.requestId, { type: "done", sessionId: session, ok: !stopped, message: stopped ? "Stopped" : null, usage });
    return session;
  } catch (err) {
    mockPipTurns.finish(req.requestId, { ok: false, error: String(err), sessionId: session, usage: null });
    throw err;
  } finally {
    running.delete(req.requestId);
  }
}

export const mockCancel = (requestId: string) => running.get(requestId)?.();
