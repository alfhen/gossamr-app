import { useEffect, useMemo, useRef, useState } from "react";
import { editedWords, jiraSent, SENT_LABEL, type SentEntry } from "../lib/jiraSent";
import { useWorkspace } from "../workspaceStore";
import { DayHeading, EmptyNote } from "./ActivityView";
import { groupByDay } from "./activityLogic";
import { useRuns } from "./runsStore";
import { useEscBack } from "./escBack";
import { workspaceTicketLinks } from "./jump";
import { useTabs } from "./tabsStore";
import { openOnAgents, useWorkstreams } from "./workstreamsStore";

const link = "rounded px-1 text-ws-ink2 underline decoration-ws-sep2 underline-offset-2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip";

/** The workstream button in "Made from …, in the workstream X.": no padding after the name, or the full stop reads as set off by a space (G10). */
const linkBeforeStop = link.replace("px-1", "pl-1");

/** What the view says about GitHub: the reviews Gossamr posts there are not on this page, and where they are. */
export const GITHUB_NOT_LISTED = "GitHub reviews Gossamr posted are not listed here; each shows in its workstream's timeline as “You posted an agent's GitHub review”.";

/** What the view says before Gossamr has posted anything. */
export const SENT_EMPTY = `No posts to Jira from Gossamr are on record here. What you approve shows up here, with what Pip drafted and what you changed.`;

/** What a screen reader hears for a description diff line's two-character marker, which it would read as "plus" or "minus"; context lines say nothing. */
const MARKER_SAID: Record<string, string> = { "+ ": "Added: ", "− ": "Removed: " };

/** One line of the posted text: in a description diff the marker is shown but hidden from a screen reader, which hears "Added: " or "Removed: " in its place (G13). */
export function DetailLine({ line, diff }: { line: string; diff: boolean }) {
  const mark = diff ? line.slice(0, 2) : "";
  if (!diff || (mark !== "+ " && mark !== "− " && mark !== "  ")) return <>{line || " "}</>;
  return (
    <>
      <span aria-hidden>{mark}</span>
      {MARKER_SAID[mark] && <span className="sr-only">{MARKER_SAID[mark]}</span>}
      {line.slice(2) || " "}
    </>
  );
}

const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One thing Jira was written: the ticket, what was posted (its first line, the rest behind a disclosure), where it came from and whether the person changed it. */
export function SentRow({ entry: e, onTicket, onWorkstream }: { entry: SentEntry; onTicket(key: string): void; onWorkstream(id: string): void }) {
  const [open, setOpen] = useState(false);
  // The disclosure is only offered when there is more to see than the summary line says.
  const more = e.detail.length > 1 || (e.detail[0] ?? "") !== e.summary;
  return (
    <article data-sent-entry={e.id} data-sent-kind={e.kind} aria-label={`${e.label ?? SENT_LABEL[e.kind]}${e.ticketKey ? ` on ${e.ticketKey}` : ""}`} className="grid gap-1 border-b border-ws-sep px-2 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {e.ticketKey && (
          <button type="button" data-sent-ticket aria-label={`Open ${e.ticketKey} in Gossamr`} onClick={() => onTicket(e.ticketKey!)} className="rounded font-mono font-semibold text-ws-ink hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
            {e.ticketKey}
          </button>
        )}
        <span data-sent-label className="rounded-full bg-ws-pip-soft px-2 text-xs font-semibold text-ws-pip">
          {e.label ?? SENT_LABEL[e.kind]}
        </span>
        <span className="ml-auto text-xs text-ws-ink3">{time(e.at)}</span>
      </div>
      <p data-sent-summary className="m-0 text-ws-ink">
        {e.summary}
      </p>
      {e.second && (
        <p data-sent-second className="m-0 text-sm text-ws-ink2">
          {e.second}
        </p>
      )}
      {e.masked && (
        <p data-sent-masked className="m-0 text-xs text-ws-ink3">
          Part of this looked like a password, key or token and is hidden here. Jira holds the text as it was posted.
        </p>
      )}
      {more && (
        <div className="grid gap-1">
          <button type="button" aria-expanded={open} aria-label={`${open ? "Show less" : "Show the posted text"}: ${e.summary}`} onClick={() => setOpen(!open)} className={`justify-self-start text-sm ${link}`}>
            {open ? "Show less" : "Show the posted text"}
          </button>
          {open && (
            <div data-sent-detail className="grid gap-0.5 rounded-md bg-ws-bar px-2.5 py-1.5 text-sm text-ws-ink2">
              {e.detail.map((l, i) => (
                <p key={i} className="m-0 whitespace-pre-wrap">
                  <DetailLine line={l} diff={e.kind === "description"} />
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="m-0 flex flex-wrap items-baseline gap-x-1.5 text-xs text-ws-ink3">
        <span data-sent-edited={e.edited ? "yes" : "no"}>{editedWords(e)}.</span>
        <span data-sent-from>
          Made from {e.from}
          {e.workstream && e.workstreamId ? (
            <>
              {", in the workstream "}
              <button type="button" data-sent-workstream={e.workstreamId} aria-label={`Open the workstream ${e.workstream}`} onClick={() => onWorkstream(e.workstreamId!)} className={linkBeforeStop}>
                {e.workstream}
              </button>
              {"."}
            </>
          ) : (
            "."
          )}
        </span>
      </p>
    </article>
  );
}

/**
 * What Jira saw from me: everything Gossamr posted to Jira after the person approved it, newest day first, from the applied
 * drafts and the workstreams' audit (`jiraSent`). It reads and writes nothing else.
 */
export function JiraSentView() {
  useEscBack();
  const title = useRef<HTMLHeadingElement>(null);
  // The page opens from the palette, which gives the keyboard back to what it came from as it closes: a frame later the
  // heading takes it, so a screen reader starts on the page it opened.
  useEffect(() => {
    const frame = requestAnimationFrame(() => title.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const proposals = useWorkspace((s) => s.proposals);
  const open = useWorkstreams((s) => s.list);
  const closed = useWorkstreams((s) => s.closed);
  const events = useWorkstreams((s) => s.events);
  const runs = useRuns((s) => s.runs);
  const workstreams = useMemo(() => [...open, ...closed], [open, closed]);
  // The audit says when a draft was approved and in which workstream; read it for every workstream a draft was made in.
  const ids = useMemo(() => [...new Set(Object.values(proposals).flatMap((p) => (p.state.type === "applied" && p.origin.type !== "board" && "workstream" in p.origin && p.origin.workstream ? [p.origin.workstream] : [])))].sort().join(" "), [proposals]);
  useEffect(() => {
    void useWorkstreams.getState().loadClosed();
  }, []);
  useEffect(() => {
    for (const id of ids.split(" ").filter(Boolean)) void useWorkstreams.getState().loadEvents(id);
  }, [ids]);
  const entries = useMemo(() => jiraSent({ proposals: Object.values(proposals), events, workstreams, runs }), [proposals, events, workstreams, runs]);
  const groups = useMemo(() => groupByDay(entries, new Date()), [entries]);
  return (
    <div data-jira-sent className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-ws-sep px-6 py-2.5">
        <button type="button" data-sent-back onClick={() => useTabs.getState().setRoute("agents")} className={`${link} text-sm`}>
          ← Agents
        </button>
        <h1 ref={title} tabIndex={-1} className="m-0 rounded text-base font-semibold focus-visible:outline-2 focus-visible:outline-ws-pip">What Jira saw from me</h1>
        <p className="m-0 text-sm text-ws-ink3">Everything Gossamr posted to Jira after you approved it. This page only shows it; it posts nothing. {GITHUB_NOT_LISTED} It lists only what Gossamr posted. A Build runs with your Claude settings and could reach Jira on its own; see Agent safety.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(32px,var(--ws-launcher-clear,0px))]">
        <div className="mx-auto max-w-[780px]">
          {entries.length === 0 ? (
            <EmptyNote>{SENT_EMPTY}</EmptyNote>
          ) : (
            <div role="feed" aria-label="Posted to Jira">
              {groups.map((g) => (
                <section key={g.day} aria-label={g.label}>
                  <DayHeading label={g.label} level={2} />
                  {g.entries.map((e) => (
                    <SentRow key={e.id} entry={e} onTicket={(key) => workspaceTicketLinks.open(key)} onWorkstream={(id) => openOnAgents(id)} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
