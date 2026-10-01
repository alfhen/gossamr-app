import { useEffect, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { usePopover } from "./Popover";

export interface ColumnReorder {
  at: number;
  count: number;
  /** Whether a saved order exists to reset. */
  custom: boolean;
  onMove(to: number): void;
  onReset(): void;
  onDragStart(ev: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
}

/** The grip that drags a column, and its menu: Alt with the left and right arrows moves the column from the keyboard. */
export function ColumnGrip({ id, name, reorder }: { id: string; name: string; reorder: ColumnReorder }) {
  const { open, setOpen, root } = usePopover();
  const { at, count } = reorder;

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, [open, root]);

  const key = (ev: KeyboardEvent) => {
    if (!ev.altKey || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
    ev.preventDefault();
    ev.stopPropagation();
    reorder.onMove(at + (ev.key === "ArrowLeft" ? -1 : 1));
  };

  const menuKey = (ev: KeyboardEvent) => {
    const step = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const now = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(now + step + buttons.length) % buttons.length]?.focus();
  };

  const pick = (run: () => void) => () => {
    setOpen(false);
    root.current?.querySelector<HTMLElement>("[data-popover-trigger]")?.focus();
    run();
  };

  return (
    <div ref={root} className="relative -ml-1 mr-0.5 flex-none">
      <button
        type="button"
        draggable
        data-popover-trigger
        data-column-grip
        data-column={id}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name} column, position ${at + 1} of ${count}. Drag to reorder, or Alt with the arrow keys.`}
        title="Drag to reorder"
        onClick={() => setOpen(!open)}
        onKeyDown={key}
        onDragStart={reorder.onDragStart}
        onDragEnd={reorder.onDragEnd}
        className="grid h-5 w-4 cursor-grab place-items-center rounded text-ws-ink3 opacity-60 hover:bg-ws-hover hover:text-ws-ink hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
      >
        <svg aria-hidden width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
          {[1.5, 6, 10.5].flatMap((y) => [1.5, 6.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />))}
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={`${name} column`} onKeyDown={menuKey} className="absolute left-0 top-6 z-20 min-w-44 rounded-lg border border-ws-sep2 bg-ws-win py-1 text-sm font-normal text-ws-ink shadow-ws-pop">
          <Item disabled={at === 0} onClick={pick(() => reorder.onMove(at - 1))}>
            Move left
          </Item>
          <Item disabled={at === count - 1} onClick={pick(() => reorder.onMove(at + 1))}>
            Move right
          </Item>
          <hr className="my-1 border-ws-sep" />
          <Item disabled={!reorder.custom} onClick={pick(reorder.onReset)}>
            Reset column order
          </Item>
        </div>
      )}
    </div>
  );
}

function Item({ disabled, onClick, children }: { disabled: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="block w-full px-3 py-1 text-left hover:bg-ws-hover focus-visible:bg-ws-hover disabled:text-ws-ink3 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}
