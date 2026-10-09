import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Markdown } from "../components/Markdown";
import { draftsForTurn } from "../lib/proposals";
import { REMOVED_TURN } from "../backend/claude";
import { useClaude, type Turn } from "../claudeStore";
import { filesIn } from "../lib/attachments";
import { MAX_IMAGES, defaultQuestion } from "../lib/pipImages";
import type { Proposal } from "../types";
import { LiveDraftPreview } from "./DraftPreview";
import { PIP_INPUT_ID, stepDraftCards, upToNewestDraft } from "./draftKeys";
import { PipRunStrip } from "./PipRunCard";
import { AttachButton, AttachedThumbs, TurnImages, type useAttachments } from "./PipImages";
import { currentContext } from "./pipHooks";
import { appliedState, usePip, type AppliedState } from "./pipStore";
import { placeholderFor } from "./suggestions";
import { useTabs } from "./tabsStore";

export { PIP_INPUT_ID };
export const WORKSPACE_CONVERSATION = "workspace";

const APPLIED: Record<AppliedState, { title: string; action: string | null }> = {
  applied: { title: "View updated", action: "Undo" },
  undone: { title: "View restored", action: "Redo" },
  changed: { title: "View updated", action: null },
  gone: { title: "View updated", action: null },
};

/** A filter Pip put on a tab, inside the answer that asked for it. */
export function AppliedCard({ note, state, onAct }: { note: string; state: AppliedState; onAct(): void }) {
  const { title, action } = APPLIED[state];
  return (
    <div role="status" className="flex items-center gap-2 rounded-[10px] border border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-ws-pip">
      <span aria-hidden>◉</span>
      <div className="grid min-w-0">
        <b>{title}</b>
        <span className="truncate text-sm font-normal text-ws-ink2">{state === "changed" ? `${note} · You changed it since` : note}</span>
      </div>
      {action && (
        <button type="button" onClick={onAct} className="ml-auto shrink-0 rounded-md border border-ws-pip px-2.5 py-px font-semibold hover:bg-ws-pip hover:text-ws-on-pip">
          {action}
        </button>
      )}
    </div>
  );
}

function LiveApplied({ requestId }: { requestId: string }) {
  const applied = usePip((s) => s.applied[requestId]);
  const tabs = useTabs((s) => s.tabs);
  if (!applied) return null;
  const state = appliedState(applied, tabs);
  return <AppliedCard note={applied.note} state={state} onAct={() => (state === "applied" ? usePip.getState().undoApplied(requestId) : usePip.getState().redoApplied(requestId))} />;
}

/** One question and Pip's answer to it, with the drafts the answer made. `afterQueued` says a queued turn waits behind another queued one. */
export function TurnView({ turn, proposals, afterQueued = false }: { turn: Turn; proposals: Proposal[]; afterQueued?: boolean }) {
  const drafts = draftsForTurn(proposals, turn.requestId);
  const working = turn.status === "running" && !turn.text;
  return (
    <div className="grid gap-2">
      {turn.images && <TurnImages images={turn.images} />}
      {!turn.images && !!turn.imageCount && (
        <p className="m-0 justify-self-end text-xs text-ws-ink3">
          {turn.imageCount === 1 ? "1 image was sent with this; it isn't kept." : `${turn.imageCount} images were sent with this; they aren't kept.`}
        </p>
      )}
      <div className="max-w-[85%] justify-self-end rounded-[14px_14px_4px_14px] bg-ws-accent px-3 py-1.5 whitespace-pre-wrap text-white [overflow-wrap:anywhere]">
        {turn.prompt}
        {turn.quote && <blockquote className="m-0 mt-1 line-clamp-2 border-l-2 border-white/50 pl-2 text-sm text-white/85">{turn.quote}</blockquote>}
      </div>
      {turn.status === "queued" && (
        <div className="flex items-center justify-end gap-1.5 text-sm text-ws-ink3">
          <span>{afterQueued ? "Queued, runs after the question before it" : "Queued, runs after the current answer"}</span>
          <button
            type="button"
            aria-label="Remove this question"
            title="Remove this question"
            onClick={() => useClaude.getState().remove(turn.requestId)}
            className="rounded px-1 text-lg leading-none hover:text-ws-ink"
          >
            ×
          </button>
        </div>
      )}
      {(turn.steps.length > 0 || working) && (
        <ul className="m-0 grid list-none gap-1 p-0 text-sm text-ws-ink2">
          {turn.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-ws-done" />
              {s}
            </li>
          ))}
          {working && <li className="animate-pulse text-ws-ink3">Looking at {turn.looking ?? "the screen"}…</li>}
        </ul>
      )}
      {turn.text && (
        <div className="ws-legacy">
          <Markdown text={turn.text} />
        </div>
      )}
      <LiveApplied requestId={turn.requestId} />
      {drafts.map((p) => (
        <LiveDraftPreview key={p.id} proposal={p} />
      ))}
      {turn.status === "failed" && turn.error === REMOVED_TURN && <p className="m-0 justify-self-end text-sm text-ws-ink3">Removed before it started</p>}
      {turn.status === "failed" && turn.error !== REMOVED_TURN && (
        <p role="alert" className="m-0 rounded-md bg-ws-blocked-soft px-3 py-2 text-ws-blocked">
          {turn.error ?? "Pip stopped"}
        </p>
      )}
    </div>
  );
}

/** Drafts still waiting that no question in this conversation made, such as ones from before a restart. */
export function EarlierDrafts({ proposals, turns }: { proposals: Proposal[]; turns: Turn[] }) {
  const asked = new Set(turns.map((t) => t.requestId));
  const waiting = proposals.filter((p) => p.state.type === "pending" && !(p.origin.type === "chat" && asked.has(p.origin.requestId)));
  if (!waiting.length) return null;
  return (
    <section aria-label="Drafts" className="grid gap-1.5">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        Drafts waiting <span className="font-normal">{waiting.length}</span>
      </h3>
      {waiting.map((p) => (
        <LiveDraftPreview key={p.id} proposal={p} />
      ))}
    </section>
  );
}

const NO_TURNS: Turn[] = [];

/** Whether a turn in this conversation is still being answered. */
export function useAnswering(conversation: string): boolean {
  return useClaude((s) => (s.byTicket[conversation]?.turns ?? NO_TURNS).some((t) => t.status === "running"));
}

/** Whether a question in this conversation waits for the one being answered. */
function useQueued(conversation: string): boolean {
  return useClaude((s) => (s.byTicket[conversation]?.turns ?? NO_TURNS).some((t) => t.status === "queued"));
}

/** The conversation itself: running agents, drafts left from before, then each question with its answer. Up and down move between its draft cards. */
export function PipConversation({ conversation, proposals, bodyRef }: { conversation: string; proposals: Proposal[]; bodyRef?: RefObject<HTMLDivElement | null> }) {
  const turns = useClaude((s) => s.byTicket[conversation]?.turns) ?? NO_TURNS;
  const firstQueued = turns.find((t) => t.status === "queued")?.requestId;
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = bodyRef ?? ownRef;

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [turns, proposals]);

  return (
    <div ref={ref} onKeyDown={(ev) => stepDraftCards(ev, ev.currentTarget)} className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-3 py-3">
      <PipRunStrip />
      <EarlierDrafts proposals={proposals} turns={turns} />
      {turns.length === 0 && (
        <p className="m-0 text-ws-ink2">I follow along as you move around. Tell me what to show, or ask about what is on screen. I can filter this view and draft comments, moves and subtasks. Nothing changes until you approve.</p>
      )}
      {turns.map((t) => (
        <TurnView key={t.requestId} turn={t} proposals={proposals} afterQueued={t.status === "queued" && t.requestId !== firstQueued} />
      ))}
    </div>
  );
}

interface ComposerProps {
  conversation: string;
  /** Images waiting to go with the next question; the pane owns them so a drop anywhere on it lands here. */
  attached: ReturnType<typeof useAttachments>;
  /** Suggested questions, shown while no question waits its turn. */
  chips: string[];
  /** What the working line names while Pip answers. */
  looking: string;
  /** What the placeholder suggests asking about. */
  scene: Omit<Parameters<typeof placeholderFor>[0], "images" | "quote">;
}

/** Where a question is written: suggestions, the quoted text, attached images and the input with Ask or Stop. */
export function Composer({ conversation, attached, chips, looking, scene }: ComposerProps) {
  const sessionId = useClaude((s) => s.byTicket[conversation]?.sessionId ?? null);
  const running = useAnswering(conversation);
  const queued = useQueued(conversation);
  const quote = usePip((s) => s.quote);
  const prefill = usePip((s) => s.prefill);
  const [input, setInput] = useState("");

  useEffect(() => {
    document.getElementById(PIP_INPUT_ID)?.focus();
  }, []);

  useEffect(() => {
    if (!prefill) return;
    setInput((now) => (prefill.append ? now + prefill.text : prefill.text));
    usePip.getState().clearPrefill();
    document.getElementById(PIP_INPUT_ID)?.focus();
  }, [prefill]);

  // While Pip answers, a new question waits its turn behind the answer instead of being refused.
  const ask = (prompt: string) => {
    const count = attached.images.length;
    const text = prompt.trim() || (count ? defaultQuestion(count) : "");
    if (!text) return;
    setInput("");
    const images = attached.take();
    const pip = usePip.getState();
    const about = pip.quote ?? undefined;
    pip.clearQuote();
    void useClaude.getState().ask(conversation, text, sessionId, pip.pinned ?? currentContext(), { looking: pip.pinned ? "your question" : looking, quote: about, images });
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    ask(input);
  };

  return (
    <>
      {!queued && chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {chips.map((s) => (
            <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border border-ws-sep2 px-2.5 py-0.5 text-sm hover:border-ws-pip hover:text-ws-pip">
              {s}
            </button>
          ))}
        </div>
      )}
      {quote && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-ws-pip bg-ws-pip-soft px-2.5 py-1 text-sm text-ws-ink2">
          <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]">“{quote}”</span>
          <button type="button" aria-label="Forget the selected text" onClick={() => usePip.getState().clearQuote()} className="shrink-0 text-lg leading-none text-ws-ink3">
            ×
          </button>
        </div>
      )}
      <AttachedThumbs images={attached.images} onRemove={attached.remove} />
      <form onSubmit={submit} className={`flex gap-2 p-3 ${attached.images.length ? "" : "border-t border-ws-sep"}`}>
        <AttachButton disabled={attached.images.length >= MAX_IMAGES} onFiles={(files) => void attached.add(files)} />
        <input
          id={PIP_INPUT_ID}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => upToNewestDraft(e, input, e.currentTarget.closest("aside") ?? document)}
          onPaste={(e) => {
            const files = filesIn(e.clipboardData).filter((f) => f.type === "" || f.type.startsWith("image/"));
            if (!files.length) return;
            e.preventDefault();
            void attached.add(files);
          }}
          aria-label="Ask Pip"
          placeholder={placeholderFor({ ...scene, images: attached.images.length > 0, quote: !!quote })}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-[10px] border border-ws-sep2 bg-ws-bar px-2.5 py-1.5 outline-none focus:border-ws-pip"
        />
        {running && (
          <button type="button" onClick={() => useClaude.getState().cancel(conversation)} className="rounded-md border border-ws-sep2 px-3 font-semibold">
            Stop
          </button>
        )}
        <button type="submit" disabled={!input.trim() && !attached.images.length} className="rounded-md bg-gradient-to-br from-ws-pip to-ws-pip2 px-3 font-semibold text-ws-on-pip disabled:opacity-45">
          Ask
        </button>
      </form>
    </>
  );
}
