import { createContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import type { Preflight, Proposal, Run, RunKind, RunReview } from "../types";
import { useWorkspace } from "../workspaceStore";
import { Box, BoxTitle, Btn, Details, MONO_BLOCK } from "./AgentSheet";
import { PromptParts, ReportExtras } from "./RunPrompt";
import { RunPreflight } from "./RunPreflight";
import { COPY, startBlock } from "./runSheetLogic";
import { DRAFT_CARD, PIP_INPUT_ID } from "./draftKeys";
import { afterRunStarted, approveRunDraft, readRunDraft } from "./runSetupStore";
import { useRuns } from "./runsStore";
import { messageOf, useToasts } from "./toasts";

/**
 * On while the conversation and the step rail are Pip home's: there a run draft that needs nothing chosen is read and
 * started in place, under its card. Elsewhere, as in the docked Pip pane, every run draft opens the setup sheet.
 */
export const InlineStartContext = createContext(false);

/** The kinds started in place. A build pushes and a review reads a pull request, so those always open the full setup sheet. */
const INLINE_KINDS: ReadonlySet<RunKind> = new Set(["investigate", "triage", "plan", "verify"]);

/** Whether draft `p` is started in place on Pip home: a pending run draft on a ticket, of a kind that needs nothing chosen. */
export function inlineStartable(p: Proposal): boolean {
  return p.state.type === "pending" && p.intent.type === "startRun" && p.intent.item !== null && INLINE_KINDS.has(p.intent.spec.kind);
}

/** Closed; the draft being read; read and shown; refused because it changed, and read again; starting; or a refusal or failed read to show. */
export type InlinePhase = "closed" | "loading" | "shown" | "changed" | "starting" | "error";

/** One run draft's inline review, by its draft's id. */
export interface InlineEntry {
  phase: InlinePhase;
  review: RunReview | null;
  preflight: Preflight | null;
  /** The digest of the review whose prompt has rendered on screen; Start waits for it to be the current one. */
  displayed: string | null;
  error: string | null;
  /** The checks are being made again. */
  rechecking: boolean;
  /** Terminal was opened to trust a folder, so the checks run again when the person comes back. */
  trustOpened: boolean;
}

export const CLOSED_INLINE: InlineEntry = { phase: "closed", review: null, preflight: null, displayed: null, error: null, rechecking: false, trustOpened: false };

interface InlineStartsState {
  entries: Record<string, InlineEntry>;
  /** Reads draft `id` and shows it; nothing starts. */
  open(id: string): Promise<void>;
  close(id: string): void;
  /** Opens a closed one, closes an open one: the card's own action. */
  toggle(id: string): void;
  /** The prompt of the review with `digest` has rendered. */
  shown(id: string, digest: string): void;
  /** "I've read it": the changed draft was read again and the person says so. */
  dismissChanged(id: string): void;
  /** Approves the draft with the digest on screen. Null when it didn't start. */
  start(id: string): Promise<Run | null>;
  recheck(id: string): Promise<void>;
  trustFolder(id: string, path: string): Promise<void>;
}

/** Why Start is off for an inline review, or null: the setup sheet's reasons, then the prompt not on screen yet. */
export function inlineStartBlock(entry: InlineEntry): string | null {
  const blocked = startBlock({
    draft: true,
    review: entry.review,
    preflight: entry.preflight,
    busy: entry.phase === "loading",
    starting: entry.phase === "starting",
    changedBanner: entry.phase === "changed",
  });
  if (blocked) return blocked;
  return entry.review && entry.displayed !== entry.review.digest ? "Showing the prompt…" : null;
}

/**
 * ⌘↵ (or Ctrl+↵) in an open review: "start" when Start would start now, "held" when it is off, so the key is taken and
 * nothing happens, as with the button; null for any other key.
 */
export function inlineStartKey(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, entry: InlineEntry): "start" | "held" | null {
  if (ev.key !== "Enter" || !(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return null;
  return inlineStartBlock(entry) === null ? "start" : "held";
}

/** The newest request for each draft, from one counter, so an answer for an earlier open, close or start never lands. */
const requests = new Map<string, number>();
let counter = 0;
const bump = (id: string) => {
  const mine = ++counter;
  requests.set(id, mine);
  return mine;
};

export const useInlineStarts = create<InlineStartsState>((set, get) => {
  const current = (id: string, mine: number) => requests.get(id) === mine;
  const patch = (id: string, over: Partial<InlineEntry>) => set((s) => ({ entries: { ...s.entries, [id]: { ...(s.entries[id] ?? CLOSED_INLINE), ...over } } }));
  const backend = () => useWorkspace.getState().backend;

  /** Reads the draft again after the backend refused it as changed; it stays changed until the person says they read it. */
  const reread = async (id: string, mine: number) => {
    const b = backend();
    if (!b) return;
    try {
      const { review, preflight } = await readRunDraft(b, id);
      if (current(id, mine)) patch(id, { review, preflight });
    } catch (e) {
      if (current(id, mine)) patch(id, { error: messageOf(e) });
    }
  };

  return {
    entries: {},

    async open(id) {
      const b = backend();
      if (!b || !useRuns.getState().ensureAgentsIntro()) return;
      const mine = bump(id);
      patch(id, { ...CLOSED_INLINE, phase: "loading" });
      try {
        const { review, preflight } = await readRunDraft(b, id);
        if (current(id, mine)) patch(id, { phase: "shown", review, preflight });
      } catch (e) {
        if (current(id, mine)) patch(id, { phase: "error", error: messageOf(e) });
      }
    },

    close(id) {
      bump(id);
      set((s) => {
        const { [id]: _gone, ...rest } = s.entries;
        return { entries: rest };
      });
    },

    toggle(id) {
      if ((get().entries[id]?.phase ?? "closed") === "closed") void get().open(id);
      else get().close(id);
    },

    shown(id, digest) {
      const entry = get().entries[id];
      if (entry && entry.review?.digest === digest && entry.displayed !== digest) patch(id, { displayed: digest });
    },

    dismissChanged(id) {
      if (get().entries[id]?.phase === "changed") patch(id, { phase: "shown" });
    },

    async start(id) {
      const b = backend();
      const entry = get().entries[id];
      if (!b || !entry?.review || inlineStartBlock(entry)) return null;
      const draft = useWorkspace.getState().proposals[id];
      const item = draft?.intent.type === "startRun" ? draft.intent.item : null;
      const mine = bump(id);
      patch(id, { phase: "starting", error: null });
      const result = await approveRunDraft(b, id, entry.review.digest);
      if (result.type === "started") {
        if (current(id, mine)) get().close(id);
        // The person stays on Pip home; the step rail shows the run.
        afterRunStarted(result.run, item, { switchToAgents: false });
        return result.run;
      }
      if (!current(id, mine)) return null;
      if (result.type === "changed") {
        patch(id, { phase: "changed" });
        await reread(id, mine);
      } else patch(id, { phase: "error", error: result.message });
      return null;
    },

    async recheck(id) {
      const b = backend();
      const entry = get().entries[id];
      if (!b || !entry?.review || entry.rechecking || entry.phase === "loading" || entry.phase === "starting") return;
      const mine = requests.get(id) ?? 0;
      patch(id, { rechecking: true });
      try {
        const preflight = await b.runsPreflight(entry.review.spec);
        if (current(id, mine)) patch(id, { preflight });
      } catch {
        // The earlier checks stay on screen.
      } finally {
        if (current(id, mine)) patch(id, { rechecking: false });
      }
    },

    async trustFolder(id, path) {
      const b = backend();
      if (!b) return;
      try {
        await b.runsTrustPath(path);
        if (get().entries[id]) patch(id, { trustOpened: true });
      } catch (e) {
        useToasts.getState().push(`Couldn't open Terminal: ${messageOf(e)}`);
      }
    },
  };
});

export interface InlineActions {
  shown(digest: string): void;
  dismissChanged(): void;
  start(): void;
  recheck(): void;
  trustFolder(path: string): void;
  close(): void;
}

const actionsFor = (id: string): InlineActions => {
  const s = () => useInlineStarts.getState();
  return {
    shown: (digest) => s().shown(id, digest),
    dismissChanged: () => s().dismissChanged(id),
    start: () => void s().start(id),
    recheck: () => void s().recheck(id),
    trustFolder: (path) => void s().trustFolder(id, path),
    close: () => s().close(id),
  };
};

/** Draft `proposalId`'s inline review as it stands, and what its controls do. */
export function useInlineStart(proposalId: string): { entry: InlineEntry; on: InlineActions } {
  const entry = useInlineStarts((s) => s.entries[proposalId]) ?? CLOSED_INLINE;
  const on = useMemo(() => actionsFor(proposalId), [proposalId]);
  return { entry, on };
}

/** The id of draft `id`'s inline review, for the expander's aria-controls. */
export const inlineStartId = (id: string) => `inline-start-${id}`;

/** Says once the prompt above it has rendered: a layout effect runs after the elements before it are in the page. */
function Displayed({ digest, onShown }: { digest: string; onShown(digest: string): void }) {
  useLayoutEffect(() => onShown(digest), [digest, onShown]);
  return null;
}

/**
 * A run draft read in place: the exact prompt (read-only), what Gossamr adds for the model, the checks and the safety
 * lines, then Start. Start carries the digest of what is shown, and waits for the prompt to be on screen; a draft that
 * changed meanwhile is read again and waits for "I've read it", as in the setup sheet.
 */
export function InlineStartView({ id, entry, on }: { id: string; entry: InlineEntry; on: InlineActions }) {
  const { review, preflight, phase } = entry;
  const blocked = inlineStartBlock(entry);
  const ref = useRef<HTMLDivElement>(null);
  /** Whether the focus is in the review, or was until Start turned off under it (a disabled button drops focus without a word). */
  const holding = useRef(false);
  // Started or hidden from the keyboard, the review goes with the focus in it: the focus goes back to its card, or to
  // Pip's input once the card has gone too, never nowhere.
  useLayoutEffect(() => {
    const panel = ref.current;
    return () => {
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (!panel || !(panel.contains(document.activeElement) || (holding.current && lost))) return;
      const card = panel.closest<HTMLElement>(DRAFT_CARD);
      requestAnimationFrame(() => {
        const still = document.activeElement === null || document.activeElement === document.body || !document.activeElement.isConnected;
        if (still) (card?.isConnected ? card : document.getElementById(PIP_INPUT_ID))?.focus();
      });
    };
  }, []);
  return (
    <div
      ref={ref}
      onFocus={() => (holding.current = true)}
      onBlur={(ev) => {
        if (ev.relatedTarget && !ev.currentTarget.contains(ev.relatedTarget as Node)) holding.current = false;
      }}
      id={inlineStartId(id)}
      role="group"
      aria-label="Review and start"
      aria-keyshortcuts="Meta+Enter Control+Enter"
      data-inline-start={phase}
      // ⌘↵ starts from anywhere in the review, on the same terms as the Start button.
      onKeyDown={(ev) => {
        const key = inlineStartKey(ev, entry);
        if (!key) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (key === "start") on.start();
      }}
      className="grid gap-3 border-t border-ws-sep px-2.5 py-2.5 text-sm"
    >
      {phase === "changed" && (
        <Box tone="warn" label="The draft changed">
          <BoxTitle icon="alert" tone="warn">
            {COPY.changed}
          </BoxTitle>
          <p className="m-0 text-ws-ink2">Something about this draft changed after you opened it, so nothing started. What is below is what would run now.</p>
          <div>
            <Btn onClick={on.dismissChanged} className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
              I&apos;ve read it
            </Btn>
          </div>
        </Box>
      )}
      {entry.error && (
        <p role="alert" className="m-0 text-ws-blocked [overflow-wrap:anywhere]">
          {entry.error}
        </p>
      )}
      {review ? (
        <>
          <div data-inline-prompt={review.digest}>
            <PromptParts review={review} />
          </div>
          <Displayed digest={review.digest} onShown={on.shown} />
          <Details summary="What Gossamr adds for the model">
            <pre className={MONO_BLOCK}>{review.guard}</pre>
            <p className="m-0 text-ws-ink2">{COPY.guardNote}</p>
            <ReportExtras report={review.report} />
          </Details>
        </>
      ) : (
        phase === "loading" && (
          <p role="status" className="m-0 text-ws-ink3">
            Reading the draft…
          </p>
        )
      )}
      <RunPreflight preflight={preflight} checking={phase === "loading"} steps={{ trust: on.trustFolder, recheck: on.recheck, rechecking: entry.rechecking }} />
      <Box label="What agents can do">
        <p className="m-0 text-ws-ink">{COPY.runAsYou}</p>
        <p className="m-0 text-ws-ink2">{COPY.notALock}</p>
      </Box>
      <div className="flex flex-wrap items-center gap-2">
        <Btn
          tone="primary"
          icon="play"
          data-inline-start-button
          disabled={blocked !== null}
          onClick={on.start}
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
        >
          {phase === "starting" ? "Starting…" : "Start agent"}
        </Btn>
        <Btn tone="ghost" onClick={on.close} className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
          Hide
        </Btn>
        <span role="status" className={`text-sm ${blocked && phase !== "starting" ? "text-ws-ink2" : "text-ws-ink3"}`}>
          {blocked ?? COPY.startsNow}
        </span>
      </div>
    </div>
  );
}

/** Draft `proposal`'s inline review, while it is open; the checks run again when the person comes back from trusting a folder. */
export function InlineStart({ proposal }: { proposal: Proposal }) {
  const { entry, on } = useInlineStart(proposal.id);
  const waitingOnTrust = entry.preflight?.rows.some((r) => r.action?.type === "trustFolder") ?? false;
  useEffect(() => {
    if (!waitingOnTrust) return;
    const back = () => on.recheck();
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [waitingOnTrust, on]);
  if (entry.phase === "closed") return null;
  return <InlineStartView id={proposal.id} entry={entry} on={on} />;
}
