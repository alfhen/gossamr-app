import { useMemo, useState } from "react";
import { itemKey } from "../lib/filter";
import { targetOf } from "../lib/proposals";
import type { ItemRef, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { LiveDraftCard } from "./DraftCard";
import { resultHeadline, runTitle } from "./agentsLogic";
import { FILTERS, FILTER_LABEL, groupOf, waitingCounts, waitingItems, type Waiting, type WaitingFilter } from "./managerLogic";
import { useManager } from "./managerProto";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";

const LINK = "rounded px-1 font-mono text-sm font-semibold text-ws-pip hover:underline";
const BUTTON = "rounded-md border border-ws-sep2 px-2.5 py-1 text-sm hover:bg-ws-hover disabled:opacity-45";
const PRIMARY = "rounded-md bg-ws-pip px-2.5 py-1 text-sm font-semibold text-ws-on-pip disabled:opacity-45";

const openTicket = (ref: ItemRef) => useTabs.getState().select(itemKey(ref));
const openRun = (id: string) => useRuns.getState().openRun(id, { stay: true });

function Meta({ item, run, from }: { item: ItemRef | null; run: Run | null; from: string }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-sm text-ws-ink3">
      {item && (
        <button type="button" onClick={() => openTicket(item)} className={LINK} title="Open the ticket">
          {item.key}
        </button>
      )}
      {run && (
        <button type="button" onClick={() => openRun(run.id)} className="rounded px-1 text-ws-pip hover:underline" title="Open the run">
          Open run
        </button>
      )}
      <span>{from}</span>
    </p>
  );
}

function Shell({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return (
    <article aria-label={title} className="ws-legacy overflow-hidden rounded-[10px] border border-dashed border-ws-pip bg-ws-win text-base">
      <div className="flex items-center gap-2 bg-ws-pip-soft px-3 py-1.5 text-sm font-semibold text-ws-pip">
        <span aria-hidden>✋</span>
        {title}
        <span className="ml-auto font-normal text-ws-ink3">{badge}</span>
      </div>
      <div className="grid gap-2 px-3 py-2.5">{children}</div>
    </article>
  );
}

function AnswerCard({ run, ticketTitle }: { run: Run; ticketTitle: string | null }) {
  const answering = useRuns((s) => s.answering.has(run.id));
  const reply = run.suggestedReply?.trim();
  return (
    <div className="grid gap-1" data-waiting="answer">
      <Shell title={`Answer needed: ${runTitle(run, ticketTitle)}`} badge="Waiting for you">
        <p className="m-0 [overflow-wrap:anywhere]">{run.needs}</p>
        <div className="flex flex-wrap items-center gap-2">
          {run.state === "needsAnswer" && reply && (
            <button type="button" disabled={answering} onClick={() => void useRuns.getState().answer(run.id, reply)} className={PRIMARY}>
              {answering ? "Sending…" : `Answer: ${reply}`}
            </button>
          )}
          <button type="button" onClick={() => openRun(run.id)} className={BUTTON}>
            Open run to answer
          </button>
        </div>
        <p className="m-0 text-sm text-ws-ink3">Your answer goes straight back to the run. Pip does not guess.</p>
      </Shell>
      <Meta item={run.item} run={run} from="Pip, when the run stopped" />
    </div>
  );
}

function FinishedCard({ run, ticketTitle }: { run: Run; ticketTitle: string | null }) {
  return (
    <div className="grid gap-1" data-waiting="finished">
      <Shell title={`Finished: ${runTitle(run, ticketTitle)}`} badge="Not reviewed">
        <p className="m-0 [overflow-wrap:anywhere]">{resultHeadline(run.result) ?? run.summary ?? "It finished without a written answer."}</p>
        <p className="m-0 text-sm text-ws-ink3">Pip is not reviewing finished runs, so this one is waiting for you to read.</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              useManager.getState().markRead(run.id);
              openRun(run.id);
            }}
            className={PRIMARY}
          >
            Read the result
          </button>
          <button type="button" onClick={() => useManager.getState().markRead(run.id)} className={BUTTON}>
            Mark as read
          </button>
        </div>
      </Shell>
      <Meta item={run.item} run={run} from="Finished" />
    </div>
  );
}

function Row({ w, runs, titles }: { w: Waiting; runs: readonly Run[]; titles: Record<string, string> }) {
  const titleOf = (run: Run) => (run.item ? (titles[itemKey(run.item)] ?? null) : null);
  if (w.type === "answer") return <AnswerCard run={w.run} ticketTitle={titleOf(w.run)} />;
  if (w.type === "finished") return <FinishedCard run={w.run} ticketTitle={titleOf(w.run)} />;
  const target = targetOf(w.proposal.intent);
  const intent = w.proposal.intent;
  const run = intent.type === "followUp" ? (runs.find((r) => r.id === intent.run) ?? null) : target ? ([...runs].reverse().find((r) => r.item?.key === target.key) ?? null) : null;
  return (
    <div className="grid gap-1" data-waiting={groupOf(w)}>
      <LiveDraftCard proposal={w.proposal} jump={false} />
      <Meta item={target} run={run} from={w.proposal.createdBy === "pip" ? "Drafted by Pip" : "From an agent run"} />
    </div>
  );
}

export function ManagerPill() {
  const reviewing = useManager((s) => s.reviewFinished);
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-ws-sep2 px-2.5 py-px text-sm text-ws-ink2">
      <span aria-hidden className={`size-2 rounded-full ${reviewing ? "bg-ws-pip" : "bg-ws-ink3"}`} />
      Pip reviews finished runs: <b className="font-semibold text-ws-ink">{reviewing ? "on" : "off"}</b>
      <button type="button" onClick={() => useTabs.getState().openSettings("manager")} className="text-ws-accent underline">
        Settings
      </button>
    </span>
  );
}

/** One list of everything waiting for the person: drafts, answers a run needs and send-backs. */
export function ManagerInbox() {
  const proposals = useWorkspace((s) => s.proposals);
  const items = useWorkspace((s) => s.items);
  const runs = useRuns((s) => s.runs);
  const reviewing = useManager((s) => s.reviewFinished);
  const read = useManager((s) => s.read);
  const [filter, setFilter] = useState<WaitingFilter>("all");
  const all = useMemo(() => waitingItems(Object.values(proposals), runs, read, reviewing), [proposals, runs, read, reviewing]);
  const counts = useMemo(() => waitingCounts(all), [all]);
  const shown = filter === "all" ? all : all.filter((w) => groupOf(w) === filter);
  const titles = useMemo(() => Object.fromEntries(Object.entries(items).map(([k, i]) => [k, i.title])), [items]);

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ws-sep bg-ws-bar px-6 py-2.5">
        <h2 className="m-0 text-base font-semibold">Waiting for you</h2>
        <span aria-live="polite" className="text-sm text-ws-ink3">
          {all.length === 0 ? "Nothing waiting" : `${all.length} ${all.length === 1 ? "item" : "items"}`}
        </span>
        <span className="flex-1" />
        <ManagerPill />
      </header>
      <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-2 border-b border-ws-sep px-6 py-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-px text-sm ${filter === f ? "bg-ws-sel font-semibold text-ws-ink" : "text-ws-ink2 hover:bg-ws-hover"}`}
          >
            {FILTER_LABEL[f]}
            {counts[f] > 0 && <span className="text-xs text-ws-ink3">{counts[f]}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-28">
        {shown.length === 0 ? (
          <p role="status" className="m-0 py-10 text-center text-ws-ink3">
            {all.length === 0 ? "Nothing is waiting for you. Drafts Pip makes and questions a run asks land here." : "Nothing of this kind is waiting."}
          </p>
        ) : (
          <div className="mx-auto grid max-w-[760px] gap-4">
            {shown.map((w) => (
              <Row key={w.type === "draft" ? w.proposal.id : `${w.type}-${w.run.id}`} w={w} runs={runs} titles={titles} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
