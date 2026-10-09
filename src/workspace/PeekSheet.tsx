import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { MentionTextarea } from "../components/MentionTextarea";
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
import { canvasElement, showMe } from "./jump";
import { PEEK_DEFAULT } from "./paneSizes";
import { useAgentsEnabled } from "./agentsFlag";
import { usePrefs } from "./prefs";
import { CommentCard, HistoryRow, SectionCard, SectionNav, showComment } from "./PeekParts";
import { displayName, historyNotes, isCollapsed, linkRows, parentCrumb, replyDraft, sectionChips, shownComments, subtasksOf, type Collapsed, type Crumb, type LinkRow, type Note, type PeekSectionId, type ReplyDraft, type Subtasks } from "./peekLogic";
import { AgentMenu, TicketAgents, runsOfTicket } from "./AgentMenu";
import { Development } from "./DevelopmentSection";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { PeekNotice } from "./WatchNotices";
import { WorkDocView } from "./WorkDocView";
import { STAGE_LABEL } from "../lib/workstreamStage";
import { focusPip, useItemWorkstream, useWorkstreams } from "./workstreamsStore";

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
          <button
            type="button"
            aria-label={p.wide ? "Shrink details" : "Expand details"}
            aria-pressed={!!p.wide}
            title={p.wide ? "Shrink" : "Expand"}
            onClick={p.onWide}
            className={`${draft?.nav ? "" : "ml-auto "}grid size-[26px] place-items-center rounded-md text-[15px] leading-none text-ws-ink3 hover:bg-ws-hover`}
          >
            {p.wide ? "⤡" : "⤢"}
          </button>
        )}
        <button
          type="button"
          aria-label="Close details"
          onClick={p.onClose}
          className={`${p.onWide || draft?.nav ? "" : "ml-auto "}grid size-[26px] place-items-center rounded-md text-[15px] leading-none text-ws-ink3 hover:bg-ws-hover`}
        >
          ×
        </button>
      </div>
      <div className={`min-h-0 flex-1 gap-5 overflow-auto px-[22px] ${draft ? "flex flex-col pt-4 pb-5" : "grid content-start scroll-pt-11 pb-24"}`}>
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
          {draft ? draft.title : <h2 className="m-0 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere]">{item.title}</h2>}
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
                  <ul role="menu" aria-label={`Draft a move for ${item.item.key}`} className="absolute top-full left-0 z-30 m-0 mt-1 grid min-w-44 list-none gap-px rounded-lg border border-ws-sep2 bg-ws-win p-1 shadow-ws-pop">
                    <li className="px-2 py-1 text-xs text-ws-ink3">{p.checking ? "Checking where it can move…" : "Draft a move to"}</li>
                    {p.moves.map((s) => (
                      <li key={s.id} role="none">
                        <button type="button" role="menuitem" onClick={() => p.onMove(s)} className="w-full rounded px-2 py-1 text-left hover:bg-ws-hover">
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
              {p.composer && <div className="min-w-0 rounded-md border border-ws-sep2 bg-ws-win p-3">{p.composer}</div>}
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
    <div className="grid gap-1.5">
      {reply && (
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-ws-ink3">
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ws-hover py-0.5 pr-1 pl-2">
            <span className="min-w-0 truncate">↩ Replying to <b className="font-semibold text-ws-ink2">{reply.to.who}</b></span>
            <button type="button" aria-label="Cancel reply" title="Cancel reply" onClick={onCancelReply} className="grid size-4 shrink-0 place-items-center rounded-full leading-none hover:bg-ws-sel">
              ×
            </button>
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
        placeholder={reply ? "Write your reply. It becomes a draft you approve." : "Write a comment. It becomes a draft you approve."}
        className="rounded-md border border-ws-sep2 bg-ws-win"
      />
      <div className="flex items-center gap-2">
        <span role="status" className="text-sm text-ws-ink3">
          {problem ?? (sent ? "Drafted above. Nothing is posted until you approve." : "")}
        </span>
        <button type="button" disabled={!ready || disabled} onClick={() => void submit()} className="ml-auto rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45">
          {reply ? "Draft reply" : "Draft comment"}
        </button>
      </div>
    </div>
  );
}

interface WorkstreamControlProps {
  item: ItemRef;
  workstream: WorkstreamView | null;
  onStart(): void;
  onOpen(): void;
  /** Whether Close is waiting for the person to confirm it. */
  confirmingClose?: boolean;
  /** Asks to close it (true) or takes the question back (false). */
  onAskClose?(ask: boolean): void;
  onClose?(): void;
}

/**
 * Beside the Agent menu: a way to start a workstream on the ticket, or, once it has one, its stage, a way to its
 * conversation, and Close behind a confirm.
 */
export function WorkstreamControl({ item, workstream, onStart, onOpen, confirmingClose = false, onAskClose, onClose }: WorkstreamControlProps) {
  if (!workstream) {
    return (
      <button
        type="button"
        onClick={onStart}
        title={`Give ${item.key} its own conversation with Pip, where its agents and drafts are grouped`}
        className="inline-flex items-center gap-1.5 rounded-md border border-ws-sep2 px-2.5 py-0.5 text-sm font-semibold text-ws-ink2 hover:border-ws-pip hover:text-ws-pip"
      >
        <span aria-hidden>◇</span>
        Start a workstream
      </button>
    );
  }
  return (
    <span data-workstream={workstream.workstream.id} className="inline-flex items-center gap-2 rounded-md bg-ws-pip-soft px-2.5 py-0.5 text-sm text-ws-pip">
      <span title={workstream.workstream.title}>
        <span aria-hidden>◆ </span>Workstream · <b data-stage={workstream.stage}>{STAGE_LABEL[workstream.stage]}</b>
      </span>
      <button type="button" onClick={onOpen} className="font-semibold underline">
        Open in Pip
      </button>
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
            Close it? Its agents and drafts are kept.
            <button type="button" autoFocus onClick={onClose} className="font-semibold text-ws-pip underline">
              Close workstream
            </button>
            <button type="button" onClick={() => onAskClose(false)} className="underline">
              Keep
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => onAskClose(true)} title={`Close ${item.key}'s workstream; its conversation goes back to General, and its agents and drafts are kept`} className="text-ws-ink2 underline">
            Close…
          </button>
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

function OpenPeek({ item, motion, wide, onWide, onMotionEnd }: { item: WorkItem } & Motion) {
  const ref = item.item;
  const key = itemKey(ref);
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
  const agentsOn = useAgentsEnabled();
  const agentRuns = useRuns((s) => (agentsOn ? runsOfTicket(s.runs, ref).length : 0));
  const workstream = useItemWorkstream(agentsOn ? ref : null);
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
      if (field instanceof HTMLElement && (field.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName))) return;
      if (menuOpen) return setMenuOpen(false);
      const inside = !!document.activeElement?.closest("#peek-sheet");
      useTabs.getState().select(null);
      if (inside) requestAnimationFrame(() => (canvasElement(ref) ?? document.getElementById("workspace-main"))?.focus());
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
  const drafts = draftsForItem({ proposals }, ref).reverse();
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
      setNotice(`Drafted ${ref.key} → ${to.name}. Nothing changes until you approve.`);
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
          <SectionCard id="drafts" title="Drafts waiting" count={drafts.length}>
            {drafts.map((p) => (
              <LiveDraftCard key={p.id} proposal={p} jump={false} />
            ))}
          </SectionCard>
        ) : null
      }
      agentMenu={
        agentsOn && !readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <AgentMenu item={ref} />
            <WorkstreamControl
              item={ref}
              workstream={workstream}
              onStart={() => void useWorkstreams.getState().start(ref)}
              onOpen={focusPip}
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
