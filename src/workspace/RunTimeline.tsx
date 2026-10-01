import { useState } from "react";
import type { RunEvent } from "../types";
import { Icon } from "./AgentIcons";
import { MONO_BLOCK } from "./AgentSheet";
import { timelineIcon, timelineTone, type TimelineTone } from "./runSheetLogic";

const DOT: Record<TimelineTone, string> = {
  plain: "bg-ws-hover text-ws-ink2 border-ws-sep",
  find: "bg-ws-done-soft text-ws-done border-transparent",
  ask: "bg-ws-pip-soft text-ws-pip border-transparent",
  err: "bg-ws-blocked-soft text-ws-blocked border-transparent",
};

/** Minutes after the first line, as the prototype shows them. */
export function offsetText(at: string, first: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(at) - Date.parse(first)) / 60_000));
  return minutes < 60 ? `+${minutes}m` : `+${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function RunTimeline({ events, live }: { events: readonly RunEvent[] | null; live: string | null }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  if (events === null) {
    return (
      <p role="status" className="m-0 text-ws-ink3">
        Loading what it did…
      </p>
    );
  }
  if (events.length === 0 && !live) return <p className="m-0 text-ws-ink3">Nothing recorded yet.</p>;
  const toggle = (seq: number) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  return (
    <ol aria-label="What the agent did" className="m-0 grid list-none p-0">
      {events.map((e) => {
        const expanded = open.has(e.seq);
        const body = (
          <>
            <span>{e.text}</span>
            <span className="ml-1.5 text-xs text-ws-ink3 tabular-nums">{offsetText(e.at, events[0].at)}</span>
            {e.detail && <span className="ml-1.5 text-xs text-ws-ink3">{expanded ? "hide detail" : "detail"}</span>}
          </>
        );
        return (
          <li key={e.seq} className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-2 pb-3 before:absolute before:top-[22px] before:bottom-0 before:left-[10px] before:w-px before:bg-ws-sep2 last:before:hidden">
            <span aria-hidden className={`z-[1] grid size-[22px] place-items-center rounded-full border ${DOT[timelineTone(e.kind)]}`}>
              <Icon name={timelineIcon(e.kind)} className="size-3" />
            </span>
            <div className="min-w-0">
              {e.detail ? (
                <button type="button" aria-expanded={expanded} onClick={() => toggle(e.seq)} className="block w-full rounded text-left outline-offset-2">
                  {body}
                </button>
              ) : (
                <div>{body}</div>
              )}
              {expanded && e.detail && <pre className={`${MONO_BLOCK} mt-1`}>{e.detail}</pre>}
            </div>
          </li>
        );
      })}
      {live && (
        <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
          <span aria-hidden className="grid size-[22px] place-items-center rounded-full bg-ws-accent-soft text-ws-accent">
            <Icon name="retry" className="size-3 animate-spin motion-reduce:animate-none" />
          </span>
          <div className="min-w-0 text-ws-ink2">{live}…</div>
        </li>
      )}
    </ol>
  );
}
