import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { MentionTextarea } from "../components/MentionTextarea";
import { PipGlyph } from "../components/PipGlyph";
import { docFromText } from "../lib/docs";
import { itemKey } from "../lib/filter";
import { liveMentions, type Mention } from "../lib/mentions";
import { relativeTime } from "../lib/views";
import type { ItemRef, StatusDef, WorkEvent, WorkItem, WorkstreamView } from "../types";
import { draftsForItem, knownMoves, useItemsByFilter, useWorkspace, workflowOfItem } from "../workspaceStore";
import { draftStatus, movesAreOpaque, targetsFor } from "./boardLogic";
import { PeekResizer, usePaneWidths } from "./PaneResizers";
import { LiveDraftCard } from "./DraftCard";
import { draftIdOf, draftItem, showsAsDraftTicket } from "./draftTicket";
import { LiveDraftPeek } from "./DraftPeek";
import { PIP_INPUT_ID } from "./draftKeys";
import { canvasElement, showMe } from "./jump";
import { PEEK_DEFAULT } from "./paneSizes";
import { usePrefs } from "./prefs";
import { CommentCard, HistoryRow, SectionCard, SectionNav, showComment } from "./PeekParts";
import { displayName, historyNotes, isCollapsed, linkRows, parentCrumb, replyDraft, sectionChips, shownComments, subtasksOf, type Collapsed, type Crumb, type LinkRow, type Note, type PeekSectionId, type ReplyDraft, type Subtasks } from "./peekLogic";
import { TicketAgents, runsOfTicket } from "./TicketAgents";
import { CLOSE_RUNS_NOTE } from "./WorkstreamControls";
import { Development } from "./DevelopmentSection";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { PeekNotice } from "./WatchNotices";
import { WorkDocView } from "./WorkDocView";
import { HeaderStatus } from "./StatusPill";
import { Button } from "../components/Button";
import { focusPip, useItemWorkstream, useWorkstreams } from "./workstreamsStore";
import { useToasts } from "./toasts";
import { isTypingTarget } from "../lib/keys";

/**
 * The peek's "Start a workstream": the workstream opens as `start` shows it, which over Agents is its detail, so closing the
 * peek leaves it there; a note says it started.
 */
export async function startFromPeek(ref: ItemRef) {
  const started = await useWorkstreams.getState().start(ref);
  if (started && useTabs.getState().route === "agents") useToasts.getState().push(`Started a workstream on ${ref.key}.`, "info", undefined, { lifetime: 2500 });
}

const CATEGORY_TONE = {
  todo: "bg-ws-hover text-ws-ink2",
  active: "bg-ws-accent-soft text-ws-accent",
  done: "bg-ws-done-soft text-ws-done",
} as const;

const NO_EVENTS: WorkEvent[] = [];

const EXIT_MS = 160;

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const chip = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-semibold";

/** What replaces the parts of the sheet that only make sense for a ticket that exists: the sheet then shows a draft of a new one. */
export interface DraftSlots {
  banner: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  description: ReactNode;
  /** Steps between the drafts waiting; shown in the sheet's header. */
  nav?: ReactNode;
  actions: ReactNode;
}

export interface PeekViewProps {
  item: WorkItem;
  /** Shows the item as a draft that doesn't exist yet: editable fields and a Create button, and no comments, history, links or code. */
  draft?: DraftSlots;
  assignee: string;
  now: Date;
  /** Statuses the item can move to; empty when the workflow isn't known yet. */
  moves: StatusDef[];
  /** Still asking the tracker where the item can move. */
  checking?: boolean;
  menuOpen: boolean;
  links: LinkRow[];
  comments: Note[];
  commentsLoading?: boolean;
  history: Note[];
  /** The description, already rendered. */
  description: ReactNode;
  drafts: ReactNode;
  /** The menu for starting an agent on the item; left out when Agents is off or the item is read-only. */
  agentMenu?: ReactNode;
  agents?: ReactNode;
  composer: ReactNode;
  notice: string | null;
  onMenu(open: boolean): void;
  onMove(to: StatusDef): void;
  onLink(link: LinkRow): void;
  onOpen(ref: ItemRef): void;
  onClose(): void;
  /** The epic or parent above the item. */
  crumb?: Crumb | null;
  subtasks?: Subtasks;
  /** A line above the title, such as the read-only notice. */
  banner?: ReactNode;
  /** Where a pending draft would move the item. */
  proposedMove?: string | null;
  wide?: boolean;
  /** Width in px while not expanded. */
  width?: number;
  /** How the sheet arrives or leaves; `none` while browsing from one item to the next. */
  motion?: "in" | "out" | "none";
  onWide?(): void;
  onMotionEnd?(): void;
  /** Sections the person folded; all open when omitted. */
  collapsed?: Collapsed;
  onToggleSection?(id: PeekSectionId): void;
  onJump?(id: PeekSectionId): void;
  /** Starts a reply to a comment; replying is not offered when omitted. */
  onReply?(note: Note): void;
  /** The Development section, or the banner that stands in for it; nothing on a build without a code host. */
  development?: ReactNode;
  /** How many changes the section lists; leaves the nav chip out when omitted. */
  developmentCount?: number;
}

const MOTION = { in: "ws-peek-in", out: "ws-peek-out", none: "" } as const;

export function PeekView(p: PeekViewProps) {
  const { item } = p;
  const blockedBy = p.links.filter((l) => l.kind === "blockedBy");
  const open = p.onOpen;
  const folded = p.collapsed ?? {};
  const section = (id: PeekSectionId) => ({ collapsed: isCollapsed(folded, id), onToggle: p.onToggleSection ? () => p.onToggleSection!(id) : undefined });
  const commentCount = p.commentsLoading ? item.commentCount : p.comments.length;
  const draft = p.draft;
  return (
    <aside
      id="peek-sheet"
      aria-label={draft ? "Details for a new ticket draft" : `Details for ${item.item.key}`}
      onAnimationEnd={(ev) => ev.target === ev.currentTarget && p.onMotionEnd?.()}
      tabIndex={draft ? -1 : undefined}
      className={`selectable ws-legacy absolute inset-y-0 right-0 z-20 flex flex-col border-l border-ws-sep2 bg-ws-win shadow-[-14px_0_40px_rgb(0_0_0/0.16)] max-w-full motion-safe:transition-[width] motion-safe:duration-200 ws-sized ${
        p.wide ? "w-full" : ""
      } ${draft ? "outline-2 -outline-offset-[5px] outline-dashed outline-ws-pip" : ""} ${MOTION[p.motion ?? "none"]}`}
      style={p.wide ? undefined : { width: p.width ?? PEEK_DEFAULT }}
    >
      {!p.wide && p.onWide && <PeekResizer />}
      <div className="flex shrink-0 items-center gap-2 border-b border-ws-sep px-3.5 py-2">
        <span className={`shrink-0 font-mono text-sm font-semibold ${draft ? "text-ws-pip" : "text-ws-ink2"}`}>{item.item.key}</span>
        <span className="min-w-0 truncate text-xs text-ws-ink3">
          {draft ? (
            <>
              draft · <kbd className="font-sans">esc</kbd> close
            </>
          ) : (
            <>
              peek · <kbd className="font-sans">j</kbd> <kbd className="font-sans">k</kbd> browse · <kbd className="font-sans">esc</kbd> close
            </>
          )}
        </span>
        {draft?.nav}
        {p.onWide && (
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label={p.wide ? "Shrink details" : "Expand details"}
            aria-pressed={!!p.wide}
            title={p.wide ? "Shrink" : "Expand"}
            onClick={p.onWide}
            className={draft?.nav ? "" : "ml-auto"}
          >
            {p.wide ? "⤡" : "⤢"}
          </Button>
        )}
        <Button variant="quiet" size="sm" iconOnly aria-label="Close details" onClick={p.onClose} className={p.onWide || draft?.nav ? "" : "ml-auto"}>
          ×
        </Button>
      </div>
      <div data-peek-scroll className={`min-h-0 flex-1 gap-5 overflow-auto px-[22px] ${draft ? "flex flex-col pt-4" : "grid content-start scroll-pt-11"}`}>
        {!draft && <SectionNav chips={sectionChips({ links: p.links.length, comments: commentCount, history: p.history.length, development: p.developmentCount })} onJump={p.onJump} />}
        <div className="grid gap-2.5">
          {draft?.banner}
          {p.banner}
          {p.crumb && (
            <p className="m-0 font-mono text-sm text-ws-ink3">
              <button type="button" onClick={() => open(p.crumb!.ref)} title={p.crumb.title ?? undefined} className="font-semibold text-ws-accent hover:underline">
                {p.crumb.ref.key}
              </button>
              {" / "}
              {item.item.key}
            </p>
          )}
          {draft ? draft.title : <h2 className="font-display m-0 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere]">{item.title}</h2>}
          {draft ? (
            draft.meta
          ) : (
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-ws-ink2">
              <div className="relative">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={p.menuOpen}
                  disabled={!p.moves.length && !p.checking}
                  onClick={() => p.onMenu(!p.menuOpen)}
                  className={`${chip} ${CATEGORY_TONE[item.status.category]} disabled:cursor-default`}
                >
                  {item.status.name}
                  {p.moves.length > 0 && <span aria-hidden className="text-[11px] opacity-70">▾</span>}
                </button>
                {p.menuOpen && (
                  <ul role="menu" aria-label={`Draft a move for ${item.item.key}`} className="absolute top-full left-0 z-30 m-0 mt-1 grid min-w-44 list-none gap-px ws-glass ws-glass-regular rounded-lg p-1 text-sm font-medium text-ws-ink">
                    <li className="px-2 py-1 text-xs font-medium text-ws-ink">{p.checking ? "Checking where it can move…" : "Draft a move to"}</li>
                    {p.moves.map((s) => (
                      <li key={s.id} role="none">
                        <button type="button" role="menuitem" onClick={() => p.onMove(s)} className="w-full rounded-md px-2 py-1 text-left ws-glass-item">
                          {s.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {p.proposedMove && <span className={`${chip} border border-dashed border-ws-pip bg-ws-pip-soft font-medium text-ws-pip`}>→ {p.proposedMove} (proposed)</span>}
              <span>
                Assignee <b className="font-semibold text-ws-ink">{p.assignee}</b>
              </span>
              {item.priority && (
                <span>
                  Priority <b className="font-semibold text-ws-ink">{item.priority}</b>
                </span>
              )}
              <span className="capitalize">{item.kind}</span>
              {item.labels.map((l) => (
                <span key={l} className={`${chip} bg-ws-accent-soft font-normal text-ws-accent`}>
                  {l}
                </span>
              ))}
              <span className="text-ws-ink3" title={`Last updated ${new Date(item.updated).toLocaleString()}`}>
                Updated {relativeTime(item.updated, p.now)}
              </span>
            </div>
          )}
          {p.notice && (
            <p role="status" className="m-0 text-sm text-ws-ink2">
              {p.notice}
            </p>
          )}
          {blockedBy.length > 0 && (
            <p className="m-0 text-ws-blocked">
              <span aria-hidden>⛓ </span>Blocked by{" "}
              {blockedBy.map((l, i) => (
                <span key={itemKey(l.ref)}>
                  {i > 0 && ", "}
                  <button type="button" onClick={() => p.onLink(l)} title={l.title ?? undefined} className="font-mono font-semibold hover:underline">
                    {l.ref.key}
                  </button>
                </span>
              ))}
            </p>
          )}
          {!draft && p.agentMenu}
        </div>

        {p.drafts}
        {!draft && p.agents}

        <SectionCard id="description" title="Description" fill={!!draft} {...section("description")}>
          <div className={`min-w-0 [overflow-wrap:anywhere] ${draft ? "flex flex-col" : ""}`}>{draft ? draft.description : p.description}</div>
        </SectionCard>

        {!draft && p.subtasks && p.subtasks.rows.length > 0 && (
          <SectionCard id="subtasks" title="Subtasks" count={p.subtasks.rows.length}>
            <div className="flex items-center gap-2 text-sm text-ws-ink3">
              <div
                role="progressbar"
                aria-label="Subtasks done"
                aria-valuemin={0}
                aria-valuemax={p.subtasks.rows.length}
                aria-valuenow={p.subtasks.done}
                className="h-1 flex-1 overflow-hidden rounded-full bg-ws-hover"
              >
                <div className="h-full bg-ws-done" style={{ width: `${(p.subtasks.done / p.subtasks.rows.length) * 100}%` }} />
              </div>
              <span>
                {p.subtasks.done}/{p.subtasks.rows.length} done
              </span>
            </div>
            <ul className="m-0 list-none p-0">
              {p.subtasks.rows.map((r) => (
                <li key={itemKey(r.ref)} className="border-b border-ws-sep">
                  <button type="button" onClick={() => open(r.ref)} className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-ws-hover">
                    <input type="checkbox" checked={r.done} disabled readOnly aria-label={r.done ? "Done" : "Not done"} className="shrink-0" />
                    <span className="shrink-0 font-mono text-sm font-semibold text-ws-ink2">{r.ref.key}</span>
                    <span className={`min-w-0 flex-1 truncate ${r.done ? "text-ws-ink3 line-through" : ""}`}>{r.title}</span>
                    <span className={`${chip} shrink-0 py-0 text-xs ${CATEGORY_TONE[r.status.category]}`}>{r.status.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        {!draft && p.links.length > 0 && (
          <SectionCard id="links" title="Links" count={p.links.length} {...section("links")}>
            <ul className="m-0 grid list-none gap-1 p-0">
              {p.links.map((l) => (
                <li key={`${l.kind}:${itemKey(l.ref)}`} className="flex items-baseline gap-2">
                  <span className="w-24 shrink-0 text-sm text-ws-ink3">{l.label}</span>
                  <button type="button" onClick={() => p.onLink(l)} className="min-w-0 text-left hover:underline">
                    <span className="font-mono text-sm font-semibold">{l.ref.key}</span>
                    {l.title && <span className="ml-1.5 text-ws-ink2">{l.title}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}

        {!draft && p.development}

        {!draft && (
          <div className="mt-3">
            <SectionCard id="comments" title="Comments" count={commentCount} tone="discussion" {...section("comments")}>
              {p.comments.length === 0 && <p className="m-0 text-ws-ink3">{p.commentsLoading ? "Loading comments…" : "No comments yet."}</p>}
              {p.comments.length > 0 && (
                <ul className="m-0 grid list-none gap-3 p-0">
                  {p.comments.map((c) => (
                    <CommentCard key={c.id} note={c} now={p.now} onReply={p.onReply} onShow={showComment} />
                  ))}
                </ul>
              )}
              {p.composer}
            </SectionCard>
          </div>
        )}

        {!draft && p.history.length > 0 && (
          <SectionCard id="history" title="History" count={p.history.length} {...section("history")}>
            <ul className="m-0 grid list-none gap-2 p-0 text-sm text-ws-ink2">
              {p.history.map((h) => (
                <HistoryRow key={h.id} note={h} now={p.now} />
              ))}
            </ul>
          </SectionCard>
        )}
        {/* The space under the last section, which keeps it clear of Pip's launcher. It is an element, not the scroller's
            padding: a draft card's sticky action bar sticks inside the padding, so padding would hold it up off the bottom. */}
        <div aria-hidden data-peek-end className={`-mt-5 shrink-0 ${draft ? "h-5" : "h-24"}`} />
      </div>
      {draft && <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2.5 border-t-2 border-ws-pip bg-ws-pip-soft px-[22px] py-3 shadow-[0_-6px_16px_rgb(0_0_0/0.06)]">{draft.actions}</div>}
    </aside>
  );
}

function Composer({ item, disabled, reply, onCancelReply }: { item: WorkItem; disabled: boolean; reply: ReplyDraft | null; onCancelReply(): void }) {
  const backend = useBackend();
  const names = useWorkspace((s) => s.names);
  const people = useMemo(() => Object.entries(names).map(([accountId, name]) => ({ accountId, name })), [names]);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  // A draft created before its mentions could be saved; a retry finishes that one instead of making another.
  const created = useRef<string | null>(null);

  useEffect(() => {
    created.current = null;
    setText("");
    setMentions([]);
    setProblem(null);
    setSent(false);
  }, [itemKey(item.item)]);

  useEffect(() => {
    if (!reply) return;
    setText(reply.text);
    setMentions(reply.mentions);
    setSent(false);
    setProblem(null);
    const field = document.getElementById("peek-composer") as HTMLTextAreaElement | null;
    field?.scrollIntoView({ block: "nearest" });
    field?.focus();
    field?.setSelectionRange(reply.text.length, reply.text.length);
  }, [reply]);

  const ready = !!text.trim() && (!reply || text.trim() !== reply.text.trim());

  const submit = async () => {
    if (!backend || !ready || disabled) return;
    setProblem(null);
    try {
      const linked = liveMentions(text, mentions);
      const retry = created.current !== null;
      created.current ??= (await backend.proposalsCreate({ type: "comment", item: item.item, body: docFromText(text) })).id;
      if (retry || linked.length || reply) await backend.proposalsEdit(created.current, { type: "comment", body: text, mentions: linked, ...(reply ? { quote: reply.quote } : {}) });
      created.current = null;
      await useWorkspace.getState().refreshProposals();
      setText("");
      setMentions([]);
      setSent(true);
      onCancelReply();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="min-w-0 rounded-md border border-ws-sep2 bg-ws-win focus-within:border-ws-pip">
      {reply && (
        <div className="flex min-w-0 items-center gap-1.5 px-3 pt-2.5 text-xs text-ws-ink3">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ws-hover py-0.5 pr-1 pl-2">
            <span className="min-w-0 truncate">↩ Replying to <b className="font-semibold text-ws-ink2">{reply.to.who}</b></span>
            <Button variant="quiet" iconOnly size="sm" aria-label="Cancel reply" title="Cancel reply" onClick={onCancelReply} className="!size-4 shrink-0">
              ×
            </Button>
          </span>
        </div>
      )}
      <MentionTextarea
        id="peek-composer"
        value={text}
        mentions={mentions}
        onChange={(v, m) => {
          setText(v);
          setMentions(m);
          setSent(false);
        }}
        onSubmit={() => void submit()}
        ticketKey={item.item.key}
        people={people}
        placeholder={reply ? "Write your reply." : "Write a comment."}
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <span role="status" className="pl-1 text-sm text-ws-ink3">
          {problem ?? (sent ? "Drafted above." : "")}
        </span>
        <Button variant="pip" size="sm" className="ml-auto" disabled={!ready || disabled} onClick={() => void submit()}>
          {reply ? "Draft reply" : "Draft comment"}
        </Button>
      </div>
    </div>
  );
}

interface WorkstreamControlProps {
  workstream: WorkstreamView | null;
  onOpen(): void;
  /** Whether Close is waiting for the person to confirm it. */
  confirmingClose?: boolean;
  /** Asks to close it (true) or takes the question back (false). */
  onAskClose?(ask: boolean): void;
  onClose?(): void;
}

/**
 * Beside Ask Pip: once the ticket has a workstream, its status, a way to its conversation, and Close behind a confirm.
 */
export function WorkstreamControl({ workstream, onOpen, confirmingClose = false, onAskClose, onClose }: WorkstreamControlProps) {
  if (!workstream) return null;
  return (
    <span data-workstream={workstream.workstream.id} className="inline-flex items-center gap-2 rounded-md bg-ws-pip-soft px-2.5 py-0.5 text-sm text-ws-pip">
      <span title={workstream.workstream.title}>
        <span aria-hidden>◆ </span>Workstream · <HeaderStatus view={workstream} inline />
      </span>
      <Button variant="quiet" size="sm" onClick={onOpen}>
        Open in Pip
      </Button>
      {onAskClose &&
        (confirmingClose ? (
          <span
            role="group"
            aria-label="Close this workstream"
            data-esc-local
            className="inline-flex items-center gap-1.5 text-ws-ink2"
            onKeyDown={(ev) => {
              if (ev.key === "Escape") (ev.stopPropagation(), onAskClose(false));
            }}
          >
            Close it? Its agents and drafts are kept in General. {CLOSE_RUNS_NOTE}
            <Button variant="quiet" destructive size="sm" autoFocus onClick={onClose}>
              Close workstream
            </Button>
            <Button variant="quiet" size="sm" onClick={() => onAskClose(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="quiet" size="sm" onClick={() => onAskClose(true)} title={`Close ${workstream.workstream.itemKey ?? "this"} workstream; its conversation goes back to General, and its agents and drafts are kept in General`}>
            Close…
          </Button>
        ))}
    </span>
  );
}

/** Overlays the canvas for the item in `useTabs().selected`, sliding in when it first opens and out when it closes. */
export function PeekSheet() {
  const selected = useTabs((s) => s.selected);
  const bulk = useTabs((s) => s.marked.length > 1);
  const draftId = draftIdOf(selected);
  const draft = useWorkspace((s) => (draftId ? s.proposals[draftId] : undefined));
  const draftShown = showsAsDraftTicket(draft) ? draft : undefined;
  const asItem = useMemo(() => (draftShown ? draftItem(draftShown) : undefined), [draftShown]);
  const current = useWorkspace((s) => (selected && !draftId ? (s.items[selected] ?? s.peeked[selected]?.item) : undefined));
  const peekedKey = useWorkspace((s) => Object.keys(s.peeked)[0]);

  useEffect(() => {
    if (peekedKey && peekedKey !== selected) useWorkspace.getState().clearPeeked();
  }, [peekedKey, selected]);
  const item = bulk ? undefined : (asItem ?? current);

  // A draft that was skipped, went stale or vanished has nothing left to show.
  const gone = !!draftId && !draftShown;
  useEffect(() => {
    if (gone) useTabs.getState().select(null);
  }, [gone]);
  const [held, setHeld] = useState<WorkItem | null>(null);
  const [entering, setEntering] = useState(false);
  const [wide, setWide] = useState(false);

  if (item && held !== item) {
    setHeld(item);
    if (!held) setEntering(true);
  }
  const leaving = !item && held !== null;

  useEffect(() => {
    if (!leaving) return;
    const done = () => {
      setHeld(null);
      setEntering(false);
      setWide(false);
    };
    if (reducedMotion()) {
      done();
      return;
    }
    const timer = setTimeout(done, EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const shown = item ?? held;
  if (!shown) return null;
  const shell = { motion: leaving ? ("out" as const) : entering ? ("in" as const) : ("none" as const), wide, onWide: () => setWide((w) => !w), onMotionEnd: () => setEntering(false) };
  const shownDraft = draftIdOf(shown.item.externalId);
  if (shownDraft) return <DraftSheet key={shown.item.externalId} id={shownDraft} {...shell} />;
  return <OpenPeek key={itemKey(shown.item)} item={shown} {...shell} />;
}

interface Motion {
  motion: "in" | "out" | "none";
  wide: boolean;
  onWide(): void;
  onMotionEnd(): void;
}

function DraftSheet({ id, ...shell }: { id: string } & Motion) {
  const width = usePaneWidths().peek;
  return <LiveDraftPeek proposalId={id} width={width} {...shell} />;
}

/** About two seconds of frames: long enough for the peek to open, short enough that a stale ask doesn't linger. */
const PEEK_FOCUS_FRAMES = 120;

interface PeekFocusable {
  focus(options?: FocusOptions): void;
  hasAttribute?(name: string): boolean;
  setAttribute?(name: string, value: string): void;
  querySelector?(selector: string): unknown;
}

/**
 * Hands the keyboard to the peek of ticket `key` once it shows, as when the palette opens a ticket: its title, so the next
 * Tab is one of the peek's own controls rather than the board's behind it. The title sits at the top of the peek, so it
 * is focused without scrolling anything. Gives up after about two seconds. Returns a cancel.
 */
export function focusPeekOf(key: string, root: { querySelector(selector: string): unknown } = document, frame: (go: () => void) => number = requestAnimationFrame, cancel: (n: number) => void = cancelAnimationFrame): () => void {
  let handle = 0;
  let tries = 0;
  const find = () => {
    const peek = root.querySelector(`#peek-sheet[aria-label="Details for ${key.replace(/["\\]/g, "\\$&")}"]`) as PeekFocusable | null;
    if (peek) {
      const el = (peek.querySelector?.("h2") as PeekFocusable | null) ?? peek;
      if (el.hasAttribute && !el.hasAttribute("tabindex")) el.setAttribute?.("tabindex", "-1");
      return el.focus({ preventScroll: true });
    }
    if (++tries < PEEK_FOCUS_FRAMES) handle = frame(find);
  };
  handle = frame(find);
  return () => cancel(handle);
}

/** Whether Esc belongs to the field `el`, which keeps it while the person types there; Pip's input never does, so Esc from it closes the peek over it. */
export function typingIn(el: Element | null): boolean {
  if (!(typeof HTMLElement !== "undefined" && el instanceof HTMLElement) || el.id === PIP_INPUT_ID) return false;
  return isTypingTarget(el);
}

/** Set as a peek gives way to the next one (j or k) with the keyboard in it, so that one takes the keyboard on. */
let keyboardInPeek = false;

function OpenPeek({ item, motion, wide, onWide, onMotionEnd }: { item: WorkItem } & Motion) {
  const ref = item.item;
  const key = itemKey(ref);
  // Stepping with j and k from inside the peek (as one opened from the palette has the keyboard) swaps it for the next
  // one; the keyboard goes along to it rather than falling to the page.
  useLayoutEffect(() => {
    const carried = keyboardInPeek;
    keyboardInPeek = false;
    const at = document.activeElement;
    if (carried && (!at || at === document.body)) focusPeekOf(ref.key);
    return () => void (keyboardInPeek = !!document.activeElement?.closest("#peek-sheet"));
  }, []);
  const width = usePaneWidths().peek;
  const backend = useBackend();
  const all = useWorkspace((s) => s.items);
  const readOnly = !all[key];
  const containerName = useWorkspace((s) => s.peeked[key]?.containerName ?? null);
  const containers = useWorkspace((s) => s.containers);
  const childFilter = useMemo(() => ({ type: "parent" as const, item: ref }), [key]);
  const children = useItemsByFilter(childFilter);
  const loaded = useWorkspace((s) => s.events[key]);
  const loadedComments = useWorkspace((s) => s.comments[key]);
  const known = useWorkspace((s) => knownMoves(s, item));
  const [movesFailed, setMovesFailed] = useState(false);
  const events = loaded ?? NO_EVENTS;
  const names = useWorkspace((s) => s.names);
  const proposals = useWorkspace((s) => s.proposals);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useMemo(() => new Date(), [item]);
  const agentRuns = useRuns((s) => runsOfTicket(s.runs, ref).length);
  const workstream = useItemWorkstream(ref);
  const confirmingClose = useWorkstreams((s) => s.confirmingClose);

  useEffect(() => {
    void useWorkspace.getState().loadEvents(ref);
    void useWorkspace.getState().loadComments(ref);
    canvasElement(ref)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [key]);

  const wf = workflowOfItem({ containers }, item);
  const opaque = !!wf && movesAreOpaque(wf);
  useEffect(() => {
    setMovesFailed(false);
    let current = true;
    if (opaque) void useWorkspace.getState().loadMoves(item).then((to) => current && setMovesFailed(to === null));
    return () => {
      current = false;
    };
  }, [key, item.status.id, opaque]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || ev.defaultPrevented || usePrefs.getState().paletteOpen) return;
      const field = document.activeElement;
      // A field keeps Esc for itself, except Pip's input: the peek over it closes first, as Esc does from anywhere else,
      // and the next Esc closes Pip.
      if (typingIn(field)) return;
      if (menuOpen) return setMenuOpen(false);
      const inside = !!document.activeElement?.closest("#peek-sheet");
      useTabs.getState().select(null);
      // The keyboard goes to the ticket's card, or to the canvas when the card doesn't take focus (as when the peek was
      // opened from the palette), never nowhere.
      if (inside)
        requestAnimationFrame(() => {
          const card = canvasElement(ref);
          card?.focus();
          if (!card || document.activeElement !== card) document.getElementById("workspace-main")?.focus();
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, menuOpen]);

  const me = useWorkspace((s) => s.me);
  const collapsed = usePrefs((s) => s.peekCollapsed);
  const who = (accountId: string | null) => (accountId === null ? "Unassigned" : displayName(names, accountId));
  const isMine = (accountId: string | null) => accountId !== null && me.some((m) => m.accountId === accountId);
  const jump = (id: PeekSectionId) => {
    usePrefs.getState().setPeekSection(id, false);
    requestAnimationFrame(() => document.getElementById(`peek-${id}`)?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" }));
  };
  const waiting = draftsForItem({ proposals }, ref).reverse();
  // A review posted from here stays, saying it went and linking to it, until the peek closes; it is decided, not waiting.
  const reviewsShown = useRef(new Set<string>());
  waiting.forEach((p) => p.intent.type === "githubReview" && reviewsShown.current.add(p.id));
  const posted = draftsForItem({ proposals }, ref, ["applied"]).filter((p) => reviewsShown.current.has(p.id)).reverse();
  const drafts = [...waiting, ...posted];
  const pendingMove = drafts.find((d) => d.intent.type === "transition");
  const proposedMove = pendingMove ? (draftStatus(pendingMove, wf)?.name ?? pendingMove.label) : null;
  const checking = opaque && known === null && !movesFailed;
  const moves = known && opaque ? known : wf && !checking ? targetsFor(wf, item) : [];

  const comments: Note[] = useMemo(
    () => shownComments(loadedComments, events, (id) => displayName(names, id), isMine),
    [loadedComments, events, names, me],
  );
  const [devCount, setDevCount] = useState<number | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const startReply = (note: Note) => {
    usePrefs.getState().setPeekSection("comments", false);
    setReplyTo(replyDraft(note));
  };
  const description = item.body.blocks.length ? <WorkDocView doc={item.body} /> : <p className="m-0 text-ws-ink3">No description.</p>;

  const move = async (to: StatusDef) => {
    setMenuOpen(false);
    try {
      await useWorkspace.getState().draftTransition(ref, to);
      setNotice(`Drafted ${ref.key} → ${to.name}.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <PeekView
      item={item}
      assignee={who(item.assignee?.accountId ?? null)}
      now={now}
      moves={moves}
      checking={checking}
      menuOpen={menuOpen}
      links={linkRows(item, all)}
      crumb={parentCrumb(item, all)}
      subtasks={subtasksOf(children)}
      proposedMove={proposedMove}
      motion={motion}
      wide={wide}
      width={width}
      onWide={onWide}
      onMotionEnd={onMotionEnd}
      comments={comments}
      commentsLoading={!loadedComments}
      history={historyNotes(events, (id) => displayName(names, id), isMine)}
      collapsed={collapsed}
      onToggleSection={(id) => usePrefs.getState().setPeekSection(id, !collapsed[id])}
      onJump={jump}
      onReply={readOnly ? undefined : startReply}
      development={<Development item={item} collapsed={isCollapsed(collapsed, "development")} onToggle={() => usePrefs.getState().setPeekSection("development", !collapsed.development)} onCount={setDevCount} />}
      developmentCount={devCount}
      description={description}
      banner={readOnly ? <PeekNotice unwatched={!!item.unwatched} containerName={containerName} connectionId={ref.connectionId} containerId={item.container.externalId} /> : undefined}
      drafts={
        drafts.length > 0 ? (
          <SectionCard id="drafts" title="Drafts waiting" count={waiting.length}>
            {drafts.map((p) => (
              <LiveDraftCard key={p.id} proposal={p} jump={false} />
            ))}
          </SectionCard>
        ) : null
      }
      agentMenu={
        !readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="pip"
              data-ask-pip
              onClick={() => (workstream ? focusPip(workstream.workstream.id) : void startFromPeek(ref))}
              title={`Ask Pip about ${ref.key}: it can start agents, and they stay with the ticket`}
            >
              <PipGlyph />
              Ask Pip
            </Button>
            <WorkstreamControl
              workstream={workstream}
              onOpen={() => focusPip(workstream?.workstream.id)}
              confirmingClose={!!workstream && confirmingClose === workstream.workstream.id}
              onAskClose={(ask) => useWorkstreams.getState().askClose(ask && workstream ? workstream.workstream.id : null)}
              onClose={() => workstream && void useWorkstreams.getState().close(workstream.workstream.id)}
            />
          </div>
        ) : undefined
      }
      agents={
        agentRuns > 0 || workstream ? (
          <SectionCard id="agents" title="Agents on this ticket" count={agentRuns}>
            <TicketAgents item={ref} title={item.title} workstream={workstream} />
          </SectionCard>
        ) : undefined
      }
      composer={readOnly ? null : <Composer item={item} disabled={!backend} reply={replyTo} onCancelReply={() => setReplyTo(null)} />}
      notice={notice}
      onMenu={setMenuOpen}
      onMove={(s) => void move(s)}
      onLink={(l) => showMe(l.ref)}
      onOpen={showMe}
      onClose={() => useTabs.getState().select(null)}
    />
  );
}
