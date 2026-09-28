import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  key: string;
  label: ReactNode;
  hint?: ReactNode;
  onPick: () => void;
}

export function Menu({
  title,
  anchor,
  items,
  onClose,
  loading,
}: {
  title: string;
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  loading?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, r.left)), top: r.bottom + 6 });
  }, [anchor, items.length]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [items.length]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const buttons = [...(ref.current?.querySelectorAll("button") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Escape") {
      onClose();
    } else if (/^[1-9]$/.test(e.key) && buttons[+e.key - 1]) {
      e.preventDefault();
      buttons[+e.key - 1].click();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      style={pos}
      className="fixed z-50 grid min-w-[230px] rounded-[10px] border border-sep-strong bg-pop p-1.5 shadow-pop"
    >
      <div className="px-2 pt-1 pb-1 text-xs font-semibold text-ink-3">{title}</div>
      {loading && <div className="px-2 py-1.5 text-ink-3">Loading…</div>}
      {!loading && items.length === 0 && <div className="px-2 py-1.5 text-ink-3">Nothing available</div>}
      {items.map((item, i) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.onPick();
          }}
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent hover:text-white focus:bg-accent focus:text-white"
        >
          {item.label}
          <span className="ml-auto flex items-center gap-2 text-[11.5px] opacity-70">
            {item.hint}
            <span className="font-mono">{i + 1}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
