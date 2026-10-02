import { useState } from "react";
import type { CodeChange, Run, RunOutcome } from "../types";
import { Box, Btn, CopyButton, Details, Sec } from "./AgentSheet";
import { blockerChoices, blockerControl, breakdownStatus, changeSummary, commentControl, createdFrom, ticketControl, ticketStatus } from "./runSheetLogic";

export interface ResultActions {
  draftComment(): void;
  /** Opens Pip on the run, and on its comment draft when one is waiting. */
  askPip(): void;
  openDraft(): void;
  pickBlocker(): void;
  cancelBlocker(): void;
  draftBlocker(key: string): void;
  openChange(url: string): void;
  /** Drafts a new ticket from a run that has no ticket. */
  draftTicket(): void;
  openTicketDraft(): void;
  /** Opens Pip on the run and its ticket draft, to tighten the draft before it is approved. */
  finishWithPip(): void;
  openCreated(): void;
  /** Opens Pip on the run, and on its breakdown draft when one is waiting. */
  askPipBreakdown(): void;
}

export interface ResultProps {
  run: Run;
  outcome: RunOutcome | null;
  tickets: readonly { key: string; title: string }[];
  pickBlocker: boolean;
  drafting: boolean;
  on: ResultActions;
}

function BlockerPicker({ tickets, named, own, drafting, on }: { tickets: ResultProps["tickets"]; named: readonly string[]; own: string | null; drafting: boolean; on: ResultActions }) {
  const [query, setQuery] = useState("");
  const choices = blockerChoices(tickets, named, own, query);
  return (
    <div data-esc-local className="grid gap-1.5 rounded-md border border-ws-sep bg-ws-bar p-2.5" onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), on.cancelBlocker())}>
      <label className="grid gap-1 text-sm text-ws-ink2">
        Which ticket blocks {own ?? "this one"}?
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="A ticket key or part of its title"
          className="rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink"
        />
      </label>
      {choices.length > 0 ? (
        <ul className="m-0 grid list-none gap-0.5 p-0" aria-label="Tickets">
          {choices.map((c) => (
            <li key={c.key}>
              <button type="button" disabled={drafting} onClick={() => on.draftBlocker(c.key)} className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-ws-hover disabled:opacity-45">
                <span className="font-mono text-sm font-semibold">{c.key}</span>
                <span className="min-w-0 flex-1 truncate text-ws-ink2">{c.title ?? "Not in your watched projects. Gossamr looks it up."}</span>
                {c.found && <span className="shrink-0 text-xs text-ws-ink3">in the result</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-ws-ink3">{query.trim() ? "No ticket matches. Type a full key such as CA-123." : "The result names no ticket you have. Type a key or part of a title."}</p>
      )}
      <div>
        <Btn tone="ghost" onClick={on.cancelBlocker}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

const TICKET_KIND: Record<string, string> = { task: "Task", bug: "Bug", story: "Story", epic: "Epic" };

/** What an investigation with no ticket found. It ends as one draft ticket, which nothing creates until the person approves it. */
function TicketFound({ run, outcome, drafting, on }: Pick<ResultProps, "run" | "outcome" | "drafting" | "on">) {
  const text = run.result?.trim();
  const proposal = outcome?.ticket;
  const status = ticketStatus(outcome);
  const control = ticketControl(run);
  const made = createdFrom(run);
  return (
    <Sec title="What it found">
      <Box>
        {proposal ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs font-semibold text-ws-ink3">
              The ticket it proposes
              <span className="rounded-full bg-ws-hover px-2 font-semibold text-ws-ink2">{TICKET_KIND[proposal.kind] ?? proposal.kind}</span>
            </p>
            <p data-ticket="title" className="selectable m-0 text-[14px] font-semibold [overflow-wrap:anywhere]">
              {proposal.title}
            </p>
            {proposal.body && (
              <p data-ticket="body" className="selectable m-0 whitespace-pre-wrap text-[13.5px] text-ws-ink2 [overflow-wrap:anywhere]">
                {proposal.body}
              </p>
            )}
          </>
        ) : text ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs font-semibold text-ws-ink3">
              No 'New ticket:' section, so this is its whole answer
              <span className="rounded-full bg-ws-warn/15 px-2 font-semibold text-ws-warn">Not parsed</span>
            </p>
            <p data-ticket="answer" className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">
              {text}
            </p>
          </>
        ) : (
          <p className="m-0 text-ws-ink3">It finished without a written answer.</p>
        )}
        {proposal && text && (
          <Details summary="The full answer">
            <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] text-ws-ink2 [overflow-wrap:anywhere]">{text}</p>
          </Details>
        )}
        {status === "waiting" && (
          <p data-ticket-draft="waiting" role="status" className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-sm">
            <b className="font-semibold text-ws-pip">A new ticket is drafted.</b> Read it, edit it or skip it. Nothing is created in Jira until you approve it.
          </p>
        )}
        {status === "created" && (
          <p data-ticket-draft="created" className="m-0 text-sm text-ws-ink2">
            {made ?? "Its ticket was created"}.
          </p>
        )}
        {status === "skipped" && (
          <p data-ticket-draft="skipped" className="m-0 text-sm text-ws-ink3">
            You skipped its ticket draft.
          </p>
        )}
        {status === "retired" && (
          <p data-ticket-draft="retired" className="m-0 text-sm text-ws-ink3">
            Its ticket draft is out of date.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {status === "waiting" ? (
            <>
              <Btn tone="primary" icon="ext" onClick={on.openTicketDraft}>
                Open the draft ticket
              </Btn>
              <Btn icon="spark" disabled={drafting} title="Pip reads the whole run and the draft, and tightens the draft if you ask" onClick={on.finishWithPip}>
                Finish with Pip
              </Btn>
            </>
          ) : status === "created" && run.createdItem ? (
            <Btn icon="ext" onClick={on.openCreated}>
              Open {run.createdItem.key}
            </Btn>
          ) : status === "none" ? (
            <Btn tone="primary" icon="ext" disabled={!control.enabled || drafting} title={control.reason ?? undefined} onClick={on.draftTicket}>
              Draft a ticket from this
            </Btn>
          ) : null}
          {text && <CopyButton text={text} label="Copy" what="the result" />}
        </div>
        {status === "none" && control.reason && (
          <p role="note" className="m-0 text-sm text-ws-ink3">
            {control.reason}
          </p>
        )}
        <p className="m-0 text-xs text-ws-ink3">
          The words are the agent&apos;s, written after reading code. A ticket is drafted for you to read and edit; nothing is created until you approve it, and the project was your choice.
        </p>
      </Box>
    </Sec>
  );
}

/** What the agent found. Drafting from it is one click and posts nothing. */
export function Found(props: ResultProps) {
  return props.run.item ? <TicketRunFound {...props} /> : <TicketFound run={props.run} outcome={props.outcome} drafting={props.drafting} on={props.on} />;
}

/** The subtasks a Triage proposed. They are drafted on the ticket, and nothing is created until the person approves them. */
function Breakdown({ run, outcome, drafting, on }: Pick<ResultProps, "run" | "outcome" | "drafting" | "on">) {
  const summaries = outcome?.subtasks ?? [];
  const status = breakdownStatus(outcome);
  if (summaries.length === 0 && status === "none") return null;
  const key = run.item?.key ?? "the ticket";
  return (
    <div data-breakdown={status} className="grid gap-2 rounded-md border border-ws-sep bg-ws-bar p-2.5">
      <p className="m-0 text-xs font-semibold text-ws-ink3">The breakdown it proposes</p>
      <ol className="selectable m-0 grid list-decimal gap-0.5 pl-5 text-[13.5px] [overflow-wrap:anywhere]">
        {summaries.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {status === "waiting" && (
        <p role="status" className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-sm">
          <b className="font-semibold text-ws-pip">A breakdown is drafted on {key}.</b> Edit the list, then approve it or skip it. Nothing is created in Jira until you approve it.
        </p>
      )}
      {status === "created" && <p className="m-0 text-sm text-ws-ink2">Its subtasks were created.</p>}
      {status === "skipped" && <p className="m-0 text-sm text-ws-ink3">You skipped its breakdown.</p>}
      {status === "retired" && <p className="m-0 text-sm text-ws-ink3">Its breakdown is out of date.</p>}
      {status === "none" && <p className="m-0 text-sm text-ws-ink3">It isn&apos;t drafted. Pip can draft it from the run.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {status === "waiting" ? (
          <>
            <Btn tone="primary" icon="ext" onClick={on.openDraft}>
              Open the draft
            </Btn>
            <Btn icon="spark" disabled={drafting} title="Pip reads the whole run and the breakdown, and changes it if you ask" onClick={on.askPipBreakdown}>
              Discuss with Pip
            </Btn>
          </>
        ) : status === "none" ? (
          <Btn icon="spark" disabled={drafting} title="Pip reads the whole run and drafts the subtasks for you to edit" onClick={on.askPipBreakdown}>
            Draft with Pip
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

function TicketRunFound({ run, outcome, tickets, pickBlocker, drafting, on }: ResultProps) {
  const text = run.result?.trim();
  const note = outcome?.note;
  const comment = commentControl(run);
  const blocker = blockerControl(run);
  const reason = comment.reason ?? blocker.reason;
  const draft = outcome?.draft?.state.type === "pending" ? outcome.draft : null;
  const decided = outcome?.draft && !draft ? outcome.draft.state.type : null;
  return (
    <Sec title="What it found">
      <Box>
        {note?.text ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs font-semibold text-ws-ink3">
              {note.fromMarker ? "For Jira, as the agent wrote it" : "No 'For Jira:' section, so this is its whole answer, shortened"}
              {!note.fromMarker && <span className="rounded-full bg-ws-warn/15 px-2 font-semibold text-ws-warn">Not parsed</span>}
            </p>
            <p data-note={note.fromMarker ? "section" : "whole"} className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">
              {note.text}
            </p>
          </>
        ) : text ? (
          <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">{text}</p>
        ) : (
          <p className="m-0 text-ws-ink3">It finished without a written answer.</p>
        )}
        {text && note?.fromMarker && (
          <Details summary="The full answer">
            <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] text-ws-ink2 [overflow-wrap:anywhere]">{text}</p>
          </Details>
        )}
        <Breakdown run={run} outcome={outcome} drafting={drafting} on={on} />
        {draft && (
          <p data-draft="ready" role="status" className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-sm">
            <b className="font-semibold text-ws-pip">A comment is drafted on {run.item?.key ?? "the ticket"}.</b> Read it, edit it or skip it. Nothing is posted until you approve it.
          </p>
        )}
        {decided && (
          <p data-draft={decided} className="m-0 text-sm text-ws-ink3">
            {decided === "applied" ? "Its comment draft was posted." : decided === "skipped" ? "You skipped its comment draft." : "Its comment draft is out of date."}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {draft ? (
            <>
              <Btn tone="primary" icon="ext" onClick={on.openDraft}>
                Open the draft
              </Btn>
              <Btn icon="spark" disabled={drafting} title="Pip reads the whole run and the draft, and changes the draft if you ask" onClick={on.askPip}>
                Discuss with Pip
              </Btn>
            </>
          ) : (
            <>
              <Btn tone={decided === "applied" ? undefined : "primary"} icon="ext" disabled={!comment.enabled || drafting} title={comment.reason ?? undefined} onClick={on.draftComment}>
                Draft a Jira comment from this
              </Btn>
              <Btn icon="spark" disabled={!comment.enabled || drafting} title={comment.reason ?? "Pip reads the whole run and writes a comment for you to edit"} onClick={on.askPip}>
                Draft with Pip
              </Btn>
            </>
          )}
          <Btn icon="branch" disabled={!blocker.enabled || drafting} aria-expanded={pickBlocker} title={blocker.reason ?? undefined} onClick={pickBlocker ? on.cancelBlocker : on.pickBlocker}>
            Draft a blocker
          </Btn>
          {text && <CopyButton text={text} label="Copy" what="the result" />}
        </div>
        {reason && (
          <p role="note" className="m-0 text-sm text-ws-ink3">
            {reason}
          </p>
        )}
        {pickBlocker && blocker.enabled && <BlockerPicker tickets={tickets} named={outcome?.keys ?? []} own={run.item?.key ?? null} drafting={drafting} on={on} />}
        <p className="m-0 text-xs text-ws-ink3">
          These make drafts for you to read and edit. The words are the agent&apos;s, written after reading ticket text and code. Nothing is posted until you approve a draft.
        </p>
      </Box>
    </Sec>
  );
}

const KIND_NAME: Record<CodeChange["kind"], string> = { pullRequest: "Pull request", branch: "Branch", commit: "Commit" };

/** The pull request or branch the run produced, once a sync has seen it. */
export function Changes({ change, on }: { change: CodeChange; on: Pick<ResultActions, "openChange"> }) {
  const facts = changeSummary(change);
  return (
    <Sec title="Changes">
      <Box>
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 font-semibold">
          <span className="text-xs font-semibold text-ws-ink3 uppercase">{KIND_NAME[change.kind]}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{change.kind === "pullRequest" ? `#${change.number} ${change.title}` : change.headRef}</span>
        </p>
        <p className="m-0 flex flex-wrap gap-x-3 text-sm text-ws-ink2">
          {facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </p>
        <p className="m-0 font-mono text-xs text-ws-ink3 [overflow-wrap:anywhere]">
          {change.repo} · {change.headRef}
        </p>
        <div>
          <Btn icon="ext" onClick={() => on.openChange(change.url)}>
            {change.kind === "pullRequest" ? "Open PR on GitHub" : "Open branch on GitHub"}
          </Btn>
        </div>
      </Box>
    </Sec>
  );
}
