import { and } from "../lib/filter";
import { docFromText } from "../lib/docs";
import type { Intent, ItemRef, Run, ScreenContext, WorkFilter } from "../types";
import { needsPerson, stateView } from "../workspace/agentsLogic";
import type { ImageData } from "../lib/pipImages";
import { jiraNote } from "./mockRunResult";
import type { AskRequest, ClaudeEvent } from "./claude";

/** What the scripted Pip does for one question. */
export interface PipScript {
  steps: string[];
  text: string;
  filter: { filter: WorkFilter; note: string } | null;
  draft: { intent: Intent; label: string | null } | null;
  /** An agent run to propose on a ticket, with an optional focus note. */
  runDraft?: { item: ItemRef; focus: string | null } | null;
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

/** The scripted assistant the browser build talks to; it decides from keywords and the screen context alone. */
export function scriptPip(prompt: string, context: ScreenContext, images: ImageData[] = [], runs: readonly Run[] = [], now = Date.now()): PipScript {
  const q = prompt.toLowerCase();
  const asked = /draft a jira comment from run (\S+?):/.exec(q)?.[1];
  const forRun = asked ? runs.find((r) => r.id.toLowerCase() === asked) : undefined;
  if (forRun?.item) {
    const note = jiraNote(forRun.result ?? "").text;
    const item = forRun.item;
    return {
      steps: ["Read the run", `Drafted a comment on ${item.key}`],
      text: `I drafted a short comment on **${item.key}** from what the run found. It isn't posted; approve, edit or skip it below.`,
      filter: null,
      draft: { intent: { type: "comment", item, body: docFromText(`An agent looked into this (it only read code; nothing was changed).\n\n${note || "It finished without a written answer."}`) }, label: "From an agent run" },
    };
  }
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
  /** Drafts a run the way propose_run does: Pip names the ticket and a focus note, the backend builds the rest. */
  pipRunDraft(item: ItemRef, focus: string | null, requestId: string): Promise<unknown>;
}

const listeners = new Set<Listener>();
const viewListeners = new Set<ViewListener>();
const running = new Map<string, () => void>();

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
  const script = scriptPip(req.prompt, req.context, req.images, drafter?.pipRuns?.() ?? []);
  const session = req.sessionId ?? `mock-session-${req.requestId}`;
  emit(req.requestId, { type: "started", sessionId: session });
  try {
    for (const label of script.steps) {
      await pause(pace * 6);
      if (stopped) break;
      emit(req.requestId, { type: "tool", label });
    }
    if (!stopped && script.draft) await drafter?.pipDraft?.(script.draft.intent, script.draft.label, req.requestId);
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
