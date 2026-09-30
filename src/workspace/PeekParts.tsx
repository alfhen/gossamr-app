import type { ReactNode } from "react";
import { relativeTime } from "../lib/views";
import { initials, type Note, type PeekSectionId, type SectionChip } from "./peekLogic";
import { WorkDocView } from "./WorkDocView";

const ICON: Record<PeekSectionId, ReactNode> = {
  description: <path d="M3 4h10M3 8h10M3 12h6" />,
  links: <path d="M6.5 9.5l3-3M5 7L3.8 8.2a2.4 2.4 0 003.4 3.4L8.4 10.4M11 9l1.2-1.2a2.4 2.4 0 00-3.4-3.4L7.6 5.6" />,
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

export function CountBadge({ count }: { count: number }) {
  return <span className="rounded-full bg-ws-sel px-1.5 text-xs leading-[18px] font-semibold text-ws-ink2 tabular-nums">{count}</span>;
}

export interface SectionCardProps {
  id: PeekSectionId | "subtasks" | "drafts";
  title: string;
  count?: number;
  /** Omit on sections that can't be folded. */
  collapsed?: boolean;
  onToggle?(): void;
  tone?: "plain" | "discussion";
  children: ReactNode;
}

/** A titled region with a header bar that stays under the section nav while its body scrolls. */
export function SectionCard({ id, title, count, collapsed = false, onToggle, tone = "plain", children }: SectionCardProps) {
  const icon = id in ICON ? <SectionIcon id={id as PeekSectionId} /> : null;
  const discussion = tone === "discussion";
  const bar = `sticky top-9 z-[5] flex w-full items-center gap-2 px-3 py-2 text-left ${collapsed ? "rounded-lg" : "rounded-t-lg"} ${
    discussion ? "bg-[linear-gradient(var(--color-ws-accent-soft),var(--color-ws-accent-soft)),linear-gradient(var(--color-ws-win),var(--color-ws-win))] text-ws-accent" : "bg-ws-bar text-ws-ink2"
  }`;
  const label = (
    <>
      {icon}
      <h3 className="m-0 text-xs font-bold tracking-wide text-ws-ink uppercase">{title}</h3>
      {count !== undefined && <CountBadge count={count} />}
    </>
  );
  return (
    <section
      id={`peek-${id}`}
      data-section={id}
      className={`grid rounded-lg border border-ws-sep2 bg-ws-win ${discussion ? "border-l-[3px] border-l-ws-accent" : ""}`}
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
        className={`${collapsed ? "hidden" : "grid"} min-w-0 gap-3 rounded-b-lg p-3 ${discussion ? "bg-ws-bar/60" : ""} ${id === "description" ? "" : "border-t border-ws-sep"}`}
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
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${small ? "size-5 text-[9px]" : "size-7 text-[11px]"} ${mine ? "bg-ws-accent text-ws-win" : "bg-ws-sel text-ws-ink2"}`}
    >
      {initials(name)}
    </span>
  );
}

export function CommentCard({ note, now }: { note: Note; now: Date }) {
  return (
    <li
      data-comment={note.mine ? "mine" : "other"}
      className={`grid min-w-0 gap-2 rounded-md border border-l-[3px] p-3 ${
        note.mine ? "border-ws-sep border-l-ws-accent bg-ws-accent-soft" : "border-ws-sep border-l-ws-sep2 bg-ws-win"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={note.who} mine={note.mine} />
        <b className="min-w-0 truncate text-ws-ink">{note.who}</b>
        {note.mine && <span className="shrink-0 rounded bg-ws-accent px-1.5 text-xs leading-[18px] font-semibold text-ws-win">you</span>}
        <time dateTime={note.at} title={fullDate(note.at)} className="ml-auto shrink-0 text-xs text-ws-ink3">
          {relativeTime(note.at, now)}
        </time>
      </div>
      {note.doc ? (
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
