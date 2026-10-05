import { useState, type KeyboardEvent, type ReactNode } from "react";
import { relativeTime } from "../lib/views";
import { initials, type Note, type ReplyInfo, type PeekSectionId, type SectionChip } from "./peekLogic";
import { WorkDocView } from "./WorkDocView";

const ICON: Record<PeekSectionId, ReactNode> = {
  description: <path d="M3 4h10M3 8h10M3 12h6" />,
  links: <path d="M6.5 9.5l3-3M5 7L3.8 8.2a2.4 2.4 0 003.4 3.4L8.4 10.4M11 9l1.2-1.2a2.4 2.4 0 00-3.4-3.4L7.6 5.6" />,
  development: <path d="M5 3.5v9M11 6.5c0 3-3 2.5-6 4.5M5 3.5a1.3 1.3 0 100 .01M5 12.5a1.3 1.3 0 100 .01M11 5.2a1.3 1.3 0 100 .01" />,
  comments: <path d="M3 3.5h10v7H8.2L5.5 13v-2.5H3z" />,
  history: <path d="M8 3.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM8 5.8V8l1.6 1" />,
};

export function SectionIcon({ id }: { id: PeekSectionId }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {ICON[id]}
    </svg>
  );
}

const fullDate = (iso: string) => new Date(iso).toLocaleString();

export function CountBadge({ count, accent = false }: { count: number; accent?: boolean }) {
  return <span className={`rounded-full px-1.5 text-xs leading-[18px] font-semibold tabular-nums ${accent ? "bg-ws-accent-soft text-ws-accent" : "bg-ws-sel text-ws-ink2"}`}>{count}</span>;
}

export interface SectionCardProps {
  id: PeekSectionId | "subtasks" | "drafts" | "agents";
  title: string;
  count?: number;
  /** Omit on sections that can't be folded. */
  collapsed?: boolean;
  onToggle?(): void;
  tone?: "plain" | "discussion";
  /** Takes the height the sheet has left, for a body that should use it. */
  fill?: boolean;
  children: ReactNode;
}

/** A titled region with a header bar that stays under the section nav while its body scrolls. */
export function SectionCard({ id, title, count, collapsed = false, onToggle, tone = "plain", fill = false, children }: SectionCardProps) {
  const icon = id in ICON ? <SectionIcon id={id as PeekSectionId} /> : null;
  const bar = `sticky top-9 z-[5] flex w-full items-center gap-2 bg-ws-bar px-3 py-2 text-left text-ws-ink2 ${collapsed ? "rounded-lg" : "rounded-t-lg"}`;
  const label = (
    <>
      {icon}
      <h3 className="m-0 text-xs font-bold tracking-wide text-ws-ink uppercase">{title}</h3>
      {count !== undefined && <CountBadge count={count} accent={tone === "discussion"} />}
    </>
  );
  return (
    <section
      id={`peek-${id}`}
      data-section={id}
      className={`grid rounded-lg border border-ws-sep2 bg-ws-win ${fill ? "min-h-64 shrink-0 grow grid-rows-[auto_1fr]" : ""}`}
    >
      {onToggle ? (
        <button type="button" aria-expanded={!collapsed} aria-controls={`peek-${id}-body`} onClick={onToggle} className={`${bar} hover:brightness-95`}>
          {label}
          <svg aria-hidden viewBox="0 0 16 16" className={`ml-auto size-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      ) : (
        <div className={bar}>{label}</div>
      )}
      <div
        id={`peek-${id}-body`}
        hidden={collapsed}
        className={`${collapsed ? "hidden" : "grid"} min-w-0 gap-3 rounded-b-lg p-3 ${id === "description" ? "" : "border-t border-ws-sep"}`}
      >
        {children}
      </div>
    </section>
  );
}

export function SectionNav({ chips, onJump }: { chips: SectionChip[]; onJump?(id: PeekSectionId): void }) {
  return (
    <nav aria-label="Sections" className="sticky top-0 z-10 -mx-[22px] flex h-9 items-center gap-1.5 overflow-x-auto border-b border-ws-sep2 bg-ws-win px-[22px]">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onJump?.(c.id)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-sm font-semibold hover:bg-ws-hover ${c.id === "comments" ? "text-ws-accent" : "text-ws-ink2"}`}
        >
          <SectionIcon id={c.id} />
          {c.title}
          {c.count !== undefined && <CountBadge count={c.count} />}
        </button>
      ))}
    </nav>
  );
}

export function Avatar({ name, mine = false, small = false }: { name: string; mine?: boolean; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${small ? "size-5 text-[9px]" : "size-7 text-[11px]"} ${mine ? "bg-ws-accent-soft text-ws-accent" : "bg-ws-sel text-ws-ink2"}`}
    >
      {initials(name)}
    </span>
  );
}

const HIGHLIGHT = ["ring-2", "ring-ws-accent/40"];

/** Scrolls to a comment card and outlines it for a moment. */
export function showComment(id: string) {
  const el = document.getElementById(commentDomId(id));
  if (!el) return;
  const calm = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  el.classList.add(...HIGHLIGHT);
  setTimeout(() => el.classList.remove(...HIGHLIGHT), 1400);
}

export const commentDomId = (id: string) => `comment-${id}`;

const LONG_QUOTE = 110;

function ReplyQuote({ reply, onShow }: { reply: ReplyInfo; onShow?(id: string): void }) {
  const [open, setOpen] = useState(false);
  const long = reply.quote.length > LONG_QUOTE;
  const who = reply.replyingTo;
  return (
    <div className="grid min-w-0 gap-1 text-xs text-ws-ink3">
      <p className="m-0 min-w-0 [overflow-wrap:anywhere]">
        <span aria-hidden>↩ </span>
        {reply.targetId && onShow ? (
          <button type="button" onClick={() => onShow(reply.targetId!)} title="Show the comment this answers" className="text-left hover:text-ws-ink2 hover:underline">
            replying to <b className="font-semibold">{who ?? "a comment"}</b>
          </button>
        ) : (
          <span>
            replying to <b className="font-semibold">{who ?? "a comment"}</b>
          </span>
        )}
      </p>
      <blockquote data-reply-quote className={`m-0 min-w-0 text-sm [overflow-wrap:anywhere] ${open ? "" : "line-clamp-2"}`}>
        {reply.quote}
      </blockquote>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="justify-self-start text-xs font-semibold text-ws-ink2 hover:underline">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export interface CommentCardProps {
  note: Note;
  now: Date;
  onReply?(note: Note): void;
  /** Scrolls to an earlier comment; omitted where there is nothing to scroll. */
  onShow?(id: string): void;
}

export const REPLY_KEY = "r";

export function CommentCard({ note, now, onReply, onShow }: CommentCardProps) {
  const reply = note.reply;
  const onKey = (ev: KeyboardEvent<HTMLLIElement>) => {
    if (!onReply || ev.key.toLowerCase() !== REPLY_KEY || ev.metaKey || ev.ctrlKey || ev.altKey || ev.defaultPrevented) return;
    if (ev.target instanceof HTMLElement && (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName))) return;
    ev.preventDefault();
    ev.stopPropagation();
    onReply(note);
  };
  return (
    <li
      id={commentDomId(note.id)}
      data-comment={note.mine ? "mine" : "other"}
      data-reply={reply ? "true" : undefined}
      tabIndex={onReply ? 0 : undefined}
      onKeyDown={onKey}
      className={`group grid min-w-0 scroll-mt-24 gap-2 rounded-md border border-ws-sep bg-ws-bar/40 p-3 transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ws-accent/40 ${
        reply ? "border-l-2 border-l-ws-accent/50" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={note.who} mine={note.mine} small />
        <b className="min-w-0 truncate text-ws-ink">{note.who}</b>
        {note.mine && <span className="shrink-0 text-xs font-semibold text-ws-accent">you</span>}
        <time dateTime={note.at} title={fullDate(note.at)} className="shrink-0 text-xs text-ws-ink3">
          {relativeTime(note.at, now)}
        </time>
        {onReply && (
          <button
            type="button"
            onClick={() => onReply(note)}
            title={`Reply to ${note.who} (press ${REPLY_KEY.toUpperCase()} on this comment)`}
            aria-label={`Reply to ${note.who}`}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold text-ws-ink3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-ws-hover hover:text-ws-ink2 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <span aria-hidden>↩ </span>Reply
          </button>
        )}
      </div>
      {reply && <ReplyQuote reply={reply} onShow={onShow} />}
      {reply ? (
        reply.body.blocks.length > 0 && (
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <WorkDocView doc={reply.body} />
          </div>
        )
      ) : note.doc ? (
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <WorkDocView doc={note.doc} />
        </div>
      ) : (
        <p className="m-0 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.text}</p>
      )}
    </li>
  );
}

export function HistoryRow({ note, now }: { note: Note; now: Date }) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Avatar name={note.who} mine={note.mine} small />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <b className="text-ws-ink">{note.who}</b> {note.text}{" "}
        <time dateTime={note.at} title={fullDate(note.at)} className="text-ws-ink3">
          · {relativeTime(note.at, now)}
        </time>
      </span>
    </li>
  );
}
