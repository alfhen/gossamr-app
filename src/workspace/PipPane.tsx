import { isTypingTarget, showOf } from "../lib/keys";
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
import { currentContext, useScreen } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { buildScreenContext, contextLabel, contextLines } from "./screenContext";
import { describeRun } from "./pipRuns";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useWorkspace } from "../workspaceStore";
import { useClaude } from "../claudeStore";
import { inWorkstreamPane } from "../lib/proposals";
import { conversationTitle, usePaneWorkstream } from "./workstreamsStore";
import { WorkstreamControls } from "./WorkstreamControls";
import { HeaderStatus } from "./StatusPill";
import { composerFooter } from "./workViewLogic";
import { useWorkView } from "./workViewStore";
import { TimelineView } from "./Timeline";
import { useNeedsYou } from "./useNeeds";
import { useNow } from "./AgentsView";

export { AppliedCard, GENERAL_CONVERSATION, PIP_INPUT_ID, workstreamConversation } from "./PipConversation";

export function ContextChip({ kind, label, following, open, onToggle }: { kind: string; label: string; following: boolean; open: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="pip-seeing"
      title="What Pip can see right now"
      className={`flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium text-ws-ink2 hover:border-ws-pip ${open || !following ? "border-ws-pip" : "border-ws-sep2"} ${following ? "" : "bg-ws-pip-soft"}`}
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

function usePaneEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const tabs = useTabs.getState();
      const field = document.activeElement;
      const editable = isTypingTarget(field);
      const close = escapeClosesPane({
        peekOpen: tabs.selected !== null && tabs.route !== "settings",
        ticked: tabs.marked.length > 0,
        editing: editable,
        inPipInput: field?.id === PIP_INPUT_ID,
        // A confirmation or popover that takes Esc itself (`data-esc-local`) closes, not the pane.
        // On Agents an open decision or batch preview closes before the drawer does, when the keyboard is out in the page.
        handled: ev.defaultPrevented || (tabs.route === "agents" && (useWorkView.getState().deciding !== null || useWorkView.getState().batch !== null) && !(field instanceof HTMLElement && field.closest("aside[data-pip-root]"))) || usePrefs.getState().paletteOpen || lightboxOpen() || popoverOpen() || (field instanceof HTMLElement && !!field.closest("[data-esc-local], #workstream-sheet")),
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

/** What the composer says for the screen: the placeholder's scene, and what Pip sees (the context with its label, and the words that describe it). */
export function usePipScene(workstream: WorkstreamView | null = null) {
  const screen = useScreen();
  const lookup = useLookup();
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
  const scene = { itemKey: open?.item.key ?? null, route: screen.route, runOpen: !!context.run, workstream: !!workstream };
  return { scene, kind, label, context, words, quote, following: pinned === null };
}

/** The line naming the conversation: "General", or "Workstream: <title>" with the title cut short. */
export function ConversationLine({ conversation, workstream }: { conversation: string; workstream: WorkstreamView | null }) {
  return (
    // The status pill sits beside the line, not in it.
    <div className="flex min-w-0 items-baseline gap-2">
      <h2
        data-pip-conversation={conversation}
        title={workstream ? `This workstream's own conversation with Pip. ${conversationTitle(workstream)}` : "Pip's conversation for everything that isn't in a workstream"}
        className="m-0 flex min-w-0 text-sm font-semibold text-ws-ink2"
      >
        {workstream ? (
          <span className="min-w-0 truncate">Workstream: {workstream.workstream.title}</span>
        ) : (
          <span className="truncate">{conversationTitle(null)}</span>
        )}
      </h2>
      {workstream && <HeaderStatus view={workstream} />}
    </div>
  );
}

/**
 * The one Pip, docked to the right of every screen: the conversation with Pip, with what it can see and the drafts it
 * made. A workstream's conversation is its timeline; General's follows the screen, listing the runs going and the drafts
 * waiting with the ticket on screen first. On Agents, with a workstream's detail open, it is that workstream's.
 */
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
  const { scene, kind, label, context, words, quote, following } = usePipScene(workstream);
  const needs = useNeedsYou();
  const runs = useRuns((s) => s.runs);
  const now = useNow();
  const footer = useMemo(() => composerFooter(runs, needs.length, now), [runs, needs.length, now]);

  usePaneEscape(onClose);

  return (
    <aside aria-label="Pip" data-pip-root {...drop.handlers} className="ws-legacy relative flex min-h-0 flex-col border-l border-ws-sep bg-ws-win">
      {drop.over && (
        <div aria-hidden className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-ws-pip bg-ws-pip-soft text-center font-semibold text-ws-pip">
          Drop an image to show Pip
        </div>
      )}
      <PipResizer />
      <header data-tauri-drag-region className="ws-glass ws-glass-pip ws-glass-regular relative before:p-0 before:pb-px z-10 grid gap-1.5 px-3 pt-[14px] pb-2.5 font-medium text-ws-ink [&_[data-status-detail]]:text-ws-ink2 [&_[data-waiting-for-pr]]:text-ws-ink2">
        <div className="flex items-center gap-2">
          <PipAvatar size={26} thinking={running} />
          <div className="grid leading-tight">
            <h2 className="m-0 text-base font-semibold">Pip</h2>
            <span className="text-xs text-ws-ink2">powered by Claude</span>
          </div>
          <kbd className="ml-1 rounded border border-ws-sep2 px-1.5 font-mono text-xs font-medium text-ws-ink2">{showOf("app", "pip")}</kbd>
          <button type="button" aria-label="Close Pip" title="Close (Esc)" onClick={onClose} className="ml-auto rounded px-1.5 text-lg leading-none text-ws-ink2 hover:bg-ws-hover">
            ×
          </button>
        </div>
        <ConversationLine conversation={conversation} workstream={workstream} />
        {workstream && <WorkstreamControls key={workstream.workstream.id} view={workstream} />}
        <ContextChip kind={kind} label={label} following={following} open={seeing} onToggle={() => setSeeing(!seeing)} />
        {seeing && <SeeingPanel lines={contextLines(context, quote, words)} following={following} onFollow={(on) => usePip.getState().setPinned(on ? null : currentContext())} />}
      </header>
      {workstream ? (
        <TimelineView key={conversation} conversation={conversation} workstream={workstream} proposals={proposalList} needs={needs} />
      ) : (
        // About one ticket, outside a workstream, the pane lists that ticket's drafts and folds the rest.
        <PipConversation key={conversation} conversation={conversation} proposals={proposalList} ticket={context.item} />
      )}
      <Composer conversation={conversation} attached={attached} looking={label} scene={scene} footer={footer} />
    </aside>
  );
}
