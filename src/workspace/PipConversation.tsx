import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Markdown } from "../components/Markdown";
import { draftsForTurn } from "../lib/proposals";
import { REMOVED_TURN } from "../backend/claude";
import { useClaude, type Turn } from "../claudeStore";
import { filesIn } from "../lib/attachments";
import { runComposerVerb, runRef, type VerbOutcome } from "../lib/composerVerbs";
import { labelsByRun } from "../lib/workstreamStage";
import { workstreamOfConversation } from "../lib/conversations";
import { MAX_IMAGES, defaultQuestion } from "../lib/pipImages";
import type { Proposal } from "../types";
import { LiveDraftPreview } from "./DraftPreview";
import { PIP_INPUT_ID, PIP_ROOT, stepDraftCards, upToNewestDraft } from "./draftKeys";
import { PipRunStrip } from "./PipRunCard";
import { AttachButton, AttachedThumbs, TurnImages, type useAttachments } from "./PipImages";
import { currentContext } from "./pipHooks";
import { appliedState, usePip, type AppliedState } from "./pipStore";
import { placeholderFor } from "./suggestions";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useAgentsEnabled } from "./agentsFlag";
import { usePipHome } from "./pipHomeStore";
import { contextFor, useWorkstreams } from "./workstreamsStore";
import { useWorkspace } from "../workspaceStore";

export { PIP_INPUT_ID };
/** The Pip pane's conversation when no workstream is in focus, and each workstream's own (`ws:<id>`). */
export { GENERAL_CONVERSATION, workstreamConversation } from "../lib/conversations";

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

const WAKE_LINE = /^\[Event\] (?:run (\S+)|a run) \(\w+\) ([^;]+)/;
const WAKE_STATE: Record<string, string> = { Done: "finished", Failed: "failed", Stopped: "stopped", "Stopped at a limit": "stopped at a limit" };

/** What a wake turn's muted line says, in parts: the run it names (by its label, else its short id) and that run's id, so the line can link to it. */
export interface WakeParts {
  /** "run R2", "a run", or null when the prompt has no event lines. */
  who: string | null;
  /** The id of the run named, when the event names one. */
  runId: string | null;
  /** What follows the run: " finished", " finished and 1 more". */
  rest: string;
}

/** The parts of a wake turn's header, from the turn's event lines (`WAKE_LINE`). */
export function wakeParts(prompt: string, labels: ReadonlyMap<string, string>): WakeParts {
  const events = prompt
    .split("\n")
    .map((l) => WAKE_LINE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  if (!events.length) return { who: null, runId: null, rest: "" };
  const state = (s: string) => WAKE_STATE[s.trim()] ?? "needs you";
  const [, id, first] = events[0];
  const more = events.length > 1 ? ` and ${events.length - 1} more` : "";
  return { who: id ? `run ${labels.get(id) ?? runRef({ id })}` : "a run", runId: id ?? null, rest: ` ${state(first)}${more}` };
}

/**
 * The muted line a wake turn opens with in place of a question: "Pip picked this up: run R2 finished", the run named by
 * its label in its workstream (`labels`), else its short id, from the turn's event lines.
 */
export function wakeHeader(prompt: string, labels: ReadonlyMap<string, string>): string {
  const { who, rest } = wakeParts(prompt, labels);
  return who ? `Pip picked this up: ${who}${rest}` : "Pip picked this up";
}

/**
 * Opens the run a wake turn is about: on Pip home its step opens in the rail and its card there takes focus; in the Pip
 * pane its sheet opens over the screen the person is on.
 */
export function openWakeRun(runId: string) {
  if (useTabs.getState().route === "pip") usePipHome.getState().focus({ type: "run", id: runId, where: "rail" });
  else useRuns.getState().openRun(runId, { stay: true });
}

function WakeHeader({ turn }: { turn: Turn }) {
  const runs = useRuns((s) => s.runs);
  const { who, runId, rest } = wakeParts(turn.prompt, labelsByRun(runs));
  return (
    <p data-wake-header className="m-0 flex flex-wrap items-center gap-x-1.5 text-sm text-ws-ink3">
      <span aria-hidden className="size-1.5 rounded-full bg-ws-pip" />
      {who === null ? (
        "Pip picked this up"
      ) : (
        <span>
          Pip picked this up:{" "}
          {runId && runs.some((r) => r.id === runId) ? (
            <button type="button" data-wake-run={runId} title="Show this run" onClick={() => openWakeRun(runId)} className="rounded text-ws-ink2 underline-offset-2 hover:text-ws-pip hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ws-pip">
              {who}
            </button>
          ) : (
            who
          )}
          {rest}
        </span>
      )}
    </p>
  );
}

/** More than about three lines of a wake's answer is folded away behind Show more. */
const WAKE_LINES = 3;
const WAKE_CHARS = 240;
export const wakeIsLong = (text: string) => text.trim().split(/\n+/).length > WAKE_LINES || text.length > WAKE_CHARS;

/** A wake's answer, at most about three lines until the person asks for the rest. */
function WakeText({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const long = wakeIsLong(text);
  const panel = `wake-text-${id}`;
  return (
    <div className="grid gap-0.5">
      <div id={panel} data-wake-text data-clamped={long && !open ? "true" : undefined} className={`ws-legacy text-ws-ink2 ${long && !open ? "line-clamp-3" : ""}`}>
        <Markdown text={text} />
      </div>
      {long && (
        <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} className="justify-self-start rounded text-xs font-semibold text-ws-ink2 hover:underline focus-visible:outline-2 focus-visible:outline-ws-pip">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Why a wake turn ended without an answer, said quietly: the person wrote first, or held it. */
const setAside = (turn: Turn) => turn.kind === "wake" && turn.status === "failed" && (turn.error === REMOVED_TURN || turn.error === "Stopped");

/** One question and Pip's answer to it, with the drafts the answer made. `afterQueued` says a queued turn waits behind another queued one. A wake has no question: a muted line says what woke Pip. */
export function TurnView({ turn, proposals, afterQueued = false }: { turn: Turn; proposals: Proposal[]; afterQueued?: boolean }) {
  const drafts = draftsForTurn(proposals, turn.requestId);
  const working = turn.status === "running" && !turn.text;
  if (turn.kind === "wake") {
    return (
      <div data-turn-kind="wake" data-turn-status={turn.status} className="grid gap-1">
        <WakeHeader turn={turn} />
        {(turn.steps.length > 0 || working) && (
          <ul className="m-0 grid list-none gap-1 p-0 text-sm text-ws-ink2">
            {turn.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-ws-done" />
                {s}
              </li>
            ))}
            {working && <li className="animate-pulse text-ws-ink3">Reading what happened…</li>}
          </ul>
        )}
        {turn.text && <WakeText id={turn.requestId} text={turn.text} />}
        {drafts.map((p) => (
          <LiveDraftPreview key={p.id} proposal={p} />
        ))}
        {setAside(turn) && <p className="m-0 text-sm text-ws-ink3">Set aside</p>}
        {turn.status === "failed" && !setAside(turn) && (
          <p role="alert" className="m-0 rounded-md bg-ws-blocked-soft px-3 py-2 text-ws-blocked">
            {turn.error ?? "Pip stopped"}
          </p>
        )}
      </div>
    );
  }
  return (
    <div data-turn-kind="user" data-turn-status={turn.status} className="grid gap-2">
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
  const unasked = (p: Proposal) => !(p.origin.type === "chat" && asked.has(p.origin.requestId));
  const waiting = proposals.filter((p) => p.state.type === "pending" && unasked(p));
  /** The drafts this section has shown waiting. */
  const shown = useRef(new Set<string>());
  for (const p of waiting) shown.current.add(p.id);
  // A draft that waited here and was retired (another move of the ticket was approved, say) stays, collapsed with why,
  // rather than vanishing from under the person.
  const retired = proposals.filter((p) => p.state.type === "retired" && shown.current.has(p.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!waiting.length && !retired.length) return null;
  return (
    <section aria-label="Drafts" className="grid gap-1.5">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        Drafts waiting <span className="font-normal">{waiting.length}</span>
      </h3>
      {waiting.map((p) => (
        <LiveDraftPreview key={p.id} proposal={p} />
      ))}
      {retired.map((p) => (
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
  const workstreamId = workstreamOfConversation(conversation);
  const workstream = useWorkstreams((s) => (workstreamId ? (s.list.find((v) => v.workstream.id === workstreamId)?.workstream ?? null) : null));
  const firstQueued = turns.find((t) => t.status === "queued")?.requestId;
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = bodyRef ?? ownRef;

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [turns, proposals]);

  return (
    <div ref={ref} onKeyDown={(ev) => stepDraftCards(ev, ev.currentTarget)} className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-3 py-3">
      <PipRunStrip workstream={workstreamId} />
      <EarlierDrafts proposals={proposals} turns={turns} />
      {turns.length === 0 &&
        (workstreamId ? (
          <p data-empty-workstream className="m-0 text-ws-ink2">
            This is the workstream on {workstream?.itemKey ?? workstream?.title ?? "this ticket"}: its agents, drafts and our conversation stay together here. Ask me to investigate, triage or plan it. To act on one of its runs yourself, type /stop R1, /retry R1 or /answer R1 and your answer.{" "}
            {workstream?.mode === "manage"
              ? "It is in Manage: the routine next steps start on their own by fixed rules (see Automatic steps), I start nothing myself, and every change to Jira still waits for you."
              : "Nothing changes until you approve."}
          </p>
        ) : (
          <p className="m-0 text-ws-ink2">I follow along as you move around. Tell me what to show, or ask about what is on screen. I can filter this view and draft comments, moves and subtasks. Nothing changes until you approve.</p>
        ))}
      {turns.map((t) => (
        <TurnView key={t.requestId} turn={t} proposals={proposals} afterQueued={t.status === "queued" && t.requestId !== firstQueued} />
      ))}
    </div>
  );
}

/**
 * A command typed in the composer (`/stop R1`, `/retry R1`, `/answer R1 text`, and `/hold`, `/resume` in a workstream),
 * carried out with the person's own commands; what it came to is told under the input. Null for anything else, which is a question for Pip, and for
 * everything while Agents are off, when the composer is what it was before agents. A command never reaches Pip and adds
 * no turn. `R1` is looked up among the runs of the conversation's workstream.
 */
export function composerVerb(text: string, conversation: string, agentsOn: boolean): Promise<VerbOutcome> | null {
  if (!agentsOn) return null;
  const runs = useRuns.getState();
  const workstream = workstreamOfConversation(conversation);
  const heldReason = workstream ? (useWorkstreams.getState().list.find((v) => v.workstream.id === workstream)?.workstream.heldReason ?? null) : null;
  const done = runComposerVerb(text, { runs: runs.runs, workstream, backend: runs.backend ?? useWorkspace.getState().backend, heldReason });
  // /hold and /resume change the workstream's header at once, not on the next change event.
  return done && workstream ? done.then((outcome) => (outcome.ok && void useWorkstreams.getState().refresh(), outcome)) : done;
}

/**
 * What the composer's input holds once a command typed as `typed` came to `outcome`, while it now holds `now`: cleared
 * when it worked (unless the person has typed on since), kept when it was refused so it can be put right.
 */
export const inputAfterCommand = (outcome: VerbOutcome, typed: string, now: string) => (outcome.ok && now === typed ? "" : now);

/** The muted line under the composer saying what the last command came to. */
export function VerbNote({ outcome }: { outcome: VerbOutcome | null }) {
  if (!outcome) return null;
  return (
    <p role="status" data-verb-note={outcome.ok ? "ok" : "problem"} className="m-0 -mt-2 px-3 pb-2 text-sm text-ws-ink3">
      {outcome.message}
    </p>
  );
}

/** What the agents are doing, under the composer: updated as runs move, and never a turn in the conversation. */
export function ComposerFooter({ text }: { text: string }) {
  return (
    <p role="status" data-composer-footer className="m-0 -mt-1 px-3 pb-2 text-xs text-ws-ink3">
      {text}
    </p>
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
  /** A muted line under the input, such as Pip home's "4 agents working · 2 need you"; the pane has none. */
  footer?: string | null;
}

/** Where a question is written: suggestions, the quoted text, attached images and the input with Ask or Stop. */
/** Whether a command typed in `asked` may still change the composer: not once the person has moved to another conversation,
 * where its note and the input it would clear belong to something else. */
export function outcomeBelongs(asked: string, shown: string): boolean {
  return asked === shown;
}

export function Composer({ conversation, attached, chips, looking, scene, footer = null }: ComposerProps) {
  const sessionId = useClaude((s) => s.byTicket[conversation]?.sessionId ?? null);
  const running = useAnswering(conversation);
  const queued = useQueued(conversation);
  const quote = usePip((s) => s.quote);
  const prefill = usePip((s) => s.prefill);
  const agentsOn = useAgentsEnabled();
  const [input, setInput] = useState("");
  /** What the last command typed here came to, under the input. */
  const [note, setNote] = useState<VerbOutcome | null>(null);
  // A note is about the conversation it was typed in.
  useEffect(() => setNote(null), [conversation]);
  /** The conversation shown now, for a command that finishes after the person moved to another one. */
  const shown = useRef(conversation);
  shown.current = conversation;

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
    setNote(null);
    const command = composerVerb(text, conversation, agentsOn);
    if (command) {
      const asked = conversation;
      void command.then((outcome) => {
        if (!outcomeBelongs(asked, shown.current)) return;
        setNote(outcome);
        setInput((now) => inputAfterCommand(outcome, prompt, now));
      });
      return;
    }
    setInput("");
    const images = attached.take();
    const pip = usePip.getState();
    const about = pip.quote ?? undefined;
    pip.clearQuote();
    void useClaude.getState().ask(conversation, text, sessionId, contextFor(conversation, pip.pinned ?? currentContext()), { looking: pip.pinned ? "your question" : looking, quote: about, images });
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
          onKeyDown={(e) => upToNewestDraft(e, input, e.currentTarget.closest(PIP_ROOT) ?? document)}
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
      <VerbNote outcome={note} />
      {footer && <ComposerFooter text={footer} />}
    </>
  );
}
