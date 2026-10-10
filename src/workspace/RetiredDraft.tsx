import { useState, type ReactNode } from "react";
import type { Proposal } from "../types";

/** Brings the draft `id` into view and gives it the keyboard, wherever it shows on screen. */
export function showNewerDraft(id: string) {
  const card = document.querySelector<HTMLElement>(`[data-draft="${id.replace(/["\\]/g, "\\$&")}"]`);
  card?.scrollIntoView?.({ block: "nearest" });
  card?.focus();
}

/**
 * A retired draft, collapsed to one line saying how it stands and why, with a disclosure for the whole card (`children`).
 * One a newer draft of the same kind replaced offers to show that one.
 */
export function RetiredDraft({ proposal: p, title, state, children, initialOpen = false }: { proposal: Proposal; title: string; state: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const reason = p.state.type === "retired" ? p.state.reason : "";
  const body = `retired-draft-${p.id}`;
  return (
    <section aria-label={`${title}, ${state.toLowerCase()}`} data-retired-draft={p.id} data-superseded-by={p.supersededBy ?? undefined} data-open={open || undefined} className="grid gap-1">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-ws-sep px-2.5 py-1 text-sm text-ws-ink3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 items-center gap-1.5 rounded text-left hover:text-ws-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
        >
          <span aria-hidden className="text-xs">
            {open ? "▾" : "▸"}
          </span>
          <span className="shrink-0 font-semibold text-ws-ink2">{title}</span>
          <span data-retired-line className="min-w-0 truncate">
            {`${state} · ${reason}`}
          </span>
        </button>
        {p.supersededBy && (
          <button type="button" onClick={() => showNewerDraft(p.supersededBy!)} className="ml-auto shrink-0 rounded font-semibold text-ws-pip hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip">
            Show the newer draft
          </button>
        )}
      </div>
      <div id={body} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
