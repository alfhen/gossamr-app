import { create } from "zustand";
import { claude, type ClaudeEvent, type EventMeta, type StoredTurn, type TurnUsage } from "./backend/claude";
import type { Backend } from "./backend/types";
import type { PipImage, ShownImage } from "./lib/pipImages";
import type { Proposal, ScreenContext } from "./types";
import { useWorkstreams } from "./workspace/workstreamsStore";

export interface Turn {
  requestId: string;
  prompt: string;
  steps: string[];
  text: string;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  /** What the turn cost, once it is done and the assistant reported it. */
  usage?: TurnUsage;
  /** What Pip was looking at when asked, for "Looking at ..." while it works. */
  looking?: string;
  /** Text the question was about; the assistant is given it after the prompt. */
  quote?: string;
  /** Pictures sent with the question. Shown from memory; a follow-up in the same session does not attach them again. */
  images?: ShownImage[];
  /** How many pictures were sent, for a turn restored without them. */
  imageCount?: number;
  /** `wake` for a turn the supervisor started, whose prompt is its event lines; a question the person asked otherwise. */
  kind?: "user" | "wake";
}

export interface Conversation {
  turns: Turn[];
  /** Set once the assistant reports a session, so follow-up questions continue it. */
  sessionId: string | null;
}

interface ClaudeState {
  open: boolean;
  /** Conversations by id: `general` and `ws:<id>` for the Pip pane, a ticket key for the classic drawer. */
  byTicket: Record<string, Conversation>;
  /** Every draft the backend holds. The chat cards read from here, so drafts outlive the conversation that made them. */
  proposals: Proposal[];
  setOpen(open: boolean): void;
  ask(ticketKey: string, prompt: string, sessionId: string | null, context?: ScreenContext, extra?: { looking?: string; quote?: string; images?: PipImage[] }): Promise<void>;
  /** Stops the turn being answered in the conversation. Turns queued behind it stay queued. */
  cancel(ticketKey: string): void;
  /** Takes a queued turn out of the queue before it runs. */
  remove(requestId: string): void;
  /** Brings back the stored turns of a conversation, after a reload or a restart, without touching turns already shown. */
  load(ticketKey: string): Promise<void>;
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

/** The prompt as the assistant gets it: what was typed, then the text it is about. */
export const withQuote = (prompt: string, quote: string | undefined): string => (quote ? `${prompt}\n\nThe text I selected:\n${quote.replace(/^/gm, "> ")}` : prompt);

const empty: Conversation = { turns: [], sessionId: null };

let seq = 0;
/** Turns the backend has started, so an `ask` that returns after its turn left the queue can't mark it queued again. */
const begun = new Set<string>();
/** Bumped whenever the conversations are dropped, so a load that started before cannot bring them back. */
let generation = 0;
/** How many loads are waiting for the backend; while any is, events for turns the store lacks are held for it. */
let loading = 0;
/** Events that came for turns not in the store yet while a load ran, oldest first, so a turn it restores mid-answer misses none. */
const held = new Map<string, ClaudeEvent[]>();
/** Turns a load restored while they were still going. When one ends, its stored answer replaces the streamed one. */
const restoredLive = new Set<string>();
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
        return { ...t, status: e.ok ? ("done" as const) : ("failed" as const), error: e.ok ? null : e.message, ...(e.usage ? { usage: e.usage } : {}) };
      case "queued":
        return t.status === "running" ? { ...t, status: "queued" as const } : t;
      case "running":
        return t.status === "queued" ? { ...t, status: "running" as const } : t;
      default:
        return t;
    }
  });
  const sessionId = (e.type === "started" || e.type === "done") && e.sessionId ? e.sessionId : conv.sessionId;
  return { ...conv, turns, sessionId };
}

/** A stored turn as the conversation shows it. The question is shown as typed, without the quote `withQuote` added. */
export function turnFromStored(t: StoredTurn): Turn {
  const suffix = t.quote ? withQuote("", t.quote) : "";
  const prompt = suffix && t.prompt.endsWith(suffix) ? t.prompt.slice(0, -suffix.length) : t.prompt;
  return {
    requestId: t.requestId,
    prompt,
    steps: t.steps,
    text: t.text,
    status: t.status,
    error: t.error,
    ...(t.looking ? { looking: t.looking } : {}),
    ...(t.quote ? { quote: t.quote } : {}),
    ...(t.imageCount ? { imageCount: t.imageCount } : {}),
    ...(t.usage ? { usage: t.usage } : {}),
    ...(t.kind === "wake" ? { kind: "wake" as const } : {}),
  };
}

/** How many of `came`, from the first, `ends(n)` says the snapshot already ends with. The most that fit wins. */
function alreadyHas(came: number, ends: (n: number) => boolean): number {
  for (let n = came; n > 0; n--) if (ends(n)) return n;
  return 0;
}

/**
 * The turn `requestId`, restored from a snapshot, with the events that came while the snapshot was read. The first of
 * them may already be in it: text and steps the snapshot ends with are not added twice. What the turn ends with is
 * fetched again once it is done (see `settle`), so a guess that went wrong here doesn't last.
 */
export function catchUp(conv: Conversation, requestId: string, events: ClaudeEvent[]): Conversation {
  const turn = conv.turns.find((t) => t.requestId === requestId);
  if (!turn) return conv;
  const chunks = events.flatMap((e) => (e.type === "text" ? [e.text] : []));
  const labels = events.flatMap((e) => (e.type === "tool" ? [e.label] : []));
  const textSeen = alreadyHas(chunks.length, (n) => turn.text.endsWith(chunks.slice(0, n).join("")));
  const stepsSeen = alreadyHas(Math.min(labels.length, turn.steps.length), (n) => labels.slice(0, n).every((l, i) => l === turn.steps[turn.steps.length - n + i]));
  const caught = { ...turn, text: turn.text + chunks.slice(textSeen).join(""), steps: [...turn.steps, ...labels.slice(stepsSeen)] };
  const withStream = { ...conv, turns: conv.turns.map((t) => (t.requestId === requestId ? caught : t)) };
  return events.filter((e) => e.type !== "text" && e.type !== "tool").reduce((c, e) => applyEvent(c, requestId, e), withStream);
}

/** `conv` with the stored turns it lacks, in the order they were asked. A turn already in memory is never replaced. */
export function mergeStored(conv: Conversation, stored: StoredTurn[]): Conversation {
  const shown = new Set(conv.turns.map((t) => t.requestId));
  const restored = stored.filter((t) => !shown.has(t.requestId)).map(turnFromStored);
  if (!restored.length) return conv;
  const session = [...stored].reverse().find((t) => t.sessionId)?.sessionId ?? null;
  return { turns: [...restored, ...conv.turns], sessionId: conv.sessionId ?? session };
}

export const useClaude = create<ClaudeState>()((set, get) => ({
  open: false,
  byTicket: {},
  proposals: [],

  setOpen: (open) => set({ open }),

  async ask(ticketKey, prompt, sessionId, context = ticketContext(ticketKey), extra = {}) {
    const requestId = newRequestId();
    const conv = get().byTicket[ticketKey] ?? empty;
    const { images = [], ...shown } = extra;
    const turn: Turn = {
      requestId,
      prompt,
      steps: [],
      text: "",
      status: "running",
      error: null,
      ...shown,
      ...(images.length ? { images: images.map(({ id, url, width, height }) => ({ id, url, width, height })) } : {}),
    };
    set({ byTicket: { ...get().byTicket, [ticketKey]: { ...conv, turns: [...conv.turns, turn] } } });
    try {
      const outcome = await claude.ask({
        requestId,
        prompt: withQuote(prompt, extra.quote),
        sessionId,
        context,
        ...(images.length ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}),
        conversation: ticketKey,
        meta: { ...(shown.quote ? { quote: shown.quote } : {}), ...(shown.looking ? { looking: shown.looking } : {}), imageCount: images.length },
      });
      // The `queued` event usually says this first; the answer to `ask` can come after the turn already started.
      if (outcome?.queued && !begun.has(requestId)) updateByRequest(requestId, (c) => applyEvent(c, requestId, { type: "queued", ahead: outcome.ahead }));
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

  remove(requestId) {
    const queued = Object.values(get().byTicket).some((c) => c.turns.some((t) => t.requestId === requestId && t.status === "queued"));
    if (!queued) return;
    claude
      .cancel(requestId)
      .catch((err) => updateByRequest(requestId, (c) => applyEvent(c, requestId, { type: "done", sessionId: null, ok: false, message: String(err) })));
  },

  async load(ticketKey) {
    const mine = generation;
    loading++;
    try {
      const stored = await claude.turns(ticketKey).catch(() => [] as StoredTurn[]);
      // Another account's turns must not land in a store that was cleared while they loaded.
      if (!stored.length || mine !== generation) return;
      const before = get().byTicket[ticketKey] ?? empty;
      const shown = new Set(before.turns.map((t) => t.requestId));
      const restored = stored.filter((t) => !shown.has(t.requestId));
      // A turn still going when it was read goes on streaming: what it said while this load waited is added from `held`.
      let conv = mergeStored(before, stored);
      for (const t of restored) {
        const events = held.get(t.requestId) ?? [];
        held.delete(t.requestId);
        if (t.status !== "running" && t.status !== "queued") continue;
        restoredLive.add(t.requestId);
        conv = catchUp(conv, t.requestId, events);
      }
      set({ byTicket: { ...get().byTicket, [ticketKey]: conv } });
      for (const t of conv.turns) if (restoredLive.has(t.requestId) && (t.status === "done" || t.status === "failed")) settle(t.requestId);
    } finally {
      if (--loading === 0) held.clear();
    }
  },

  putProposal(p) {
    const all = get().proposals;
    set({ proposals: all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [p, ...all] });
  },
}));

/** Drops every conversation from memory, as switching account does. What is stored stays stored. */
export function forgetConversations() {
  generation++;
  held.clear();
  restoredLive.clear();
  for (const conversation of Object.values(useClaude.getState().byTicket)) {
    conversation.turns.forEach((t) => t.images?.forEach((i) => URL.revokeObjectURL(i.url)));
  }
  useClaude.setState({ open: false, byTicket: {}, proposals: [] });
  // Which workstreams there are, and so which conversations, belongs to the account as well.
  useWorkstreams.getState().dispose();
}

function updateByRequest(requestId: string, fn: (c: Conversation) => Conversation) {
  const { byTicket } = useClaude.getState();
  const key = Object.keys(byTicket).find((k) => byTicket[k].turns.some((t) => t.requestId === requestId));
  if (key) useClaude.setState({ byTicket: { ...byTicket, [key]: fn(byTicket[key]) } });
}

const conversationOf = (requestId: string) => {
  const { byTicket } = useClaude.getState();
  return Object.keys(byTicket).find((k) => byTicket[k].turns.some((t) => t.requestId === requestId));
};

/** Replaces a restored turn's answer with the stored one once it has ended, as the stream it showed may have a gap. */
function settle(requestId: string) {
  restoredLive.delete(requestId);
  const key = conversationOf(requestId);
  if (!key) return;
  const mine = generation;
  void claude
    .turns(key)
    .catch(() => [] as StoredTurn[])
    .then((stored) => {
      const end = stored.find((t) => t.requestId === requestId);
      if (!end || mine !== generation || (end.status !== "done" && end.status !== "failed")) return;
      const { text, steps, status, error, usage } = turnFromStored(end);
      const settled = (t: Turn): Turn => ({ ...t, text, steps, status, error, ...(usage ? { usage } : {}) });
      updateByRequest(requestId, (c) => ({ ...c, turns: c.turns.map((t) => (t.requestId === requestId ? settled(t) : t)) }));
    });
}

/**
 * A wake turn the page hears of for the first time, in its conversation: a turn of its own with the event lines as its
 * prompt, when the event says them; otherwise they are read from the stored turn.
 */
function registerWake(requestId: string, e: ClaudeEvent, conversation: string, prompt: string | undefined) {
  const turn: Turn = { requestId, kind: "wake", prompt: prompt ?? "", steps: [], text: "", status: e.type === "queued" ? "queued" : "running", error: null };
  const { byTicket } = useClaude.getState();
  const conv = byTicket[conversation] ?? empty;
  useClaude.setState({ byTicket: { ...byTicket, [conversation]: { ...conv, turns: [...conv.turns, turn] } } });
  if (prompt !== undefined) return;
  const mine = generation;
  void claude
    .turns(conversation)
    .catch(() => [] as StoredTurn[])
    .then((stored) => {
      const kept = stored.find((t) => t.requestId === requestId);
      if (!kept || mine !== generation) return;
      updateByRequest(requestId, (c) => ({ ...c, turns: c.turns.map((t) => (t.requestId === requestId && !t.prompt ? { ...t, prompt: kept.prompt } : t)) }));
    });
}

/**
 * Routes one Claude event into the store. One for a turn the store lacks is held while a load may still bring it in,
 * unless it is a wake's (`meta.kind`), which the page didn't ask and so registers as a new turn in its conversation.
 */
export function onClaudeEvent(requestId: string, e: ClaudeEvent, meta?: EventMeta) {
  if (e.type === "done") begun.delete(requestId);
  else if (e.type !== "queued") begun.add(requestId);
  const wake = meta?.kind === "wake" && !!meta.conversation;
  if (!conversationOf(requestId)) {
    if (wake) registerWake(requestId, e, meta.conversation!, meta.prompt);
    else {
      if (loading) held.set(requestId, [...(held.get(requestId) ?? []), e]);
      return;
    }
  } else if (wake && meta.prompt) {
    // More wakes were merged into this one while it waited.
    updateByRequest(requestId, (c) => ({ ...c, turns: c.turns.map((t) => (t.requestId === requestId && t.kind === "wake" ? { ...t, prompt: meta.prompt! } : t)) }));
  }
  updateByRequest(requestId, (c) => applyEvent(c, requestId, e));
  if (e.type === "done" && restoredLive.has(requestId)) settle(requestId);
}

let listening = false;

/** Starts routing Claude events into the store. Safe to call more than once. */
export function listenToClaude() {
  if (listening) return;
  listening = true;
  claude.onEvent(onClaudeEvent);
}

let stopWatching: (() => void) | null = null;

export function stopWatchingProposals() {
  stopWatching?.();
  stopWatching = null;
}

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
