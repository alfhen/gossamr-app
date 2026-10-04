import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SwitchRow } from "../components/Switch";
import { Markdown } from "../components/Markdown";
import { draftsForTurn } from "../lib/proposals";
import { developmentLine } from "../lib/devLinks";
import { describeFilter, itemKey } from "../lib/filter";
import { useClaude, type Turn } from "../claudeStore";
import { filesIn } from "../lib/attachments";
import { MAX_IMAGES, defaultQuestion } from "../lib/pipImages";
import type { ItemRef, Proposal, ScreenContext } from "../types";
import { useDev } from "./devStore";
import { LiveDraftPreview } from "./DraftPreview";
import { useLookup } from "./hooks";
import { PipResizer } from "./PaneResizers";
import { PipAvatar } from "./PipAvatar";
import { PipRunStrip } from "./PipRunCard";
import { AttachButton, AttachedThumbs, TurnImages, lightboxOpen, useAttachments, useFileDrop } from "./PipImages";
import { chipCount, currentContext, unassignedIn, useItemScene, useScreen } from "./pipHooks";
import { appliedState, usePip, type AppliedState } from "./pipStore";
import { usePrefs } from "./prefs";
import { buildScreenContext, contextLabel, contextLines } from "./screenContext";
import { placeholderFor, suggestionsFor } from "./suggestions";
import { useAgentsEnabled } from "./agentsFlag";
import { LiveDraftCard } from "./DraftCard";
import { useManagerOn } from "./managerProto";
import { agentsSuggestionScene, describeRun, runSummaryPrompt } from "./pipRuns";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { draftsForItem, pendingDrafts, useWorkspace } from "../workspaceStore";

export const PIP_INPUT_ID = "pip-input";
export const WORKSPACE_CONVERSATION = "workspace";

export function ContextChip({ kind, label, following, open, onToggle }: { kind: string; label: string; following: boolean; open: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="pip-seeing"
      title="What Pip can see right now"
      className={`flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm text-ws-ink2 hover:border-ws-pip ${open || !following ? "border-ws-pip" : "border-ws-sep2"} ${following ? "" : "bg-ws-pip-soft"}`}
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${following ? "bg-ws-done" : "bg-ws-ink3"}`} />
      {following ? (
        <>
          <span className="shrink-0">{kind}</span>
          <b className="min-w-0 truncate font-semibold text-ws-ink">{label}</b>
        </>
      ) : (
        <b className="min-w-0 truncate font-semibold text-ws-ink">Pinned: {label}</b>
      )}
    </button>
  );
}

export function SeeingPanel({ lines, following, onFollow }: { lines: string[]; following: boolean; onFollow(on: boolean): void }) {
  return (
    <div id="pip-seeing" className="rounded-[10px] border border-ws-sep bg-ws-win px-2.5 py-2 text-sm text-ws-ink2">
      <p className="m-0 font-semibold text-ws-ink">What I can see right now</p>
      <ul className="my-1 mb-1.5 grid list-disc gap-0.5 pl-4">
        {lines.map((l) => (
          <li key={l} className="[overflow-wrap:anywhere]">
            {l}
          </li>
        ))}
      </ul>
      {!following && <p className="m-0 mb-1.5 text-ws-ink3">Pinned: I keep this even as you move around.</p>}
      <SwitchRow label="Follow my screen" checked={following} onChange={onFollow} className="items-center" />
    </div>
  );
}

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

/** What the app told Pip, shown as the app's own message so it never reads as something the person said. */
export function AppNotice({ notice }: { notice: NonNullable<Turn["notice"]> }) {
  return (
    <div role="note" data-app-notice className="grid gap-0.5 rounded-[10px] border border-ws-sep2 bg-ws-bar px-2.5 py-1.5 text-sm">
      <span className="flex items-center gap-1.5 text-xs font-semibold tracking-[0.05em] text-ws-ink3 uppercase">
        <span aria-hidden>◆</span>
        Gossamr told Pip
      </span>
      <b className="font-semibold text-ws-ink">{notice.heading}</b>
      <span className="text-ws-ink2 [overflow-wrap:anywhere]">{notice.body}</span>
    </div>
  );
}

/** With the prototype on, a draft Pip made for a finished run is decided right here instead of only previewed. */
const DECIDED_IN_PANE = new Set<Proposal["intent"]["type"]>(["comment", "subtasks", "followUp"]);

function TurnView({ turn, proposals }: { turn: Turn; proposals: Proposal[] }) {
  const drafts = draftsForTurn(proposals, turn.requestId);
  const working = turn.status === "running" && !turn.text;
  const manager = useManagerOn();
  return (
    <div className="grid gap-2">
      {turn.images && <TurnImages images={turn.images} />}
      {turn.notice ? (
        <AppNotice notice={turn.notice} />
      ) : (
        <div className="max-w-[85%] justify-self-end rounded-[14px_14px_4px_14px] bg-ws-accent px-3 py-1.5 whitespace-pre-wrap text-white [overflow-wrap:anywhere]">
          {turn.prompt}
          {turn.quote && <blockquote className="m-0 mt-1 line-clamp-2 border-l-2 border-white/50 pl-2 text-sm text-white/85">{turn.quote}</blockquote>}
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
      {drafts.map((p) => (manager && DECIDED_IN_PANE.has(p.intent.type) ? <LiveDraftCard key={p.id} proposal={p} jump={false} /> : <LiveDraftPreview key={p.id} proposal={p} />))}
      {turn.status === "failed" && (
        <p role="alert" className="m-0 rounded-md bg-ws-blocked-soft px-3 py-2 text-ws-blocked">
          {turn.error ?? "Pip stopped"}
        </p>
      )}
    </div>
  );
}

/** Drafts still waiting that no question in this conversation made, such as ones from before a restart. */
function EarlierDrafts({ proposals, turns }: { proposals: Proposal[]; turns: Turn[] }) {
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

/** Esc closes the pane unless something else should take it: a peek sheet or ticked cards to dismiss first, or a field being edited other than Pip's own. */
export function escapeClosesPane(s: { peekOpen: boolean; ticked: boolean; editing: boolean; inPipInput: boolean; handled: boolean }): boolean {
  if (s.handled || s.peekOpen || s.ticked) return false;
  return !s.editing || s.inPipInput;
}

function usePaneEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const tabs = useTabs.getState();
      const field = document.activeElement;
      const editable = field instanceof HTMLElement && (field.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName));
      const close = escapeClosesPane({
        peekOpen: tabs.selected !== null && tabs.route !== "settings",
        ticked: tabs.marked.length > 0,
        editing: editable,
        inPipInput: field?.id === PIP_INPUT_ID,
        handled: ev.defaultPrevented || usePrefs.getState().paletteOpen || lightboxOpen(),
      });
      if (!close) return;
      ev.preventDefault();
      onClose();
    };
    // Capture: the peek sheet clears the selection on the same keypress, and this has to see it still open.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
}

/** Docked to the right of the canvas: the conversation with Pip, with what it can see and the drafts it made. */
export function PipPane({ onClose }: { onClose(): void }) {
  const screen = useScreen();
  const itemScene = useItemScene(screen);
  const lookup = useLookup();
  const conv = useClaude((s) => s.byTicket[WORKSPACE_CONVERSATION]);
  const proposals = useWorkspace((s) => s.proposals);
  const pinned = usePip((s) => s.pinned);
  const quote = usePip((s) => s.quote);
  const prefill = usePip((s) => s.prefill);
  const turns = conv?.turns ?? [];
  const running = turns.some((t) => t.status === "running");
  const [input, setInput] = useState("");
  const [seeing, setSeeing] = useState(false);
  const attached = useAttachments();
  const drop = useFileDrop((files) => void attached.add(files));
  const bodyRef = useRef<HTMLDivElement>(null);
  const proposalList = useMemo(() => Object.values(proposals), [proposals]);
  const following = pinned === null;
  const live = useMemo(() => buildScreenContext(screen), [screen]);
  const context: ScreenContext = pinned ?? live;
  const code = useDev((s) => s.index);
  const runs = useRuns((s) => s.runs);
  const words = useMemo(
    () => ({
      titleOf: (ref: ItemRef) => screen.items[itemKey(ref)]?.title ?? null,
      describeFilter: (f: Parameters<typeof describeFilter>[0]) => describeFilter(f, lookup),
      developmentOf: (ref: ItemRef) => developmentLine(code.get(itemKey(ref))),
      runOf: (id: string) => {
        const run = runs.find((r) => r.id === id);
        return run ? describeRun(run, run.item ? screen.items[itemKey(run.item)]?.title : null, Date.now()) : null;
      },
    }),
    [screen.items, lookup, code, runs],
  );
  const openRef = context.item;
  useEffect(() => {
    if (openRef) useDev.getState().ensure([openRef]);
  }, [openRef?.connectionId, openRef?.externalId]);
  const { kind, label } = contextLabel(context, quote, words.titleOf, words.runOf);
  const open = screen.route !== "settings" && screen.selected ? screen.items[screen.selected] : undefined;
  const agentsOn = useAgentsEnabled();
  const hasRuns = runs.length > 0;
  const base = suggestionsFor({
    route: screen.route,
    quote: quote !== null,
    marked: screen.marked.length,
    item: itemScene,
    pendingDrafts: pendingDrafts({ proposals }).length,
    itemDrafts: open ? draftsForItem({ proposals }, open.item).length : 0,
    unassignedInView: unassignedIn(screen.shown),
    shown: screen.shown.length,
    filtered: chipCount(screen) > 0,
    agents: agentsOn ? agentsSuggestionScene(runs, screen.agents?.openRun ?? null) : undefined,
  });
  const chips = agentsOn && hasRuns && screen.route !== "settings" && !quote && !base.includes(runSummaryPrompt()) ? [...base, runSummaryPrompt()] : base;

  useEffect(() => {
    document.getElementById(PIP_INPUT_ID)?.focus();
  }, []);

  useEffect(() => {
    if (!prefill) return;
    setInput(prefill.text);
    usePip.getState().clearPrefill();
    document.getElementById(PIP_INPUT_ID)?.focus();
  }, [prefill]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [turns, proposals]);

  usePaneEscape(onClose);

  const ask = (prompt: string) => {
    if (running) return;
    const count = attached.images.length;
    const text = prompt.trim() || (count ? defaultQuestion(count) : "");
    if (!text) return;
    setInput("");
    const images = attached.take();
    const pip = usePip.getState();
    const about = pip.quote ?? undefined;
    pip.clearQuote();
    void useClaude.getState().ask(WORKSPACE_CONVERSATION, text, conv?.sessionId ?? null, pip.pinned ?? currentContext(), { looking: pip.pinned ? "your question" : label, quote: about, images });
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    ask(input);
  };

  return (
    <aside aria-label="Pip" {...drop.handlers} className="ws-legacy relative flex min-h-0 flex-col border-l border-ws-sep bg-ws-win">
      {drop.over && (
        <div aria-hidden className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-ws-pip bg-ws-pip-soft text-center font-semibold text-ws-pip">
          Drop an image to show Pip
        </div>
      )}
      <PipResizer />
      <header data-tauri-drag-region className="grid gap-1.5 border-b border-ws-sep bg-ws-bar px-3 pt-[14px] pb-2.5">
        <div className="flex items-center gap-2">
          <PipAvatar size={26} thinking={running} />
          <div className="grid leading-tight">
            <h2 className="m-0 text-base font-semibold">Pip</h2>
            <span className="text-xs text-ws-ink3">powered by Claude</span>
          </div>
          <kbd className="ml-1 rounded bg-ws-hover px-1.5 font-mono text-xs text-ws-ink3">⌘J</kbd>
          <button type="button" aria-label="Close Pip" title="Close (Esc)" onClick={onClose} className="ml-auto rounded px-1.5 text-lg leading-none text-ws-ink3 hover:bg-ws-hover">
            ×
          </button>
        </div>
        <ContextChip kind={kind} label={label} following={following} open={seeing} onToggle={() => setSeeing(!seeing)} />
        {seeing && <SeeingPanel lines={contextLines(context, quote, words)} following={following} onFollow={(on) => usePip.getState().setPinned(on ? null : currentContext())} />}
      </header>
      <div ref={bodyRef} className="grid min-h-0 flex-1 content-start gap-4 overflow-auto px-3 py-3">
        <PipRunStrip />
        <EarlierDrafts proposals={proposalList} turns={turns} />
        {turns.length === 0 && (
          <p className="m-0 text-ws-ink2">I follow along as you move around. Tell me what to show, or ask about what is on screen. I can filter this view and draft comments, moves and subtasks. Nothing changes until you approve.</p>
        )}
        {turns.map((t) => (
          <TurnView key={t.requestId} turn={t} proposals={proposalList} />
        ))}
      </div>
      {!running && chips.length > 0 && (
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
        <AttachButton disabled={running || attached.images.length >= MAX_IMAGES} onFiles={(files) => void attached.add(files)} />
        <input
          id={PIP_INPUT_ID}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = filesIn(e.clipboardData).filter((f) => f.type === "" || f.type.startsWith("image/"));
            if (!files.length) return;
            e.preventDefault();
            void attached.add(files);
          }}
          aria-label="Ask Pip"
          placeholder={placeholderFor({ images: attached.images.length > 0, quote: !!quote, itemKey: itemScene?.key ?? null, route: screen.route, runOpen: !!context.run })}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-[10px] border border-ws-sep2 bg-ws-bar px-2.5 py-1.5 outline-none focus:border-ws-pip"
        />
        {running ? (
          <button type="button" onClick={() => useClaude.getState().cancel(WORKSPACE_CONVERSATION)} className="rounded-md border border-ws-sep2 px-3 font-semibold">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() && !attached.images.length} className="rounded-md bg-gradient-to-br from-ws-pip to-ws-pip2 px-3 font-semibold text-ws-on-pip disabled:opacity-45">
            Ask
          </button>
        )}
      </form>
    </aside>
  );
}
