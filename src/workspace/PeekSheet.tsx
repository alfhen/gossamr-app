import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { MentionTextarea } from "../components/MentionTextarea";
import { docFromText, docText } from "../lib/docs";
import { itemKey } from "../lib/filter";
import { liveMentions, type Mention } from "../lib/mentions";
import { relativeTime } from "../lib/views";
import type { ItemRef, StatusDef, WorkEvent, WorkItem } from "../types";
import { draftsForItem, knownMoves, useItemsByFilter, useWorkspace, workflowOfItem } from "../workspaceStore";
import { draftStatus, movesAreOpaque, targetsFor } from "./boardLogic";
import { PeekResizer, usePaneWidths } from "./PaneResizers";
import { LiveDraftCard } from "./DraftCard";
import { canvasElement, showMe } from "./jump";
import { PEEK_DEFAULT } from "./paneSizes";
import { usePrefs } from "./prefs";
import { CommentCard, HistoryRow, SectionCard, SectionNav } from "./PeekParts";
import { commentNotes, displayName, historyNotes, isCollapsed, linkRows, parentCrumb, sectionChips, subtasksOf, type Collapsed, type Crumb, type LinkRow, type Note, type PeekSectionId, type Subtasks } from "./peekLogic";
import { useTabs } from "./tabsStore";
import { PeekNotice } from "./WatchNotices";
import { WorkDocView } from "./WorkDocView";

const CATEGORY_TONE = {
  todo: "bg-ws-hover text-ws-ink2",
  active: "bg-ws-accent-soft text-ws-accent",
  done: "bg-ws-done-soft text-ws-done",
} as const;

const NO_EVENTS: WorkEvent[] = [];

const EXIT_MS = 160;

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const chip = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-semibold";

export interface PeekViewProps {
  item: WorkItem;
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
}

const MOTION = { in: "ws-peek-in", out: "ws-peek-out", none: "" } as const;

export function PeekView(p: PeekViewProps) {
  const { item } = p;
  const blockedBy = p.links.filter((l) => l.kind === "blockedBy");
  const open = p.onOpen;
  const folded = p.collapsed ?? {};
  const section = (id: PeekSectionId) => ({ collapsed: isCollapsed(folded, id), onToggle: p.onToggleSection ? () => p.onToggleSection!(id) : undefined });
  const commentCount = p.commentsLoading ? item.commentCount : p.comments.length;
  return (
    <aside
      id="peek-sheet"
      aria-label={`Details for ${item.item.key}`}
      onAnimationEnd={(ev) => ev.target === ev.currentTarget && p.onMotionEnd?.()}
      className={`selectable ws-legacy absolute inset-y-0 right-0 z-20 flex flex-col border-l border-ws-sep2 bg-ws-win shadow-[-14px_0_40px_rgb(0_0_0/0.16)] max-w-full motion-safe:transition-[width] motion-safe:duration-200 ws-sized ${
        p.wide ? "w-full" : ""
      } ${MOTION[p.motion ?? "none"]}`}
      style={p.wide ? undefined : { width: p.width ?? PEEK_DEFAULT }}
    >
      {!p.wide && p.onWide && <PeekResizer />}
      <div className="flex shrink-0 items-center gap-2 border-b border-ws-sep px-3.5 py-2">
        <span className="shrink-0 font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
        <span className="min-w-0 truncate text-xs text-ws-ink3">
          peek · <kbd className="font-sans">j</kbd> <kbd className="font-sans">k</kbd> browse · <kbd className="font-sans">esc</kbd> close
        </span>
        {p.onWide && (
          <button
            type="button"
            aria-label={p.wide ? "Shrink details" : "Expand details"}
            aria-pressed={!!p.wide}
            title={p.wide ? "Shrink" : "Expand"}
            onClick={p.onWide}
            className="ml-auto grid size-[26px] place-items-center rounded-md text-[15px] leading-none text-ws-ink3 hover:bg-ws-hover"
          >
            {p.wide ? "⤡" : "⤢"}
          </button>
        )}
        <button
          type="button"
          aria-label="Close details"
          onClick={p.onClose}
          className={`${p.onWide ? "" : "ml-auto "}grid size-[26px] place-items-center rounded-md text-[15px] leading-none text-ws-ink3 hover:bg-ws-hover`}
        >
          ×
        </button>
      </div>
      <div className="grid min-h-0 flex-1 scroll-pt-11 content-start gap-5 overflow-auto px-[22px] pb-24">
        <SectionNav chips={sectionChips({ links: p.links.length, comments: commentCount, history: p.history.length })} onJump={p.onJump} />
        <div className="grid gap-2.5">
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
          <h2 className="m-0 text-[20px] leading-tight font-semibold [overflow-wrap:anywhere]">{item.title}</h2>
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
        </div>

        {p.drafts}

        <SectionCard id="description" title="Description" {...section("description")}>
          <div className="min-w-0 [overflow-wrap:anywhere]">{p.description}</div>
        </SectionCard>

        {p.subtasks && p.subtasks.rows.length > 0 && (
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

        {p.links.length > 0 && (
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

        <div className="mt-3">
          <SectionCard id="comments" title="Comments" count={commentCount} tone="discussion" {...section("comments")}>
            {p.comments.length === 0 && <p className="m-0 text-ws-ink3">{p.commentsLoading ? "Loading comments…" : "No comments yet."}</p>}
            {p.comments.length > 0 && (
              <ul className="m-0 grid list-none gap-3 p-0">
                {p.comments.map((c) => (
                  <CommentCard key={c.id} note={c} now={p.now} />
                ))}
              </ul>
            )}
            {p.composer && <div className="min-w-0 rounded-md border border-ws-sep2 bg-ws-win p-3">{p.composer}</div>}
          </SectionCard>
        </div>

        {p.history.length > 0 && (
          <SectionCard id="history" title="History" count={p.history.length} {...section("history")}>
            <ul className="m-0 grid list-none gap-2 p-0 text-sm text-ws-ink2">
              {p.history.map((h) => (
                <HistoryRow key={h.id} note={h} now={p.now} />
              ))}
            </ul>
          </SectionCard>
        )}
      </div>
    </aside>
  );
}

function Composer({ item, disabled }: { item: WorkItem; disabled: boolean }) {
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

  const submit = async () => {
    if (!backend || !text.trim() || disabled) return;
    setProblem(null);
    try {
      const linked = liveMentions(text, mentions);
      const retry = created.current !== null;
      created.current ??= (await backend.proposalsCreate({ type: "comment", item: item.item, body: docFromText(text) })).id;
      if (retry || linked.length) await backend.proposalsEdit(created.current, { type: "comment", body: text, mentions: linked });
      created.current = null;
      await useWorkspace.getState().refreshProposals();
      setText("");
      setMentions([]);
      setSent(true);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid gap-1.5">
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
        placeholder="Write a comment. It becomes a draft you approve."
        className="rounded-md border border-ws-sep2 bg-ws-win"
      />
      <div className="flex items-center gap-2">
        <span role="status" className="text-sm text-ws-ink3">
          {problem ?? (sent ? "Drafted above. Nothing is posted until you approve." : "")}
        </span>
        <button type="button" disabled={!text.trim() || disabled} onClick={() => void submit()} className="ml-auto rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45">
          Draft comment
        </button>
      </div>
    </div>
  );
}

/** Overlays the canvas for the item in `useTabs().selected`, sliding in when it first opens and out when it closes. */
export function PeekSheet() {
  const selected = useTabs((s) => s.selected);
  const bulk = useTabs((s) => s.marked.length > 1);
  const current = useWorkspace((s) => (selected ? (s.items[selected] ?? s.peeked[selected]?.item) : undefined));
  const peekedKey = useWorkspace((s) => Object.keys(s.peeked)[0]);

  useEffect(() => {
    if (peekedKey && peekedKey !== selected) useWorkspace.getState().clearPeeked();
  }, [peekedKey, selected]);
  const item = bulk ? undefined : current;
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
  return <OpenPeek key={itemKey(shown.item)} item={shown} motion={leaving ? "out" : entering ? "in" : "none"} wide={wide} onWide={() => setWide((w) => !w)} onMotionEnd={() => setEntering(false)} />;
}

interface Motion {
  motion: "in" | "out" | "none";
  wide: boolean;
  onWide(): void;
  onMotionEnd(): void;
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

  const comments: Note[] = loadedComments
    ? loadedComments.map((c) => ({ id: c.id, at: c.created, who: displayName(names, c.author.accountId), text: docText(c.body), doc: c.body, mine: isMine(c.author.accountId) }))
    : commentNotes(events, (id) => displayName(names, id), isMine);
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
      description={description}
      banner={readOnly ? <PeekNotice unwatched={!!item.unwatched} containerName={containerName} connectionId={ref.connectionId} containerId={item.container.externalId} /> : undefined}
      drafts={
        !readOnly && drafts.length > 0 ? (
          <SectionCard id="drafts" title="Drafts waiting" count={drafts.length}>
            {drafts.map((p) => (
              <LiveDraftCard key={p.id} proposal={p} jump={false} />
            ))}
          </SectionCard>
        ) : null
      }
      composer={readOnly ? null : <Composer item={item} disabled={!backend} />}
      notice={notice}
      onMenu={setMenuOpen}
      onMove={(s) => void move(s)}
      onLink={(l) => showMe(l.ref)}
      onOpen={showMe}
      onClose={() => useTabs.getState().select(null)}
    />
  );
}
