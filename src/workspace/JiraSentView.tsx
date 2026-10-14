import { useEffect, useMemo, useState } from "react";
import { editedWords, jiraSent, SENT_LABEL, type SentEntry } from "../lib/jiraSent";
import { useWorkspace } from "../workspaceStore";
import { DayHeading, EmptyNote } from "./ActivityView";
import { groupByDay } from "./activityLogic";
import { useAgentsFlag } from "./agentsFlag";
import { useEscToPipHome } from "./escHome";
import { workspaceTicketLinks } from "./jump";
import { useTabs } from "./tabsStore";
import { openOnPipHome, useWorkstreams } from "./workstreamsStore";

const link = "rounded px-1 text-ws-ink2 underline decoration-ws-sep2 underline-offset-2 hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip";

/** What the view says before Gossamr has posted anything. */
export const SENT_EMPTY = "Nothing has been posted to Jira from Gossamr yet. What you approve shows up here, with what Pip drafted and what you changed.";

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
          <button type="button" data-sent-ticket onClick={() => onTicket(e.ticketKey!)} className="rounded font-mono font-semibold text-ws-ink hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
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
      {more && (
        <div className="grid gap-1">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`justify-self-start text-sm ${link}`}>
            {open ? "Show less" : "Show all"}
          </button>
          {open && (
            <div data-sent-detail className="grid gap-0.5 rounded-md bg-ws-bar px-2.5 py-1.5 text-sm text-ws-ink2">
              {e.detail.map((l, i) => (
                <p key={i} className="m-0 whitespace-pre-wrap">
                  {l || " "}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="m-0 flex flex-wrap items-baseline gap-x-1.5 text-xs text-ws-ink3">
        <span data-sent-edited={e.edited ? "yes" : "no"}>{editedWords(e)}</span>
        <span aria-hidden>·</span>
        <span data-sent-from>
          from {e.from}
          {e.workstream && e.workstreamId ? (
            <>
              , in the workstream{" "}
              <button type="button" data-sent-workstream={e.workstreamId} onClick={() => onWorkstream(e.workstreamId!)} className={link}>
                {e.workstream}
              </button>
            </>
          ) : null}
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
  useEscToPipHome(useAgentsFlag((s) => s.enabled));
  const proposals = useWorkspace((s) => s.proposals);
  const open = useWorkstreams((s) => s.list);
  const closed = useWorkstreams((s) => s.closed);
  const events = useWorkstreams((s) => s.events);
  const workstreams = useMemo(() => [...open, ...closed], [open, closed]);
  // The audit says when a draft was approved and in which workstream; read it for every workstream a draft was made in.
  const ids = useMemo(() => [...new Set(Object.values(proposals).flatMap((p) => (p.state.type === "applied" && p.origin.type !== "board" && "workstream" in p.origin && p.origin.workstream ? [p.origin.workstream] : [])))].sort().join(" "), [proposals]);
  useEffect(() => {
    void useWorkstreams.getState().loadClosed();
  }, []);
  useEffect(() => {
    for (const id of ids.split(" ").filter(Boolean)) void useWorkstreams.getState().loadEvents(id);
  }, [ids]);
  const entries = useMemo(() => jiraSent({ proposals: Object.values(proposals), events, workstreams }), [proposals, events, workstreams]);
  const groups = useMemo(() => groupByDay(entries, new Date()), [entries]);
  return (
    <div data-jira-sent className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-ws-sep px-6 py-2.5">
        <button type="button" data-sent-back onClick={() => useTabs.getState().setRoute("pip")} className={`${link} text-sm`}>
          ← Pip home
        </button>
        <h2 className="m-0 text-base font-semibold">What Jira saw from me</h2>
        <p className="m-0 text-sm text-ws-ink3">Everything Gossamr posted to Jira after you approved it. This page only shows it; it posts nothing.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(32px,var(--ws-launcher-clear,0px))]">
        <div className="mx-auto max-w-[780px]">
          {entries.length === 0 ? (
            <EmptyNote>{SENT_EMPTY}</EmptyNote>
          ) : (
            <div role="feed" aria-label="Posted to Jira">
              {groups.map((g) => (
                <section key={g.day} aria-label={g.label}>
                  <DayHeading label={g.label} />
                  {g.entries.map((e) => (
                    <SentRow key={e.id} entry={e} onTicket={(key) => workspaceTicketLinks.open(key)} onWorkstream={(id) => openOnPipHome(id)} />
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
