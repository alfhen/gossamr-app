import { create } from "zustand";
import { claude, type ClaudeEvent, type Proposal } from "./backend/claude";

export type ProposalState = "pending" | "applying" | "applied" | "skipped";

export interface ProposalCard {
  proposal: Proposal;
  state: ProposalState;
  error: string | null;
  /** For subtasks: the key created for each summary so far, by index, so a retry never creates one twice. */
  created?: Record<number, string>;
}

export interface Turn {
  requestId: string;
  prompt: string;
  steps: string[];
  text: string;
  proposals: ProposalCard[];
  status: "running" | "done" | "failed";
  error: string | null;
}

export interface Conversation {
  turns: Turn[];
  /** Set once Claude reports a session, so follow-up questions continue it. */
  sessionId: string | null;
  cwd: string | null;
}

interface ClaudeState {
  open: boolean;
  byTicket: Record<string, Conversation>;
  setOpen(open: boolean): void;
  ask(ticketKey: string, prompt: string, sessionId: string | null, cwd: string | null): Promise<void>;
  cancel(ticketKey: string): void;
  setProposal(ticketKey: string, requestId: string, id: string, patch: Partial<ProposalCard>): void;
}

const empty: Conversation = { turns: [], sessionId: null, cwd: null };

let seq = 0;
const newRequestId = () => `${Date.now().toString(36)}-${++seq}`;

/** Applies one streamed event to the turn it belongs to. */
export function applyEvent(conv: Conversation, requestId: string, e: ClaudeEvent): Conversation {
  const turns = conv.turns.map((t) => {
    if (t.requestId !== requestId) return t;
    switch (e.type) {
      case "text":
        return { ...t, text: t.text + e.text };
      case "tool":
        return { ...t, steps: [...t.steps, e.label] };
      case "done":
        return { ...t, status: e.ok ? ("done" as const) : ("failed" as const), error: e.ok ? null : e.message };
      default:
        return t;
    }
  });
  const sessionId = (e.type === "started" || e.type === "done") && e.sessionId ? e.sessionId : conv.sessionId;
  return { ...conv, turns, sessionId };
}

export function applyProposal(conv: Conversation, p: Proposal): Conversation {
  return {
    ...conv,
    turns: conv.turns.map((t) =>
      t.requestId === p.requestId ? { ...t, proposals: [...t.proposals, { proposal: p, state: "pending", error: null }] } : t,
    ),
  };
}

export const useClaude = create<ClaudeState>()((set, get) => ({
  open: false,
  byTicket: {},

  setOpen: (open) => set({ open }),

  async ask(ticketKey, prompt, sessionId, cwd) {
    const requestId = newRequestId();
    const conv = get().byTicket[ticketKey] ?? empty;
    const turn: Turn = { requestId, prompt, steps: [], text: "", proposals: [], status: "running", error: null };
    set({ byTicket: { ...get().byTicket, [ticketKey]: { ...conv, cwd, turns: [...conv.turns, turn] } } });
    try {
      await claude.ask({ requestId, ticketKey, prompt, sessionId, cwd });
    } catch (err) {
      updateByRequest(requestId, (c) => applyEvent(c, requestId, { type: "done", sessionId: null, ok: false, message: String(err) }));
    }
  },

  cancel(ticketKey) {
    const running = get().byTicket[ticketKey]?.turns.find((t) => t.status === "running");
    if (!running) return;
    const id = running.requestId;
    claude
      .cancel(id)
      .catch((err) => updateByRequest(id, (c) => applyEvent(c, id, { type: "done", sessionId: null, ok: false, message: String(err) })));
  },

  setProposal(ticketKey, requestId, id, patch) {
    const conv = get().byTicket[ticketKey];
    if (!conv) return;
    const turns = conv.turns.map((t) =>
      t.requestId !== requestId
        ? t
        : { ...t, proposals: t.proposals.map((p) => (p.proposal.id === id ? { ...p, ...patch } : p)) },
    );
    set({ byTicket: { ...get().byTicket, [ticketKey]: { ...conv, turns } } });
  },
}));

function updateByRequest(requestId: string, fn: (c: Conversation) => Conversation) {
  const { byTicket } = useClaude.getState();
  const key = Object.keys(byTicket).find((k) => byTicket[k].turns.some((t) => t.requestId === requestId));
  if (key) useClaude.setState({ byTicket: { ...byTicket, [key]: fn(byTicket[key]) } });
}

let listening = false;

/** Starts routing Claude events into the store. Safe to call more than once. */
export function listenToClaude() {
  if (listening) return;
  listening = true;
  claude.onEvent((requestId, e) => updateByRequest(requestId, (c) => applyEvent(c, requestId, e)));
  claude.onProposal((p) => updateByRequest(p.requestId, (c) => applyProposal(c, p)));
}
