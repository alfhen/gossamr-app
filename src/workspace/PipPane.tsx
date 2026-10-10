import { useEffect, useMemo, useState } from "react";
import { SwitchRow } from "../components/Switch";
import { developmentLine } from "../lib/devLinks";
import { describeFilter, itemKey } from "../lib/filter";
import type { ItemRef, Proposal, ScreenContext, WorkstreamView } from "../types";
import { useDev } from "./devStore";
import { useLookup } from "./hooks";
import { PipResizer } from "./PaneResizers";
import { PipAvatar } from "./PipAvatar";
import { Composer, GENERAL_CONVERSATION, PIP_INPUT_ID, PipConversation, useAnswering, workstreamConversation } from "./PipConversation";
import { lightboxOpen, useAttachments, useFileDrop } from "./PipImages";
import { popoverOpen } from "./Popover";
import { chipCount, currentContext, unassignedIn, useItemScene, useScreen } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { buildScreenContext, contextLabel, contextLines } from "./screenContext";
import { suggestionsFor, workstreamChips } from "./suggestions";
import { useAgentsEnabled } from "./agentsFlag";
import { agentsSuggestionScene, describeRun, runSummaryPrompt } from "./pipRuns";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { draftsForItem, pendingDrafts, useWorkspace } from "../workspaceStore";
import { useClaude } from "../claudeStore";
import { inWorkstreamPane } from "../lib/proposals";
import { conversationTitle, usePaneWorkstream } from "./workstreamsStore";
import { stageText } from "../lib/workstreamStage";
import { WorkstreamControls } from "./WorkstreamControls";
import { workstreamSuggestionScene } from "./pipHomeLogic";

export { AppliedCard, GENERAL_CONVERSATION, PIP_INPUT_ID, workstreamConversation } from "./PipConversation";

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

/** Esc closes the pane unless something else should take it: an open popover or menu, a peek sheet or ticked cards to dismiss first, or a field being edited other than Pip's own. */
export function escapeClosesPane(s: { peekOpen: boolean; ticked: boolean; editing: boolean; inPipInput: boolean; handled: boolean }): boolean {
  if (s.handled || s.peekOpen || s.ticked) return false;
  return !s.editing || s.inPipInput;
}

/**
 * Esc on Pip home: whatever is open over it takes Esc first (a sheet, the peek, the palette, a popover, the image
 * lightbox, or a confirmation or field that handles Esc itself, `handled`), and only then does Esc stop Pip's answer in
 * the focused conversation, if it is answering. Nothing to stop is nothing done.
 */
export function escapeCancelsTurn(s: { sheetOpen: boolean; peekOpen: boolean; paletteOpen: boolean; popoverOpen: boolean; lightbox: boolean; handled: boolean; running: boolean }): boolean {
  if (s.sheetOpen || s.peekOpen || s.paletteOpen || s.popoverOpen || s.lightbox || s.handled) return false;
  return s.running;
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
        // A confirmation or popover that takes Esc itself (`data-esc-local`) closes, not the pane.
        handled: ev.defaultPrevented || usePrefs.getState().paletteOpen || lightboxOpen() || popoverOpen() || (field instanceof HTMLElement && !!field.closest("[data-esc-local]")),
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

/** The drafts a conversation shows: a workstream's own and the open ones on its ticket; General shows everyone's. Also loads the conversation's turns. */
export function useConversationDrafts(conversation: string, workstream: WorkstreamView | null): Proposal[] {
  const proposals = useWorkspace((s) => s.proposals);
  const shown = workstream?.workstream ?? null;
  useEffect(() => {
    void useClaude.getState().load(conversation);
  }, [conversation]);
  return useMemo(() => Object.values(proposals).filter((p) => !shown || inWorkstreamPane(p, shown)), [proposals, shown]);
}

const NO_TURNS: readonly { kind?: "user" | "wake" }[] = [];

/**
 * What the composer offers and says for the screen, the same in the Pip pane and on Pip home: the suggestion chips, the
 * placeholder's scene, and what Pip sees (the context with its label, and the words that describe it). In a
 * workstream's conversation (`workstream`) the chips are about where that workstream stands.
 */
export function usePipChips(workstream: WorkstreamView | null = null) {
  const screen = useScreen();
  const itemScene = useItemScene(screen);
  const lookup = useLookup();
  const proposals = useWorkspace((s) => s.proposals);
  const pinned = usePip((s) => s.pinned);
  const quote = usePip((s) => s.quote);
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
  const turns = useClaude((s) => (workstream ? s.byTicket[workstreamConversation(workstream.workstream.id)]?.turns : undefined)) ?? NO_TURNS;
  const workstreamScene = useMemo(() => (agentsOn && workstream ? workstreamSuggestionScene(workstream, runs, Object.values(proposals), turns) : undefined), [agentsOn, workstream, runs, proposals, turns]);
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
    workstream: workstreamScene,
  });
  // A workstream's chips name its own runs already, at most six of them.
  const chips = agentsOn && hasRuns && screen.route !== "settings" && !quote && !(workstreamScene && workstreamChips(workstreamScene).length) && !base.includes(runSummaryPrompt()) ? [...base, runSummaryPrompt()] : base;
  const scene = { itemKey: itemScene?.key ?? null, route: screen.route, runOpen: !!context.run, workstream: !!workstream };
  return { chips, scene, kind, label, context, words, quote, following: pinned === null };
}

/** The line naming the conversation: "General", or "Workstream: <title> · <Stage>" with only the title cut short. */
export function ConversationLine({ conversation, workstream }: { conversation: string; workstream: WorkstreamView | null }) {
  return (
    <p
      data-pip-conversation={conversation}
      data-waiting-for-pr={workstream?.waitingForPr || undefined}
      title={workstream ? `This workstream's own conversation with Pip. ${conversationTitle(workstream)}` : "Pip's conversation for everything that isn't in a workstream"}
      className="m-0 flex min-w-0 text-sm font-semibold text-ws-ink2"
    >
      {workstream ? (
        <>
          {/* Only the title is cut: where the workstream stands is what the person most needs to see. */}
          <span className="min-w-0 truncate">Workstream: {workstream.workstream.title}</span>
          <span className="shrink-0 whitespace-pre">{` · ${stageText(workstream.stage, workstream.waitingForPr)}`}</span>
        </>
      ) : (
        <span className="truncate">{conversationTitle(null)}</span>
      )}
    </p>
  );
}

/** Docked to the right of the canvas: the conversation with Pip, with what it can see and the drafts it made. */
export function PipPane({ onClose }: { onClose(): void }) {
  // The ticket the peek shows has an open workstream: its conversation is the one here. Otherwise it is General.
  const workstream = usePaneWorkstream();
  const workstreamId = workstream?.workstream.id ?? null;
  const conversation = workstreamId ? workstreamConversation(workstreamId) : GENERAL_CONVERSATION;
  const running = useAnswering(conversation);
  const [seeing, setSeeing] = useState(false);
  const attached = useAttachments();
  const drop = useFileDrop((files) => void attached.add(files));
  const proposalList = useConversationDrafts(conversation, workstream);
  const { chips, scene, kind, label, context, words, quote, following } = usePipChips(workstream);

  usePaneEscape(onClose);

  return (
    <aside aria-label="Pip" data-pip-root {...drop.handlers} className="ws-legacy relative flex min-h-0 flex-col border-l border-ws-sep bg-ws-win">
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
        <ConversationLine conversation={conversation} workstream={workstream} />
        {workstream && <WorkstreamControls key={workstream.workstream.id} view={workstream} />}
        <ContextChip kind={kind} label={label} following={following} open={seeing} onToggle={() => setSeeing(!seeing)} />
        {seeing && <SeeingPanel lines={contextLines(context, quote, words)} following={following} onFollow={(on) => usePip.getState().setPinned(on ? null : currentContext())} />}
      </header>
      <PipConversation key={conversation} conversation={conversation} proposals={proposalList} />
      <Composer conversation={conversation} attached={attached} chips={chips} looking={label} scene={scene} />
    </aside>
  );
}
