import { create } from "zustand";
import { claude, type ClaudeEvent } from "./backend/claude";
import type { Backend } from "./backend/types";
import type { Proposal, ScreenContext } from "./types";

export interface Turn {
  requestId: string;
  prompt: string;
  steps: string[];
  text: string;
  status: "running" | "done" | "failed";
  error: string | null;
}

export interface Conversation {
  turns: Turn[];
  /** Set once the assistant reports a session, so follow-up questions continue it. */
  sessionId: string | null;
  cwd: string | null;
}

interface ClaudeState {
  open: boolean;
  byTicket: Record<string, Conversation>;
  /** Every draft the backend holds. The chat cards read from here, so drafts outlive the conversation that made them. */
  proposals: Proposal[];
  setOpen(open: boolean): void;
  ask(ticketKey: string, prompt: string, sessionId: string | null, cwd: string | null, context?: ScreenContext): Promise<void>;
  cancel(ticketKey: string): void;
  /** Puts a draft the backend just returned in place, ahead of the `proposals-changed` refresh. */
  putProposal(p: Proposal): void;
}

/** The screen as far as the page knows it today: the open ticket. */
export const ticketContext = (key: string): ScreenContext => ({
  view: null,
  item: { connectionId: "", externalId: key, key },
  filter: null,
  selection: [],
});

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

export const useClaude = create<ClaudeState>()((set, get) => ({
  open: false,
  byTicket: {},
  proposals: [],

  setOpen: (open) => set({ open }),

  async ask(ticketKey, prompt, sessionId, cwd, context = ticketContext(ticketKey)) {
    const requestId = newRequestId();
    const conv = get().byTicket[ticketKey] ?? empty;
    const turn: Turn = { requestId, prompt, steps: [], text: "", status: "running", error: null };
    set({ byTicket: { ...get().byTicket, [ticketKey]: { ...conv, cwd, turns: [...conv.turns, turn] } } });
    try {
      await claude.ask({ requestId, prompt, sessionId, cwd, context });
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

  putProposal(p) {
    const all = get().proposals;
    set({ proposals: all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [p, ...all] });
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
}

let stopWatching: (() => void) | null = null;

/** Loads the backend's drafts now and again whenever they change, replacing any earlier watch. */
export function watchProposals(backend: Backend) {
  stopWatching?.();
  let live = true;
  let latest = 0;
  const refresh = () => {
    const mine = ++latest;
    backend
      .proposalsList()
      .then((proposals) => live && mine === latest && useClaude.setState({ proposals }))
      .catch(() => {});
  };
  const off = backend.onProposalsChanged(refresh);
  stopWatching = () => {
    live = false;
    off();
  };
  refresh();
}
