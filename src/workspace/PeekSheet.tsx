import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBackend } from "../backend/useBackend";
import { MentionTextarea } from "../components/MentionTextarea";
import { docFromText, docText } from "../lib/docs";
import { itemKey } from "../lib/filter";
import { liveMentions, type Mention } from "../lib/mentions";
import { relativeTime } from "../lib/views";
import type { StatusDef, WorkEvent, WorkItem } from "../types";
import { draftsForItem, knownMoves, nameOf, useWorkspace, workflowOfItem } from "../workspaceStore";
import { daysQuiet, movesAreOpaque, targetsFor } from "./boardLogic";
import { LiveDraftCard } from "./DraftCard";
import { canvasElement, showMe } from "./jump";
import { usePrefs } from "./prefs";
import { commentNotes, historyNotes, linkRows, type LinkRow, type Note } from "./peekLogic";
import { useTabs } from "./tabsStore";
import { WorkDocView } from "./WorkDocView";

const CATEGORY_TONE = {
  todo: "bg-ws-hover text-ws-ink2",
  active: "bg-ws-accent-soft text-ws-accent",
  done: "bg-ws-done-soft text-ws-done",
} as const;

const NO_EVENTS: WorkEvent[] = [];

const chip = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-semibold";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

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
  onClose(): void;
}

export function PeekView(p: PeekViewProps) {
  const { item } = p;
  const days = daysQuiet(item, p.now);
  return (
    <aside
      id="peek-sheet"
      aria-label={`Details for ${item.item.key}`}
      className="ws-legacy absolute inset-y-0 right-0 z-20 flex w-[min(460px,94%)] flex-col border-l border-ws-sep2 bg-ws-win shadow-[-14px_0_40px_rgb(0_0_0/0.16)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-ws-sep px-4 py-2">
        <span className="font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
        <span className="text-xs text-ws-ink3">
          <kbd className="font-sans">Esc</kbd> to close
        </span>
        <button type="button" aria-label="Close details" onClick={p.onClose} className="ml-auto rounded px-1.5 text-lg leading-none text-ws-ink3 hover:bg-ws-hover">
          ×
        </button>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-auto px-4 pt-4 pb-6">
        <div className="grid gap-2.5">
          <h2 className="m-0 text-xl leading-tight font-semibold [overflow-wrap:anywhere]">{item.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
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
            <span className={`${chip} bg-ws-hover font-normal text-ws-ink2`}>{p.assignee}</span>
            {item.priority && <span className={`${chip} bg-ws-hover font-normal text-ws-ink2`}>{item.priority}</span>}
            {item.labels.map((l) => (
              <span key={l} className={`${chip} bg-ws-accent-soft font-normal text-ws-accent`}>
                {l}
              </span>
            ))}
            <span className="ml-auto text-sm text-ws-ink3" title={`Last updated ${new Date(item.updated).toLocaleString()}`}>
              {days === 0 ? "Updated today" : `${days} day${days === 1 ? "" : "s"} quiet`}
            </span>
          </div>
          {p.notice && (
            <p role="status" className="m-0 text-sm text-ws-ink2">
              {p.notice}
            </p>
          )}
        </div>

        {p.drafts}

        <Section title="Description">{p.description}</Section>

        {p.links.length > 0 && (
          <Section title="Links" count={p.links.length}>
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
          </Section>
        )}

        <Section title="Comments" count={item.commentCount}>
          {p.comments.length === 0 && <p className="m-0 text-ws-ink3">{p.commentsLoading ? "Loading comments…" : "No comments yet."}</p>}
          <ul className="m-0 grid list-none gap-3 p-0">
            {p.comments.map((c) => (
              <li key={c.id} className="grid gap-0.5">
                <div className="text-sm text-ws-ink3">
                  <b className="text-ws-ink2">{c.who}</b> · {relativeTime(c.at, p.now)}
                </div>
                {c.doc ? (
                  <div className="[overflow-wrap:anywhere]">
                    <WorkDocView doc={c.doc} />
                  </div>
                ) : (
                  <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text}</p>
                )}
              </li>
            ))}
          </ul>
          {p.composer}
        </Section>

        {p.history.length > 0 && (
          <Section title="History">
            <ul className="m-0 grid list-none gap-1 p-0 text-sm text-ws-ink2">
              {p.history.map((h) => (
                <li key={h.id}>
                  <b>{h.who}</b> {h.text} <span className="text-ws-ink3">· {relativeTime(h.at, p.now)}</span>
                </li>
              ))}
            </ul>
          </Section>
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

/** Overlays the canvas for the item in `useTabs().selected`. */
export function PeekSheet() {
  const selected = useTabs((s) => s.selected);
  const bulk = useTabs((s) => s.marked.length > 1);
  const item = useWorkspace((s) => (selected ? s.items[selected] : undefined));
  if (!item || bulk) return null;
  return <OpenPeek key={itemKey(item.item)} item={item} />;
}

function OpenPeek({ item }: { item: WorkItem }) {
  const ref = item.item;
  const key = itemKey(ref);
  const backend = useBackend();
  const all = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
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
    if (opaque) void useWorkspace.getState().loadMoves(item).then((to) => setMovesFailed(to === null));
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

  const who = (accountId: string | null) => nameOf({ names }, accountId ? { connectionId: ref.connectionId, accountId } : null);
  const drafts = draftsForItem({ proposals }, ref).reverse();
  const checking = opaque && known === null && !movesFailed;
  const moves = known && opaque ? known : wf && !checking ? targetsFor(wf, item) : [];

  const comments: Note[] = loadedComments
    ? loadedComments.map((c) => ({ id: c.id, at: c.created, who: who(c.author.accountId), text: docText(c.body), doc: c.body }))
    : commentNotes(events, who);
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
      comments={comments}
      commentsLoading={!loadedComments}
      history={historyNotes(events, who)}
      description={description}
      drafts={
        drafts.length > 0 ? (
          <Section title="Drafts waiting" count={drafts.length}>
            {drafts.map((p) => (
              <LiveDraftCard key={p.id} proposal={p} jump={false} />
            ))}
          </Section>
        ) : null
      }
      composer={<Composer item={item} disabled={!backend} />}
      notice={notice}
      onMenu={setMenuOpen}
      onMove={(s) => void move(s)}
      onLink={(l) => showMe(l.ref)}
      onClose={() => useTabs.getState().select(null)}
    />
  );
}
