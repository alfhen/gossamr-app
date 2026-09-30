import { useState, type KeyboardEvent } from "react";
import type { SavedView } from "./filters";

/** A one-line name field: Enter commits, Escape cancels. */
export function NameField({ initial, label, onCommit, onCancel }: { initial: string; label: string; onCommit(name: string): void; onCancel(): void }) {
  const [name, setName] = useState(initial);
  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter" && name.trim()) onCommit(name);
    else if (ev.key === "Escape") {
      ev.stopPropagation();
      onCancel();
    }
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={name}
      onChange={(ev) => setName(ev.target.value)}
      onKeyDown={onKeyDown}
      onFocus={(ev) => ev.target.select()}
      className="min-w-0 flex-1 rounded-md border border-ws-sep2 bg-ws-win px-2 py-0.5 text-ws-ink outline-none focus-visible:border-ws-pip"
    />
  );
}

/** "Save view" as a link that turns into a name field in place. */
export function SaveViewInline({ suggested, onSave }: { suggested: string; onSave(name: string): void }) {
  const [editing, setEditing] = useState(false);
  if (!editing)
    return (
      <button type="button" className="shrink-0 text-sm text-ws-ink3 underline hover:text-ws-ink" onClick={() => setEditing(true)}>
        Save view
      </button>
    );
  return (
    <span className="flex w-[300px] shrink-0 items-center gap-1.5">
      <NameField
        label="View name"
        initial={suggested}
        onCancel={() => setEditing(false)}
        onCommit={(name) => {
          onSave(name);
          setEditing(false);
        }}
      />
      <span className="text-xs text-ws-ink3">Enter to save</span>
    </span>
  );
}

const small = "grid size-[22px] shrink-0 place-items-center rounded text-ws-ink3 hover:bg-ws-hover hover:text-ws-ink disabled:opacity-30 disabled:hover:bg-transparent";

export interface SavedViewsPanelProps {
  builtIn: SavedView[];
  saved: SavedView[];
  counts: Record<string, number>;
  /** What to call the current filter if it were saved; null when there is nothing to save. */
  suggested: string | null;
  onOpen(view: SavedView): void;
  onSave(name: string): void;
  onRename(id: string, name: string): void;
  onMove(id: string, step: -1 | 1): void;
  onPin(id: string, pinned: boolean): void;
  onRemove(id: string): void;
}

export function SavedViewsPanel(p: SavedViewsPanelProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const count = (id: string) => (p.counts[id] ? <span className="ml-auto text-xs text-ws-ink3">{p.counts[id]}</span> : null);

  return (
    <div className="grid gap-0.5 p-2">
      <h2 className="m-0 px-2 pt-1 pb-0.5 text-xs font-semibold text-ws-ink3">Views</h2>
      {p.builtIn.map((v) => (
        <button key={v.id} type="button" onClick={() => p.onOpen(v)} className="flex items-center rounded-md px-2 py-1 text-left text-ws-ink2 hover:bg-ws-hover">
          {v.name}
          {count(v.id)}
        </button>
      ))}

      <h2 className="m-0 px-2 pt-2 pb-0.5 text-xs font-semibold text-ws-ink3">Saved</h2>
      {!p.saved.length && <p className="m-0 px-2 py-1 text-sm text-ws-ink3">Filter the board, then save the filter here.</p>}
      <ul className="m-0 grid list-none gap-0.5 p-0" aria-label="Saved views">
        {p.saved.map((v, i) => (
          <li key={v.id} className="group flex items-center gap-0.5 rounded-md hover:bg-ws-hover">
            {renaming === v.id ? (
              <div className="flex flex-1 px-1 py-0.5">
                <NameField
                  label={`Rename ${v.name}`}
                  initial={v.name}
                  onCancel={() => setRenaming(null)}
                  onCommit={(name) => {
                    p.onRename(v.id, name);
                    setRenaming(null);
                  }}
                />
              </div>
            ) : (
              <>
                <button type="button" onClick={() => p.onOpen(v)} className="min-w-0 flex-1 truncate px-2 py-1 text-left text-ws-ink2" title={v.name}>
                  {v.name}
                </button>
                <span className="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <button type="button" aria-label={`Move ${v.name} up`} disabled={i === 0} onClick={() => p.onMove(v.id, -1)} className={small}>
                    <span aria-hidden>↑</span>
                  </button>
                  <button type="button" aria-label={`Move ${v.name} down`} disabled={i === p.saved.length - 1} onClick={() => p.onMove(v.id, 1)} className={small}>
                    <span aria-hidden>↓</span>
                  </button>
                  <button type="button" aria-label={`Rename ${v.name}`} onClick={() => setRenaming(v.id)} className={small}>
                    <span aria-hidden>✎</span>
                  </button>
                  <button type="button" aria-label={`Remove saved view ${v.name}`} onClick={() => p.onRemove(v.id)} className={small}>
                    <span aria-hidden>×</span>
                  </button>
                </span>
                <button
                  type="button"
                  aria-pressed={v.pinned === true}
                  aria-label={v.pinned ? `Unpin ${v.name} from the tabs` : `Pin ${v.name} as a tab`}
                  onClick={() => p.onPin(v.id, !v.pinned)}
                  className={`${small} ${v.pinned ? "text-ws-pip" : ""}`}
                >
                  <span aria-hidden>{v.pinned ? "★" : "☆"}</span>
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-1 border-t border-ws-sep px-1 pt-2">
        {saving && p.suggested !== null ? (
          <div className="flex items-center gap-1.5">
            <NameField
              label="View name"
              initial={p.suggested}
              onCancel={() => setSaving(false)}
              onCommit={(name) => {
                p.onSave(name);
                setSaving(false);
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            disabled={p.suggested === null}
            onClick={() => setSaving(true)}
            className="w-full rounded-md px-1 py-1 text-left font-semibold text-ws-pip hover:bg-ws-hover disabled:text-ws-ink3 disabled:hover:bg-transparent"
          >
            Save current filter as a view
          </button>
        )}
      </div>
    </div>
  );
}
