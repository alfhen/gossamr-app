import { and } from "../lib/filter";
import { REVIEW_IS_THE_USERS, WORKSTREAM_PENDING_CAP, capRefusal, isRunDraft, leftByRun, targetOf } from "../lib/proposals";
import { docFromText, docText } from "../lib/docs";
import type { Intent, ItemRef, Proposal, ReviewComment, Run, RunKind, ScreenContext, WorkFilter } from "../types";
import { APPROVE_PLAN, liveCounts, liveWords, needsPerson, planOpenQuestions, resultHeadline, runTitle, stateView } from "../workspace/agentsLogic";
import type { ImageData } from "../lib/pipImages";
import { jiraNote, subtaskProposals } from "./mockRunResult";
import type { AskRequest, ClaudeEvent, EventMeta } from "./claude";
import { mockPipTurns, mockUsage } from "./mockPipTurns";
import { GENERAL_CONVERSATION, workstreamOfConversation } from "../lib/conversations";
import { labelsByRun } from "../lib/workstreamStage";
import { draftPhrase, runPhrase } from "../lib/runNames";
import { statusId } from "./mockConnector";
import type { LastDrift } from "./mockWorkstreams";

/** What the scripted Pip does for one question. */
export interface PipScript {
  steps: string[];
  text: string;
  filter: { filter: WorkFilter; note: string } | null;
  draft: { intent: Intent; label: string | null } | null;
  /**
   * An agent to start, as `start_agent` does: its role, the run it follows (a build or review needs one), a focus note or, with
   * no ticket, the question and the repository. `open` is a workstream to open first, as `open_workstream` does, when the
   * request came in General.
   */
  start?: { item: ItemRef | null; role: RunKind; fromRun: string | null; brief: string | null; repo: string | null; open?: { item: ItemRef | null; title: string } } | null;
  /** A message for an agent, as `message_agent` sends it. */
  message?: { runId: string; text: string } | null;
  /** An agent to stop, as `stop_agent` does. */
  stop?: { runId: string } | null;
  /** A question for the person, as `ask_person` asks it. */
  ask?: string | null;
  /** A change to the text of a comment, new-ticket or breakdown draft that came from a run; for a review draft its summary (`body`) and its complete new list of comments. */
  revise?: { id: string; body?: string; title?: string; description?: string; summaries?: string[]; comments?: ReviewComment[] } | null;
  /** A new description or title to draft for a ticket, shown to the person as a diff. */
  rewrite?: { item: ItemRef; part: "title" | "description" } | null;
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

/** The next step a person asks for in a workstream's conversation, and the kind of finished run it follows. */
const CHAIN_ASKS: { pattern: RegExp; kind: RunKind; from: RunKind }[] = [
  { pattern: /\btriage (?:it|this)\b|^\s*triage [a-z][a-z0-9]+-\d+\b/, kind: "triage", from: "investigate" },
  { pattern: /\bplan (?:it|this)\b|^\s*plan [a-z][a-z0-9]+-\d+\b/, kind: "plan", from: "investigate" },
  { pattern: /\bbuild (?:it|this)\b/, kind: "build", from: "plan" },
  { pattern: /\breview (?:it|this)\b/, kind: "review", from: "build" },
];

const CHAIN_WORDS: Record<RunKind, string> = { investigate: "an investigation", triage: "a triage", plan: "a plan", build: "a build", review: "a review", verify: "a check" };

/** The conversation's workstream, as the scripted Pip knows it: its id and its ticket. */
export interface PipWorkstream {
  id: string;
  item: ItemRef | null;
  /** The last time its ticket changed in Jira, while Pip hasn't been told of it in a wake since. */
  lastDrift?: LastDrift | null;
}

/**
 * The one line a wake adds after the workstream's ticket changed in Jira, e.g. "The ticket's description changed in Jira; I'll
 * work from it as it reads now." Null when it didn't.
 */
export function driftLine(drift: LastDrift | null | undefined): string | null {
  if (!drift) return null;
  const changed = (["summary", "description"] as const).filter((f) => drift.fields.includes(f));
  const done = drift.fields.includes("status");
  const what = changed.length ? `The ticket's ${changed.join(" and ")} changed${done ? " and it was moved to Done" : ""}` : done ? "The ticket was moved to Done" : "The ticket changed";
  return `${what} in Jira; I'll work from it as it reads now.`;
}

/** A key the person named ("plan CA-401"), upper case, when it isn't the workstream's own: then it isn't this workstream's next step. */
const otherKey = (q: string, item: ItemRef | null) => {
  const named = /\b([a-z][a-z0-9]+-\d+)\b/.exec(q)?.[1]?.toUpperCase();
  return named && item && named !== item.key.toUpperCase() ? named : null;
};

/**
 * What Pip does when asked for the next step in a workstream: it starts that kind and names as the run it follows the
 * workstream's newest finished run of the kind that comes before, else its newest of that kind at all, so the backend says
 * why it can't follow it yet; with none, no run, and the backend refuses. Whatever the agent carries from that run is
 * Gossamr's to fill in.
 */
function chainStep(prompt: string, context: ScreenContext, runs: readonly Run[], workstream: PipWorkstream): PipScript | null {
  const q = prompt.toLowerCase();
  const ask = CHAIN_ASKS.find((a) => a.pattern.test(q));
  if (!ask || otherKey(q, workstream.item)) return null;
  const item = workstream.item ?? context.item;
  if (!item) return { steps: [], text: "This workstream has no ticket, so there is nothing to run that on. Ask me to investigate a question instead.", filter: null, draft: null };
  const newest = (done: boolean) =>
    runs
      .filter((r) => r.spec.workstream === workstream.id && r.spec.kind === ask.from && (!done || r.state === "done"))
      .sort((a, b) => (b.endedAt ?? b.queuedAt).localeCompare(a.endedAt ?? a.queuedAt))[0];
  const source = newest(true) ?? (ask.kind === "build" || ask.kind === "review" ? newest(false) : undefined);
  const fromRun = source?.id ?? null;
  const following = source ? ` following ${runPhrase(source)}` : "";
  const carried = ask.kind === "build" ? " Gossamr filled in the plan from that run; I didn't write it." : ask.kind === "review" ? " Gossamr filled in the builder's account and pinned the pull request; I didn't write them." : "";
  return {
    steps: [`Looked up ${item.key}`, "Read the workstream's agents", "Started an agent"],
    text: `I started ${CHAIN_WORDS[ask.kind]} of **${item.key}**${following}.${carried}`,
    filter: null,
    draft: null,
    start: { item, role: ask.kind, fromRun, brief: null, repo: null },
  };
}

const asksMeFirst = /^\s*ask me\b[\s,:]*(.*?)\s*[.?!]?\s*$/i;
const asksToMessage = /^\s*(?:tell|message|send|ping)\s+(r\d+|the agent|it)\s*(?:to|that|:|,)?\s+(.+?)\s*$/i;
const asksToStop = /^\s*(?:please\s+)?stop\s+(r\d+|the agent|it)\s*[.!]?\s*$/i;

/** "Ask me which clone to use", "tell R1 to skip the tests" and "stop R1": Pip asks the person, or messages or stops an agent of this workstream. */
function directAgent(prompt: string, runs: readonly Run[], workstream: PipWorkstream): PipScript | null {
  const say = (text: string, steps: string[] = [], extra: Partial<PipScript> = {}): PipScript => ({ steps, text, filter: null, draft: null, ...extra });
  const asked = asksMeFirst.exec(prompt);
  if (asked) {
    const question = asked[1] ? `${asked[1].charAt(0).toUpperCase()}${asked[1].slice(1)}?` : "What should I do next?";
    return say(`I asked you: ${question} It is under Needs you until you answer here or dismiss it.`, ["Asked you"], { ask: question });
  }
  const message = asksToMessage.exec(prompt);
  const stop = asksToStop.exec(prompt);
  const who = message?.[1] ?? stop?.[1];
  if (!who) return null;
  const own = runs.filter((r) => r.spec.workstream === workstream.id);
  const labels = labelsByRun(runs);
  const run = /^r\d+$/i.test(who) ? own.find((r) => labels.get(r.id) === who.toUpperCase()) : own.filter((r) => !["failed", "stopped"].includes(r.state))[0];
  if (!run) return say(`There is no ${/^r\d+$/i.test(who) ? who.toUpperCase() : "agent"} in this workstream to ${stop ? "stop" : "message"}.`);
  const name = labels.get(run.id) ?? "the agent";
  if (stop) return say(`I stopped ${name}.`, ["Stopped an agent"], { stop: { runId: run.id } });
  return say(`I sent ${name} your message.`, ["Messaged an agent"], { message: { runId: run.id, text: message![2] } });
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

/** Whether the screen line is the Agents view's, "Agents" and then what it shows (`screenLine` in src/workspace/screenContext.ts). */
const onAgents = (view: string | null | undefined) => view === "Agents" || !!view?.startsWith("Agents · ");

const asksToApprovePlan = /^\s*approve the plan\b/i;
const asksWhileAway = /\bwhile i was away\b/i;
const asksWhatRunDoes = /^\s*what is (r\d+) doing\b/i;
/**
 * What Pip says to the workstream questions its chips ask: where the plan is approved (Pip approves nothing), what its
 * agents did, and what one of them is doing. Null for anything else.
 */
function workstreamAnswer(prompt: string, runs: readonly Run[], workstream: PipWorkstream, now: number): PipScript | null {
  const key = workstream.item?.key ?? "the ticket";
  const own = runs.filter((r) => r.spec.workstream === workstream.id);
  const say = (text: string, steps: string[] = []): PipScript => ({ steps, text, filter: null, draft: null });
  if (asksToApprovePlan.test(prompt))
    return say(`I can't approve anything myself. The plan's update to the description of **${key}** waits in the Plan step on the right, and in ${key}'s peek: read the change there and press Update description. The build starts only after that.`, ["Read the workstream's drafts"]);
  if (asksWhileAway.test(prompt)) return say(agentSummary(own, now), ["Read the workstream's runs"]);
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

/**
 * What Pip says when the supervisor wakes it: one short line for each event, at most three, from the event lines
 * alone. Nothing Pip says starts anything. An agent asking a question is put to the person with `ask_person`; Pip never
 * answers for them.
 */
function wakeScript(prompt: string, runs: readonly Run[], workstream: PipWorkstream | null = null): PipScript {
  let ask: string | null = null;
  const labels = labelsByRun(runs);
  // A run by its workstream label (R1), else by ticket and step; never by its id.
  const name = (id: string | undefined) => (id ? (labels.get(id) ?? capital(runPhrase(runs.find((r) => r.id === id)))) : "A run");
  const lines = prompt
    .split("\n")
    .map((l) => EVENT_LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 3)
    .map(([, id, kind, state, rest]) => {
      const who = id && !labels.has(id) ? name(id) : `${KIND_WORD[kind as RunKind] ?? "The run"} ${name(id)}`;
      if (rest.includes("; waiting for its pull request")) return `${who} finished. Its pull request isn't up yet; I'll draft the review when it is.`;
      if (state.trim() === "Pull request found") return `${who}'s pull request is up. I can draft its review now.`;
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
        ask ??= `${name(id)} asks${asking.needs ? `: “${asking.needs.trim()}”` : " a question."} What should I tell it?`;
        return `${name(id)} asks${asking.needs ? `: “${asking.needs.trim()}”` : " a question."} I asked you what to tell it.`;
      }
      if (/^Needs|^Blocked/.test(state.trim())) return `${who} ${state.trim().toLowerCase()}. Open it to see what it asks.`;
      return `${who} ${state.trim().toLowerCase()}. Nothing starts after it; tell me what you want to do.`;
    });
  const drift = driftLine(workstream?.lastDrift);
  const said = lines.join("\n\n") || "Something changed in this workstream; nothing needs you yet.";
  return { steps: ask ? ["Read the agent", "Asked you"] : [], text: drift ? `${drift}\n\n${said}` : said, filter: null, draft: null, ask };
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

/** Where a description's plan starts in its Markdown: the line that opens its `Gossamr Plan` expand, or the old `Gossamr Plan` heading. */
const PLAN_START = /^(?:#{1,6} Gossamr Plan|<details>\n<summary>Gossamr Plan<\/summary>)$/m;

/** A sample tightening of a description with a plan section: everything before it stays, and each line after the heading keeps its first sentence. */
function shorterPlan(markdown: string): string {
  const at = markdown.search(PLAN_START);
  if (at < 0) return markdown;
  const first = (line: string) => /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  const plan = markdown
    .slice(at)
    .split("\n")
    .map((l) => (/^#|^\s*$|^<\/?(?:details|summary)/.test(l) ? l : first(l)));
  return `${markdown.slice(0, at)}${plan.join("\n")}`;
}

function revisedBody(text: string, shorter: boolean): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const note = lines.length > 1 ? lines.slice(1) : lines;
  return shorter ? (note[0] ?? text) : `Short version: ${(note[0] ?? text).replace(/\.$/, "")}. The rest is in the run.`;
}

/** What the agents are doing, one line each, from the runs the person has. */
export function agentSummary(runs: readonly Run[], now: number): string {
  if (!runs.length) return "You have no agent runs. Ask me to start one.";
  const waiting = runs.filter(needsPerson);
  const going = runs.filter((r) => r.state === "working" || r.state === "launching" || r.state === "queued");
  const done = runs.filter((r) => r.state === "done");
  const live = liveCounts(runs, now);
  const line = (r: Run) => `- **${r.item?.key ?? r.spec.repo}** ${stateView(r, now).label.toLowerCase()}${r.lastDetail ? `: ${r.lastDetail}` : r.needs ? `: ${r.needs}` : ""}`;
  const part = (title: string, list: readonly Run[]) => (list.length ? `${title}\n${list.slice(0, 5).map(line).join("\n")}` : "");
  return [
    // Counted as the Agents view's summary and Pip's footer count them, quiet runs apart.
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

/** The ways Pip words a check-in comment, one for each that already waits on the ticket. */
const NUDGES = ["Checking in on this one. Is it still on track, or does anything need to move?", "Following up here. Has anything changed since the last update?", "One more look at this. Is anything holding it up that we could clear?"];

/** The check-in wording for the next draft on `item`: the first the ticket's waiting drafts don't use yet, so two never say the same. */
function nudgeText(drafts: readonly Proposal[], item: ItemRef): string {
  const waiting = new Set(drafts.filter((d) => d.state.type === "pending" && d.intent.type === "comment" && d.intent.item.connectionId === item.connectionId && d.intent.item.externalId === item.externalId).map((d) => (d.intent.type === "comment" ? docText(d.intent.body) : "")));
  return NUDGES.find((n) => !waiting.has(n)) ?? NUDGES[0];
}

/** The scripted assistant the browser build talks to; it decides from keywords and the screen context alone. */
export function scriptPip(prompt: string, context: ScreenContext, images: ImageData[] = [], runs: readonly Run[] = [], now = Date.now(), drafts: readonly Proposal[] = [], discussed: string | null = null, workstream: PipWorkstream | null = null): PipScript {
  if (prompt.startsWith(EVENT)) return wakeScript(prompt, runs, workstream);
  const q = prompt.toLowerCase();
  const move = moveScript(prompt, context, workstream);
  if (move) return move;
  const answer = workstream ? workstreamAnswer(prompt, runs, workstream, now) : null;
  if (answer) return answer;
  const step = workstream ? chainStep(prompt, context, runs, workstream) : null;
  if (step) return step;
  const direct = workstream ? directAgent(prompt, runs, workstream) : null;
  if (direct) return direct;
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
      text: `I read the whole run and the ticket and checked ${draftPhrase(left, runs)}: the ticket's description with the run's plan added in a collapsed "Gossamr Plan" section. A build follows that plan, so only you change it. Tell me what you'd change, for example "shorter", and I'll suggest the words for you to put in. Nothing is written to Jira until you approve it.`,
      filter: null,
      draft: null,
      discussed: left.id,
    };
  }
  const discussedDescription = description(discussed);
  if (discussedDescription?.intent.type === "rewrite" && discussedDescription.intent.body && asksForShorter.test(q)) {
    // The plan a build follows is the person's to change, so Pip only suggests the words.
    const plan = shorterPlan(discussedDescription.intent.body.toText);
    const section = plan.slice(Math.max(0, plan.search(PLAN_START)));
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
    const named: ItemRef | null = key
      ? context.item?.key === key
        ? context.item
        : { connectionId: context.item?.connectionId ?? context.selection[0]?.connectionId ?? "mock", externalId: key, key }
      : null;
    const item = named ?? workstream?.item ?? (workstream ? null : context.item);
    if (item) {
      const focus = /(?:focus on|look at|check)\s+(.+)$/i.exec(prompt.trim())?.[1]?.trim().slice(0, 300) ?? null;
      const open = !workstream || workstream.item?.key !== item.key ? { item, title: item.key } : undefined;
      return {
        steps: [`Looked up ${item.key}`, ...(open ? [`Opened a workstream on ${item.key}`] : []), "Started an agent"],
        text: `I started an investigation of **${item.key}**${focus ? ` with a focus note: “${focus}”` : ""}.${open ? " I opened a workstream for it." : ""} It shows under Agents, and I'll tell you when it finishes.`,
        filter: null,
        draft: null,
        start: { item, role: "investigate", fromRun: null, brief: focus, repo: null, ...(open ? { open } : {}) },
      };
    }
    const ask = ticketlessQuestion(prompt);
    if (ask?.repo) {
      return {
        steps: ["Started an agent"],
        text: `No ticket covers this, so I started an investigation in **${ask.repo}** with no ticket: “${ask.prompt}” When it finishes I'll draft a ticket from what it found, and you approve that.`,
        filter: null,
        draft: null,
        start: { item: null, role: "investigate", fromRun: null, brief: ask.prompt, repo: ask.repo, ...(workstream ? {} : { open: { item: null, title: ask.prompt.slice(0, 80) } }) },
      };
    }
    if (ask) return { steps: [], text: "Which repository should it look in? Name it, for example acme/storefront.", filter: null, draft: null };
  }
  const wanted = FILTERS.find((f) => f.pattern.test(q));
  if (wanted && (asksToShow.test(q) || !context.item)) {
    const filter = context.filter ? and(context.filter, wanted.filter) : wanted.filter;
    return {
      steps: ["Searched the items"],
      // On Agents no board is on screen: the filter lands on the workspace tab, there when the person goes back.
      text: `${wanted.note}. ${onAgents(context.view) ? "I filtered your workspace tab for you; it is there when you go back to it. Undo it below if that wasn't what you meant." : "I filtered this view for you; undo it below if that wasn't what you meant."}`,
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
  /** The ticket of workstream `id`, for a turn asked in its conversation. */
  pipWorkstreamItem(id: string): ItemRef | null;
  /** The last time workstream `id`'s ticket changed in Jira, while no wake told Pip of it since; a wake's script reads it. */
  pipWorkstreamDrift?(id: string): LastDrift | null;
  /** Opens a workstream on `item` (none for a question with no ticket) the way `open_workstream` does, and returns its id. */
  pipOpenWorkstream(item: ItemRef | null, title: string): string;
  /** Starts an agent in workstream `workstream` the way `start_agent` does. */
  pipStartAgent(workstream: string, role: RunKind, brief: string | null, repo: string | null, fromRun: string | null, requestId: string): unknown;
  /** Messages an agent the way `message_agent` does. */
  pipMessageAgent(runId: string, text: string): unknown;
  /** Stops an agent the way `stop_agent` does. */
  pipStopAgent(runId: string): unknown;
  /** The person wrote in workstream `workstream`'s conversation, which answers the question Pip had open there. */
  pipAskAnswered(workstream: string): unknown;
  /** Asks the person a question in workstream `workstream` the way `ask_person` does. */
  pipAskPerson(workstream: string, question: string): unknown;
  /** Whether a draft from the question `requestId` is kept already. */
  pipDrafted(requestId: string): boolean;
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
  mockPipTurns.begin(req.conversation ?? GENERAL_CONVERSATION, req.requestId, req.prompt, req.meta ?? { imageCount: req.images?.length ?? 0 }, "running", new Date(), undefined, req.kind ?? "user");
  const item = wsId ? (drafter?.pipWorkstreamItem?.(wsId) ?? null) : null;
  const workstream = wsId ? { id: wsId, item, lastDrift: drafter?.pipWorkstreamDrift?.(wsId) ?? null } : null;
  if (wsId && req.kind !== "wake") await drafter?.pipAskAnswered?.(wsId);
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
    // A refused call is Pip's to report, as the tool's refusal is in a real turn.
    const tried = async (call: () => unknown) => {
      try {
        await call();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    if (!stopped && script.start && drafter?.pipStartAgent) {
      const { role, fromRun, brief, repo, open } = script.start;
      let workstream = wsId;
      const refused = await tried(() => {
        if (open) workstream = drafter.pipOpenWorkstream!(open.item, open.title);
        if (!workstream) throw new Error("this conversation has no workstream");
        return drafter.pipStartAgent!(workstream, role, brief, repo, fromRun, req.requestId);
      });
      if (refused) script.text = `I couldn't start it: ${refused}`;
    }
    if (!stopped && script.message) {
      const refused = await tried(() => drafter?.pipMessageAgent?.(script.message!.runId, script.message!.text));
      if (refused) script.text = `I couldn't message it: ${refused}`;
    }
    if (!stopped && script.stop) {
      const refused = await tried(() => drafter?.pipStopAgent?.(script.stop!.runId));
      if (refused) script.text = `I couldn't stop it: ${refused}`;
    }
    if (!stopped && script.ask && wsId) await drafter?.pipAskPerson?.(wsId, script.ask);
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
