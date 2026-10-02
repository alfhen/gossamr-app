import { and } from "../lib/filter";
import { docFromText, docText } from "../lib/docs";
import type { Intent, ItemRef, Proposal, Run, ScreenContext, WorkFilter } from "../types";
import { needsPerson, resultHeadline, runTitle, stateView } from "../workspace/agentsLogic";
import type { ImageData } from "../lib/pipImages";
import { jiraNote, subtaskProposals } from "./mockRunResult";
import type { AskRequest, ClaudeEvent } from "./claude";

/** What the scripted Pip does for one question. */
export interface PipScript {
  steps: string[];
  text: string;
  filter: { filter: WorkFilter; note: string } | null;
  draft: { intent: Intent; label: string | null } | null;
  /** An agent run to propose on a ticket, with an optional focus note. */
  runDraft?: { item: ItemRef; focus: string | null } | null;
  /** A change to the text of a comment, new-ticket or breakdown draft that came from a run. */
  revise?: { id: string; body?: string; title?: string; summaries?: string[] } | null;
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
const discusses = /comment draft (\S+) on \S+, drafted from agent run (\S+?)\./i;
const asksToRevise = /\b(shorten|shorter|tighten|trim|rewrite|reword|rephrase|revise)\b/;
const asksForShorter = /\b(shorten|shorter|tighten|trim)\b/;

/** The comment a run left for the person, newest first, that Pip may revise. */
const runDrafts = (drafts: readonly Proposal[]) => drafts.filter((d) => d.state.type === "pending" && d.origin.type === "run" && d.intent.type === "comment");

/** A sample tightening of a ticket: the title loses a trailing possessive, and each paragraph keeps its first sentence. */
function tightenedTicket(title: string, body: string): { title: string; body: string } {
  const first = (paragraph: string) => /^.*?[.!?](?=\s|$)/s.exec(paragraph.trim())?.[0] ?? paragraph.trim();
  return { title: title.replace(/'s\s+\w+$/, ""), body: body.split(/\n{2,}|\n/).filter((p) => p.trim()).map(first).join("\n\n") };
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
  const line = (r: Run) => `- **${r.item?.key ?? r.spec.repo}** ${stateView(r, now).label.toLowerCase()}${r.lastDetail ? `: ${r.lastDetail}` : r.needs ? `: ${r.needs}` : ""}`;
  const part = (title: string, list: readonly Run[]) => (list.length ? `${title}\n${list.slice(0, 5).map(line).join("\n")}` : "");
  return [
    `You have ${runs.length} agent ${runs.length === 1 ? "run" : "runs"}: ${waiting.length} waiting on you, ${going.length} working, ${done.length} ready to review.`,
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

/** The scripted assistant the browser build talks to; it decides from keywords and the screen context alone. */
export function scriptPip(prompt: string, context: ScreenContext, images: ImageData[] = [], runs: readonly Run[] = [], now = Date.now(), drafts: readonly Proposal[] = [], discussed: string | null = null): PipScript {
  const q = prompt.toLowerCase();
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
    drafts.find((d) => d.id === id && d.state.type === "pending" && d.intent.type === "subtasks" && (d.createdBy === "pip" || (d.origin.type === "run" && d.createdBy === "user")));
  if (breakdownTalk) {
    const left = breakdown(breakdownTalk[1]);
    if (!left) return { steps: [], text: "I can't find that breakdown draft any more, or it has been decided already, so there is nothing to discuss.", filter: null, draft: null };
    return {
      steps: ["Read the run", "Read the rest of its result", "Looked at the breakdown"],
      text: `I read the whole run and checked it against draft ${left.id}. Tell me what to change, for example "fewer" or "shorter", and I'll revise the summaries. Nothing is created in Jira until you approve it.`,
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
  const talked = discusses.exec(prompt);
  if (talked) {
    return {
      steps: ["Read the run", "Read the rest of its result", "Looked at the draft"],
      text: `I read the whole run, not only the start of its result, and checked it against draft ${talked[1]}. The draft says what the run found. Tell me what to change, for example "shorter", and I'll revise it. It stays a draft until you approve it.`,
      filter: null,
      draft: null,
      discussed: talked[1],
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
        runDraft: { item, focus },
      };
    }
  }
  const wanted = FILTERS.find((f) => f.pattern.test(q));
  if (wanted && (asksToShow.test(q) || !context.item)) {
    const filter = context.filter ? and(context.filter, wanted.filter) : wanted.filter;
    return {
      steps: ["Searched the items"],
      text: `${wanted.note}. I filtered this view for you; undo it below if that wasn't what you meant.`,
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
        intent: { type: "comment", item, body: docFromText("Checking in on this one. Is it still on track, or does anything need to move?") },
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

type Listener = (requestId: string, e: ClaudeEvent) => void;
type ViewListener = (requestId: string, filter: WorkFilter, note: string) => void;

/** The parts of a backend the scripted Pip writes to; only the sample backend has them. */
export interface PipDrafter {
  pipDraft(intent: Intent, label: string | null, requestId: string): Promise<unknown>;
  /** The runs Pip can read. */
  pipRuns(): Run[];
  /** The drafts Pip can see. */
  pipDrafts(): Proposal[];
  /** Revises a comment or new-ticket draft that came from a run, the way `revise_proposal` does. */
  pipRevise(id: string, change: string | { body?: string; title?: string; summaries?: string[] }): Promise<unknown>;
  /** Drafts a run the way propose_run does: Pip names the ticket and a focus note, the backend builds the rest. */
  pipRunDraft(item: ItemRef, focus: string | null, requestId: string): Promise<unknown>;
}

const listeners = new Set<Listener>();
const viewListeners = new Set<ViewListener>();
const running = new Map<string, () => void>();
/** The draft each conversation last discussed, so "shorter" changes that one and no other. */
const discussing = new Map<string, string>();

export const mockPipEvents = {
  on(cb: Listener) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
  onView(cb: ViewListener) {
    viewListeners.add(cb);
    return () => void viewListeners.delete(cb);
  },
};

const emit = (id: string, e: ClaudeEvent) => listeners.forEach((l) => l(id, e));
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Streams the scripted answer for `req`. `drafter` receives the draft the script proposes. */
export async function mockAsk(req: AskRequest, drafter: Partial<PipDrafter> | null, pace = 25): Promise<void> {
  let stopped = false;
  running.set(req.requestId, () => (stopped = true));
  const session = req.sessionId ?? `mock-session-${req.requestId}`;
  const script = scriptPip(req.prompt, req.context, req.images, drafter?.pipRuns?.() ?? [], Date.now(), drafter?.pipDrafts?.() ?? [], discussing.get(session) ?? null);
  if (script.discussed) discussing.set(session, script.discussed);
  emit(req.requestId, { type: "started", sessionId: session });
  try {
    for (const label of script.steps) {
      await pause(pace * 6);
      if (stopped) break;
      emit(req.requestId, { type: "tool", label });
    }
    if (!stopped && script.draft) await drafter?.pipDraft?.(script.draft.intent, script.draft.label, req.requestId);
    if (!stopped && script.revise) await drafter?.pipRevise?.(script.revise.id, { body: script.revise.body, title: script.revise.title, summaries: script.revise.summaries });
    if (!stopped && script.runDraft) await drafter?.pipRunDraft?.(script.runDraft.item, script.runDraft.focus, req.requestId);
    if (!stopped && script.filter) viewListeners.forEach((l) => l(req.requestId, script.filter!.filter, script.filter!.note));
    for (const word of script.text.match(/\S+\s*/g) ?? []) {
      if (stopped) break;
      await pause(pace);
      emit(req.requestId, { type: "text", text: word });
    }
    emit(req.requestId, { type: "done", sessionId: session, ok: !stopped, message: stopped ? "Stopped" : null });
  } finally {
    running.delete(req.requestId);
  }
}

export const mockCancel = (requestId: string) => running.get(requestId)?.();
