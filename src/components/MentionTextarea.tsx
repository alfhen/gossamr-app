import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeQuery, insertMention, rankPeople, segments, type ActiveQuery, type Mention } from "../lib/mentions";
import { useStore } from "../store";
import type { Person } from "../types";
import { Avatar } from "./primitives";

const SEARCH_DELAY_MS = 150;

/**
 * A textarea that suggests people after `@`, and highlights the mentions it holds. The highlight is a mirror div
 * behind a transparent-background textarea, so the text itself stays native (selection, spellcheck, IME, undo).
 */
export function MentionTextarea({
  id,
  value,
  mentions,
  onChange,
  ticketKey,
  people,
  placeholder,
  onSubmit,
  disabled,
  className = "",
}: {
  id: string;
  value: string;
  mentions: Mention[];
  onChange: (value: string, mentions: Mention[]) => void;
  ticketKey: string;
  /** People on the ticket, suggested first. */
  people: Person[];
  placeholder?: string;
  onSubmit?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const backend = useStore((s) => s.backend);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [query, setQuery] = useState<ActiveQuery | null>(null);
  // Tagged with its ticket, so people found for one ticket are never offered on another.
  const [remote, setRemote] = useState<{ ticketKey: string; people: Person[] }>({ ticketKey, people: [] });
  const [index, setIndex] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const suggestions = useMemo(() => {
    if (!query) return [];
    const found = remote.ticketKey === ticketKey ? remote.people : [];
    return rankPeople([...people, ...found], query.query);
  }, [query, people, remote, ticketKey]);
  const open = !!query && suggestions.length > 0;

  useEffect(() => {
    if (!query || !backend || query.query.length === 0) return setRemote({ ticketKey, people: [] });
    let live = true;
    const t = setTimeout(() => {
      backend
        .mentionable(ticketKey, query.query)
        .then((found) => live && setRemote({ ticketKey, people: found }))
        .catch(() => live && setRemote({ ticketKey, people: [] }));
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query?.query, ticketKey, backend]);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !ref.current) return setPos(null);
    const a = anchor.current;
    setPos({ left: a.offsetLeft, top: a.offsetTop - ref.current.scrollTop + a.offsetHeight + 4 });
  }, [open, query?.start, value]);

  useEffect(() => setIndex(0), [query?.query]);

  const track = (el: HTMLTextAreaElement) => setQuery(activeQuery(el.value, el.selectionStart));

  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const pick = (p: Person) => {
    if (!query) return;
    // The query ends where it was typed; the live caret may have moved since (e.g. a mouse pick after a click).
    const end = query.start + 1 + query.query.length;
    const next = insertMention(value, query, end, p);
    const mention = { accountId: p.accountId, name: p.name };
    pendingCaret.current = next.caret;
    onChange(next.text, [...mentions.filter((m) => m.accountId !== p.accountId), mention]);
    setQuery(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[index]);
        return;
      }
      if (e.key === "Escape") {
        // Close the list without also blurring the field through the global Esc handler.
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        setQuery(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSubmit?.();
    }
  };

  const parts = segments(value, mentions);
  // Shared by the mirror and the textarea: any difference in box metrics makes the highlights drift.
  const box = "px-3 py-2.5 font-[inherit] text-base leading-[1.45] whitespace-pre-wrap break-words";

  return (
    <div className={`relative ${className}`}>
      <div ref={mirror} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden text-transparent ${box}`}>
        {renderMirror(parts, query?.start ?? null, anchor)}
        {"​"}
      </div>
      <textarea
        ref={ref}
        id={id}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value, mentions);
          track(e.target);
        }}
        onSelect={(e) => track(e.currentTarget)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-people`}
        aria-autocomplete="list"
        className={`relative block min-h-[62px] w-full resize-y bg-transparent outline-none ${box}`}
      />
      {open && pos && (
        <ul
          id={`${id}-people`}
          role="listbox"
          style={{ left: Math.min(pos.left, (ref.current?.clientWidth ?? 300) - 240), top: pos.top }}
          className="absolute z-50 grid w-[240px] rounded-[10px] border border-sep-strong bg-pop p-1 shadow-pop"
        >
          {suggestions.map((p, i) => (
            <li
              key={p.accountId}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseEnter={() => setIndex(i)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 aria-selected:bg-accent aria-selected:text-white"
            >
              <Avatar person={p} />
              <span className="truncate">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function renderMirror(parts: ReturnType<typeof segments>, queryStart: number | null, anchor: React.RefObject<HTMLSpanElement | null>) {
  let offset = 0;
  return parts.map((part, i) => {
    const start = offset;
    offset += part.text.length;
    if (part.mention) {
      return (
        <mark key={i} className="rounded-[4px] bg-accent-soft text-transparent shadow-[0_0_0_1px_var(--color-accent-soft)]">
          {part.text}
        </mark>
      );
    }
    if (queryStart !== null && queryStart >= start && queryStart < offset) {
      const cut = queryStart - start;
      return (
        <span key={i}>
          {part.text.slice(0, cut)}
          <span ref={anchor}>@</span>
          {part.text.slice(cut + 1)}
        </span>
      );
    }
    return <span key={i}>{part.text}</span>;
  });
}
