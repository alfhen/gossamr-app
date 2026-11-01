import { useEffect, type KeyboardEvent } from "react";
import { Button } from "../components/Button";
import { ADD_GROUPS, type AddEntry, type AddEntryId } from "./connectionsLogic";
import { usePopover } from "./Popover";

export interface AddMenuProps {
  entries: readonly AddEntry[];
  /** Primary while no GitHub or Jira connection exists yet. */
  primary: boolean;
  onAdd(id: AddEntryId): void;
}

const itemsOf = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));

export function AddMenu({ entries, primary, onAdd }: AddMenuProps) {
  const { open, setOpen, root } = usePopover();
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, root]);
  if (entries.length === 0) return null;
  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(ev.key)) return;
    ev.preventDefault();
    const items = itemsOf(ev.currentTarget);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = ev.key === "Home" ? 0 : ev.key === "End" ? items.length - 1 : (at + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[to]?.focus();
  };
  return (
    <div ref={root} className="relative">
      <Button variant={primary ? "primary" : "secondary"} size="sm" aria-haspopup="menu" aria-expanded={open} data-popover-trigger onClick={() => setOpen(!open)}>
        + Add
      </Button>
      {open && (
        <div role="menu" aria-label="Add a connection" onKeyDown={onKeyDown} className="absolute top-full right-0 z-40 mt-1 w-[280px] rounded-xl border border-ws-sep2 bg-ws-win py-1 text-sm text-ws-ink shadow-ws-pop">
          {ADD_GROUPS.map((group) => {
            const rows = entries.filter((e) => e.group === group);
            if (rows.length === 0) return null;
            return (
              <div key={group} role="group" aria-label={group}>
                <div aria-hidden className="px-3 pt-2 pb-1 text-sm font-semibold text-ws-ink2">
                  {group}
                </div>
                {rows.map((e) => (
                  <button key={e.id} type="button" role="menuitem" onClick={() => (setOpen(false), onAdd(e.id))} className="block w-full px-3 py-1.5 text-left ws-glass-item">
                    <span className="block font-semibold">{e.label}</span>
                    <span className="block text-ws-ink2">{e.line}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
