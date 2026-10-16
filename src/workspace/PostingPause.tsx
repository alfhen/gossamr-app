import { useId } from "react";
import { riskNote, type Risk, type RiskQuotes } from "../lib/riskyText";

const button = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip";
const primary = "rounded-md bg-ws-pip px-3.5 py-1.5 text-sm font-semibold text-ws-on-pip shadow-sm hover:brightness-110 disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip";

/**
 * The pause before posting edited words that would reach everyone or look like a secret: what it found, then the two
 * choices in one group with a short name of its own: the alert is the note itself, and both buttons are described by it. Keep editing is the safe one and the primary
 * button; posting anyway is a plain button beside it. Esc anywhere in it is Keep editing.
 */
/** The group's name: short, so the note is read once as the alert and as each button's description, not a third time on entering. */
export const PAUSE_NAME = "Check before posting";

export function PostingPause({ risks, quote, where, anyway, working, onKeep, onPost }: { risks: readonly Risk[]; quote: RiskQuotes; where?: string; anyway: string; working?: boolean; onKeep(): void; onPost(): void }) {
  const note = useId();
  return (
    <div
      role="group"
      aria-label={PAUSE_NAME}
      data-post-pause={risks.join(" ")}
      className="grid scroll-mb-12 gap-1.5"
      onKeyDown={(ev) => {
        // Esc here is Keep editing, not the peek closing over the unsaved text.
        if (ev.key !== "Escape" || ev.defaultPrevented) return;
        ev.preventDefault();
        ev.stopPropagation();
        onKeep();
      }}
    >
      <p id={note} role="alert" className="m-0 text-sm text-ws-warn">{riskNote(risks, quote, where)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-post-pause-keep aria-describedby={note} onClick={onKeep} className={primary}>
          Keep editing
        </button>
        <button type="button" data-post-pause-anyway aria-describedby={note} disabled={working} onClick={onPost} className={button}>
          {anyway}
        </button>
      </div>
    </div>
  );
}
