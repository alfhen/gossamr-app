import { useEffect, useMemo, useState } from "react";
import { SwitchRow } from "../components/Switch";
import { developmentLine } from "../lib/devLinks";
import { describeFilter, itemKey } from "../lib/filter";
import type { ItemRef, ScreenContext } from "../types";
import { useDev } from "./devStore";
import { useLookup } from "./hooks";
import { PipResizer } from "./PaneResizers";
import { PipAvatar } from "./PipAvatar";
import { Composer, GENERAL_CONVERSATION, PIP_INPUT_ID, PipConversation, useAnswering, workstreamConversation } from "./PipConversation";
import { lightboxOpen, useAttachments, useFileDrop } from "./PipImages";
import { chipCount, currentContext, unassignedIn, useItemScene, useScreen } from "./pipHooks";
import { usePip } from "./pipStore";
import { usePrefs } from "./prefs";
import { buildScreenContext, contextLabel, contextLines } from "./screenContext";
import { suggestionsFor } from "./suggestions";
import { useAgentsEnabled } from "./agentsFlag";
import { agentsSuggestionScene, describeRun, runSummaryPrompt } from "./pipRuns";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { draftsForItem, pendingDrafts, useWorkspace } from "../workspaceStore";
import { useClaude } from "../claudeStore";
import { inWorkstreamPane } from "../lib/proposals";
import { conversationTitle, usePaneWorkstream } from "./workstreamsStore";
import { stageText } from "../lib/workstreamStage";

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
  const proposals = useWorkspace((s) => s.proposals);
  const pinned = usePip((s) => s.pinned);
  const quote = usePip((s) => s.quote);
  // The ticket the peek shows has an open workstream: its conversation is the one here. Otherwise it is General.
  const workstream = usePaneWorkstream();
  const workstreamId = workstream?.workstream.id ?? null;
  const conversation = workstreamId ? workstreamConversation(workstreamId) : GENERAL_CONVERSATION;
  const running = useAnswering(conversation);
  const [seeing, setSeeing] = useState(false);
  const attached = useAttachments();
  const drop = useFileDrop((files) => void attached.add(files));
  // A workstream's conversation shows its own drafts and the open ones on its ticket; General shows everyone's.
  const shownWorkstream = workstream?.workstream ?? null;
  const proposalList = useMemo(() => Object.values(proposals).filter((p) => !shownWorkstream || inWorkstreamPane(p, shownWorkstream)), [proposals, shownWorkstream]);
  useEffect(() => {
    void useClaude.getState().load(conversation);
  }, [conversation]);
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

  usePaneEscape(onClose);

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
        <ContextChip kind={kind} label={label} following={following} open={seeing} onToggle={() => setSeeing(!seeing)} />
        {seeing && <SeeingPanel lines={contextLines(context, quote, words)} following={following} onFollow={(on) => usePip.getState().setPinned(on ? null : currentContext())} />}
      </header>
      <PipConversation key={conversation} conversation={conversation} proposals={proposalList} />
      <Composer conversation={conversation} attached={attached} chips={chips} looking={label} scene={{ itemKey: itemScene?.key ?? null, route: screen.route, runOpen: !!context.run }} />
    </aside>
  );
}
