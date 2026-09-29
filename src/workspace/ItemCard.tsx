import { useEffect, useRef, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Cobweb } from "../components/Cobweb";
import type { WitherLevel } from "../lib/views";
import type { StatusDef, WorkItem, WorkPriority } from "../types";
import { daysQuiet } from "./boardLogic";

export interface CardDraft {
  id: string;
  /** Where the draft moves the card, as the approve button names it. */
  to: string;
}

export interface ItemCardProps {
  item: WorkItem;
  assignee: string;
  now: Date;
  wither: WitherLevel;
  blocked: boolean;
  draft: CardDraft | null;
  /** Other pending drafts on the item, such as comments, that aren't shown here. */
  moreDrafts: number;
  selected: boolean;
  marked: boolean;
  menuOpen: boolean;
  moveTargets: StatusDef[];
  showStatus?: boolean;
  draggable?: boolean;
  onSelect(how: "one" | "toggle" | "range"): void;
  onMenu(open: boolean): void;
  onMove(to: StatusDef): void;
  onApprove(id: string): void;
  onSkip(id: string): void;
  onDragStart?(ev: DragEvent): void;
  onDragEnd?(): void;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";

const PRIORITY: Partial<Record<WorkPriority, { glyph: string; label: string; tone: string }>> = {
  highest: { glyph: "▲▲", label: "Highest priority", tone: "text-ws-blocked" },
  high: { glyph: "▲", label: "High priority", tone: "text-ws-blocked" },
  low: { glyph: "▽", label: "Low priority", tone: "text-ws-ink3" },
  lowest: { glyph: "▽▽", label: "Lowest priority", tone: "text-ws-ink3" },
};

const chipTone = (level: WitherLevel) => (level >= 4 ? "text-ws-blocked" : level === 3 ? "text-[#d2701f]" : level === 2 ? "text-ws-warn" : "text-ws-ink3");

export const cardId = (key: string) => `card-${key}`;

/** A ticket as a card: shared by the board and the age view. */
export function ItemCard(p: ItemCardProps) {
  const { item } = p;
  const days = daysQuiet(item, p.now);
  const priority = item.priority ? PRIORITY[item.priority] : undefined;
  const shownLabels = item.labels.slice(0, 2);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!p.menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    const away = (ev: Event) => {
      if (!menuRef.current?.parentElement?.contains(ev.target as Node)) p.onMenu(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [p.menuOpen]);

  const click = (ev: MouseEvent) => p.onSelect(ev.shiftKey ? "range" : ev.metaKey || ev.ctrlKey ? "toggle" : "one");

  const key = (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      p.onSelect(ev.shiftKey ? "range" : ev.metaKey || ev.ctrlKey ? "toggle" : "one");
    } else if (ev.key === "m" || ev.key === "ContextMenu") {
      ev.preventDefault();
      p.onMenu(true);
    }
  };

  const menuKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      p.onMenu(false);
      document.getElementById(cardId(item.item.key))?.focus();
      return;
    }
    const step = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };

  const tone = p.draft ? "ws-card-draft" : "";
  const wither = p.wither ? `ws-wither ws-wither-${Math.min(3, p.wither)}` : "";

  return (
    <article
      id={cardId(item.item.key)}
      tabIndex={0}
      aria-label={`${item.item.key} ${item.title}`}
      aria-current={p.selected ? "true" : undefined}
      data-marked={p.marked ? "true" : undefined}
      draggable={p.draggable ?? true}
      onDragStart={p.onDragStart}
      onDragEnd={p.onDragEnd}
      onClick={click}
      onKeyDown={key}
      className={`ws-card group relative cursor-grab rounded-[10px] border bg-ws-win px-2.5 py-2 shadow-sm outline-offset-2 ${tone} ${wither} ${
        p.marked ? "border-ws-pip ring-2 ring-ws-pip ws-card-pick" : p.selected ? "border-ws-pip ring-2 ring-ws-pip-soft ws-card-pick" : "border-ws-sep"
      }`}
    >
      <Cobweb level={p.wither} />
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
        {item.kind === "bug" && <span title="Bug" aria-label="Bug" className="text-[9px] text-ws-blocked">●</span>}
        {priority && (
          <span title={priority.label} role="img" aria-label={priority.label} className={`text-[10px] font-bold ${priority.tone}`}>
            {priority.glyph}
          </span>
        )}
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={p.menuOpen}
          aria-label={`Actions for ${item.item.key}`}
          onClick={(ev) => {
            ev.stopPropagation();
            p.onMenu(!p.menuOpen);
          }}
          className="ml-auto rounded px-1 text-ws-ink3 opacity-0 hover:bg-ws-hover hover:text-ws-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          ⋯
        </button>
      </div>
      <p className="my-1 font-medium">{item.title}</p>
      {item.labels.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1" aria-label="Labels">
          {shownLabels.map((l) => (
            <li key={l} className="rounded-full bg-ws-sel px-1.5 text-xs text-ws-ink2">
              {l}
            </li>
          ))}
          {item.labels.length > shownLabels.length && <li className="text-xs text-ws-ink3">+{item.labels.length - shownLabels.length}</li>}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <span title={p.assignee} className="grid size-[22px] flex-none place-items-center rounded-full bg-ws-sel text-[10px] font-bold text-ws-ink2">
          {initials(p.assignee)}
        </span>
        {p.showStatus && <span className="truncate rounded-full bg-ws-sel px-2 text-xs font-semibold text-ws-ink2">{item.status.name}</span>}
        {p.blocked && <span className="text-xs text-ws-blocked">⛓ blocked</span>}
        {p.moreDrafts > 0 && (
          <span className="text-xs text-ws-pip" title="Drafts waiting on this ticket">
            ✦ {p.moreDrafts}
          </span>
        )}
        {item.status.category !== "done" && days >= 2 && (
          <span className={`ws-age ml-auto text-xs font-semibold ${chipTone(p.wither)}`} title={`No update for ${days} days`}>
            {days}d
          </span>
        )}
      </div>
      {p.draft && <DraftLine draft={p.draft} onApprove={p.onApprove} onSkip={p.onSkip} />}
      {p.marked && <span className="sr-only">Ticked for a bulk action</span>}
      {p.menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${item.item.key}`}
          onKeyDown={menuKey}
          onClick={(ev) => ev.stopPropagation()}
          className="absolute right-1 top-7 z-20 min-w-44 rounded-lg border border-ws-sep2 bg-ws-win py-1 shadow-ws-pop"
        >
          {p.moveTargets.length === 0 && <p className="px-3 py-1 text-ws-ink3">No moves from {item.status.name}</p>}
          {p.moveTargets.map((s) => (
            <MenuButton key={s.id} onClick={() => p.onMove(s)}>
              Move to {s.name}
            </MenuButton>
          ))}
          {p.draft && (
            <>
              <hr className="my-1 border-ws-sep" />
              <MenuButton onClick={() => p.onApprove(p.draft!.id)}>Approve → {p.draft.to}</MenuButton>
              <MenuButton onClick={() => p.onSkip(p.draft!.id)}>Skip the draft</MenuButton>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function MenuButton({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="block w-full px-3 py-1 text-left hover:bg-ws-hover focus-visible:bg-ws-hover">
      {children}
    </button>
  );
}

export function DraftLine({ draft, onApprove, onSkip }: { draft: CardDraft; onApprove(id: string): void; onSkip(id: string): void }) {
  return (
    <div className="mt-1.5 flex items-center text-sm font-semibold text-ws-pip" onClick={(ev) => ev.stopPropagation()}>
      <span>→ {draft.to} (draft)</span>
      <span className="ml-auto flex gap-1">
        <button type="button" aria-label={`Approve move to ${draft.to}`} title="Approve" onClick={() => onApprove(draft.id)} className="rounded border border-ws-pip px-1.5 hover:bg-ws-pip hover:text-ws-on-pip">
          ✓
        </button>
        <button type="button" aria-label={`Skip move to ${draft.to}`} title="Skip" onClick={() => onSkip(draft.id)} className="rounded border border-ws-pip px-1.5 hover:bg-ws-pip hover:text-ws-on-pip">
          ✕
        </button>
      </span>
    </div>
  );
}

/** Where a pending move will land, shown in the target column until it is approved or skipped. */
export function GhostCard({ item, draft, onApprove, onSkip }: { item: WorkItem; draft: CardDraft; onApprove(id: string): void; onSkip(id: string): void }) {
  return (
    <article aria-label={`Draft: ${item.item.key} moves here`} className="rounded-[10px] border-[1.5px] border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-sm font-semibold text-ws-ink2">{item.item.key}</span>
        <span className="ml-auto text-xs font-semibold text-ws-pip">✦ draft move</span>
      </div>
      <p className="my-1 truncate text-ws-ink2">{item.title}</p>
      <DraftLine draft={draft} onApprove={onApprove} onSkip={onSkip} />
    </article>
  );
}
