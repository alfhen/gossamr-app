import { useState } from "react";
import { SUMMARY_ONLY, type CodeChange, type ReviewView, type Run, type RunOutcome } from "../types";
import { Box, Btn, CopyButton, Details, Sec } from "./AgentSheet";
import { planDescriptionStatus, blockerChoices, blockerControl, breakdownStatus, buildFromPlanControl, changeSummary, commentControl, createdFrom, planCommentControl, reportNotes, reviewThisControl, SEVERITY_LABEL, SOURCE_CHIP, ticketControl, ticketStatus, verdictText } from "./runSheetLogic";

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
  /** Asks Pip to draft a description update for the run's ticket from what the run found. */
  askPipDescription?(): void;
  /** Opens a Build draft for the plan run's ticket that carries its plan. */
  buildFromPlan(): void;
  /** Drafts the whole plan as a comment on the ticket. */
  draftPlanComment(): void;
  openPlanDraft(): void;
  /** Drafts the ticket's description with the plan added as a Gossamr Plan section. */
  draftPlanDescription?(): void;
  /** Opens the waiting description update as a diff, where it is approved, edited or skipped. */
  openPlanDescription?(): void;
  /** Opens Pip on the run and its description update, to talk the draft over before it is approved. */
  discussPlanDescription?(): void;
  /** Opens a Review draft for the build's pull request that carries the builder's answer. */
  reviewThis(): void;
}

export interface ResultProps {
  run: Run;
  outcome: RunOutcome | null;
  tickets: readonly { key: string; title: string }[];
  pickBlocker: boolean;
  drafting: boolean;
  /** A breakdown is waiting on the run's ticket that no run made, for example one Pip drafted from the sheet. */
  waitingBreakdown?: boolean;
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

/** Where the result on the sheet came from: reported through the tool, or read from the written answer. */
function SourceChip({ outcome }: { outcome: RunOutcome | null }) {
  const chip = outcome?.source ? SOURCE_CHIP[outcome.source] : null;
  if (!chip) return null;
  return (
    <span data-source={outcome?.source} className={`rounded-full px-2 font-semibold ${chip.warn ? "bg-ws-warn/15 text-ws-warn" : "bg-ws-hover text-ws-ink2"}`}>
      {chip.label}
    </span>
  );
}

/** What the report tool did for this run, in plain sentences, when the run was asked to use it. */
function ReportNotes({ outcome }: { outcome: RunOutcome | null }) {
  const notes = reportNotes(outcome);
  if (notes.length === 0) return null;
  return (
    <div data-report-notes className="grid gap-0.5">
      {notes.map((n) => (
        <p key={n} className="m-0 text-xs text-ws-ink3">
          {n}
        </p>
      ))}
    </div>
  );
}

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
              <SourceChip outcome={outcome} />
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
              {outcome?.summaryOnly ? SUMMARY_ONLY : "No 'New ticket:' section, so this is its whole answer"}
              {outcome?.source ? <SourceChip outcome={outcome} /> : <span className="rounded-full bg-ws-warn/15 px-2 font-semibold text-ws-warn">{outcome?.summaryOnly ? "Summary only" : "Not parsed"}</span>}
            </p>
            <p data-ticket="answer" className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">
              {text}
            </p>
          </>
        ) : (
          <p className="m-0 text-ws-ink3">It finished without a written answer.</p>
        )}
        <ReportNotes outcome={outcome} />
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

const SEVERITY_TONE: Record<ReviewView["findings"][number]["severity"], string> = {
  blocking: "bg-ws-blocked-soft text-ws-blocked",
  "should-fix": "bg-ws-warn/15 text-ws-warn",
  nit: "bg-ws-hover text-ws-ink2",
};

/** A review's verdict and its findings, most severe first. Only the verdict and the counts are Gossamr's to read; the findings are the reviewer's words. */
export function ReviewVerdictBlock({ outcome }: { outcome: RunOutcome | null }) {
  if (!outcome) return null;
  const review = outcome.review ?? null;
  return (
    <Sec title="Verdict">
      <Box tone={review?.verdict === "blocking" ? "failed" : "plain"}>
        {review ? (
          <>
            <p data-verdict={review.verdict} data-blocking-count={review.blocking} className={`m-0 flex flex-wrap items-center gap-2 text-[14px] font-semibold ${review.verdict === "blocking" ? "text-ws-blocked" : "text-ws-done"}`}>
              {verdictText(review)}
              <span className="rounded-full bg-ws-hover px-2 text-xs font-semibold text-ws-ink2">{review.source === "structured" ? "Reported to Gossamr" : "Read from its Verdict line"}</span>
            </p>
            {(review.shouldFix > 0 || review.nits > 0) && (
              <p className="m-0 text-sm text-ws-ink2">
                Also {review.shouldFix} should fix and {review.nits} nit{review.nits === 1 ? "" : "s"}.
              </p>
            )}
            {review.findings.length > 0 ? (
              <ul aria-label="Findings" className="selectable m-0 grid list-none gap-1 p-0 text-[13.5px] [overflow-wrap:anywhere]">
                {review.findings.map((f, i) => (
                  <li key={i} data-severity={f.severity} className="flex items-baseline gap-2">
                    <span className={`shrink-0 rounded-full px-2 text-xs font-semibold ${SEVERITY_TONE[f.severity]}`}>{SEVERITY_LABEL[f.severity]}</span>
                    <span className="min-w-0">
                      {f.text}
                      {f.where && <span className="block font-mono text-xs text-ws-ink3">{f.where}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-ws-ink3">It listed no findings.</p>
            )}
          </>
        ) : (
          <p data-verdict="none" className="m-0 text-sm text-ws-ink2">
            The reviewer gave no verdict. Read its answer below to see what it found.
          </p>
        )}
        <p className="m-0 text-xs text-ws-ink3">The reviewer was asked to show the change is not ready. The findings are its words, written after reading the pull request; nothing was said on the pull request.</p>
      </Box>
    </Sec>
  );
}

/** What the agent found. Drafting from it is one click and posts nothing. */
export function Found(props: ResultProps) {
  const found = props.run.item ? <TicketRunFound {...props} /> : <TicketFound run={props.run} outcome={props.outcome} drafting={props.drafting} on={props.on} />;
  if (props.run.spec.kind !== "review") return found;
  return (
    <>
      <ReviewVerdictBlock outcome={props.outcome} />
      {found}
    </>
  );
}

/** The subtasks a Triage proposed. They are drafted on the ticket, and nothing is created until the person approves them. */
function Breakdown({ run, outcome, drafting, waitingBreakdown = false, on }: Pick<ResultProps, "run" | "outcome" | "drafting" | "waitingBreakdown" | "on">) {
  const summaries = outcome?.subtasks ?? [];
  const status = breakdownStatus(outcome);
  const elsewhere = status === "none" && waitingBreakdown;
  if (summaries.length === 0 && !elsewhere && status === "none") return null;
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
      {status === "none" && !elsewhere && <p className="m-0 text-sm text-ws-ink3">It isn&apos;t drafted. Pip can draft it from the run.</p>}
      {elsewhere && (
        <p role="status" className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-sm">
          <b className="font-semibold text-ws-pip">A breakdown is already waiting on {key}.</b> Open it to edit the list, then approve it or skip it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {status === "waiting" || elsewhere ? (
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

/** What to do with a finished build: have its pull request reviewed against the ticket. It opens a draft and starts nothing. */
function ReviewBox({ run, outcome, drafting, on }: Pick<ResultProps, "run" | "outcome" | "drafting" | "on">) {
  const control = outcome ? reviewThisControl(run, outcome.change) : { enabled: false, reason: "Looking for its pull request…" };
  const change = outcome?.change?.kind === "pullRequest" ? outcome.change : null;
  return (
    <div data-review-box className="grid gap-2 rounded-md border border-ws-sep bg-ws-bar p-2.5">
      <p className="m-0 text-xs font-semibold text-ws-ink3">Review the pull request</p>
      <p className="m-0 text-sm text-ws-ink2">
        {change ? `Pull request #${change.number}${change.state === "draft" ? " (a draft)" : ""} is what a review would read, at the commit GitHub has now.` : "A review reads the build's pull request at the commit GitHub has now."} The reviewer tries to show the change is not ready: a failing case, an acceptance point of the ticket it misses, a missing test, a regression or a security issue. It may check the pull request out in its own worktree and run the existing tests, treats what the builder says it did as a claim to verify, cites a file and line, a command or an acceptance point for every finding, and ends with a verdict: pass or blocking. It only reads, and never comments on, approves or changes the pull request.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" icon="eye" disabled={!control.enabled || drafting} title={control.reason ?? "Opens a Review draft that carries the builder's answer as a claim to check, for you to read and edit before it starts"} onClick={on.reviewThis}>
          Review this
        </Btn>
      </div>
      {control.reason && (
        <p role="note" className="m-0 text-sm text-ws-ink3">
          {control.reason}
        </p>
      )}
    </div>
  );
}

/** The description update a finished plan leaves on its ticket: the plan added as a `Gossamr Plan` section, for the person to read as a diff. Nothing is written until they approve it. */
function PlanDescription({ run, outcome, drafting, on }: Pick<ResultProps, "run" | "outcome" | "drafting" | "on">) {
  const info = outcome?.planDescription;
  if (!info) return null;
  const status = planDescriptionStatus(outcome);
  const key = run.item?.key ?? "the ticket";
  return (
    <div data-plan-description={status} className={`grid gap-2 rounded-md border p-2.5 ${status === "waiting" ? "border-ws-pip/60 bg-ws-pip-soft" : "border-ws-sep bg-ws-win"}`}>
      <p className="m-0 text-xs font-semibold text-ws-ink3">Description update</p>
      {status === "waiting" && (
        <p role="status" className="m-0 text-sm">
          <b className="font-semibold text-ws-pip">Description update ready: see the diff.</b> {key}&apos;s description is drafted with this plan added as a &ldquo;Gossamr Plan&rdquo; section, so other agents and people can see and check the agreed work. Approve it, edit it or skip it in the diff. Nothing is written to Jira until you approve it.
        </p>
      )}
      {status === "applied" && <p className="m-0 text-sm text-ws-ink2">The plan was added to {key}&apos;s description.</p>}
      {status === "skipped" && <p className="m-0 text-sm text-ws-ink3">You skipped its description update.</p>}
      {status === "retired" && <p className="m-0 text-sm text-ws-ink3">Its description update is out of date: the ticket changed or a newer plan replaced it.</p>}
      {status === "none" && !info.unavailable && <p className="m-0 text-sm text-ws-ink2">No description update is drafted yet. Gossamr can add this plan to {key}&apos;s description as a draft for you to read.</p>}
      {status === "none" && info.unavailable && (
        <p data-plan-description-why role="note" className="m-0 text-sm text-ws-ink2">
          No description update: {info.unavailable}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {status === "waiting" ? (
          <>
            <Btn tone="primary" icon="ext" onClick={on.openPlanDescription}>
              See the diff
            </Btn>
            <Btn icon="spark" disabled={drafting} title="Pip reads the whole run and the draft, and changes the draft if you ask" onClick={on.discussPlanDescription}>
              Chat it over with Pip
            </Btn>
          </>
        ) : status === "none" && !info.unavailable ? (
          <Btn tone="primary" icon="ext" disabled={drafting} title="Makes a draft of the description with the plan added, for you to read as a diff" onClick={on.draftPlanDescription}>
            Draft the description update
          </Btn>
        ) : status === "retired" || status === "skipped" ? (
          <Btn icon="ext" disabled={drafting} title="Makes a new draft from the plan and the ticket as it reads now" onClick={on.draftPlanDescription}>
            Draft it again
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

/** What a Plan run wrote: the plan itself, to read, and the things to do with it. None of them posts anything. */
function PlanBox({ run, outcome, drafting, on }: Pick<ResultProps, "run" | "outcome" | "drafting" | "on">) {
  const text = run.result?.trim();
  const build = buildFromPlanControl(run);
  const comment = planCommentControl(run);
  const waiting = outcome?.planDraft?.state.type === "pending" ? outcome.planDraft : null;
  const decided = outcome?.planDraft && !waiting ? outcome.planDraft.state.type : null;
  return (
    <div data-plan-box className="grid gap-2 rounded-md border border-ws-sep bg-ws-bar p-2.5">
      <PlanDescription run={run} outcome={outcome} drafting={drafting} on={on} />
      <p className="m-0 text-xs font-semibold text-ws-ink3">The plan</p>
      {text ? (
        <Details summary={`${text.length.toLocaleString("en")} characters, as the agent wrote it`} open>
          <p data-plan="text" className="selectable m-0 max-h-96 overflow-auto text-[13.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {text}
          </p>
        </Details>
      ) : (
        <p className="m-0 text-ws-ink3">It finished without a written answer.</p>
      )}
      {waiting && (
        <p data-plan-draft="ready" role="status" className="m-0 rounded-md border border-dashed border-ws-pip bg-ws-pip-soft px-2.5 py-1.5 text-sm">
          <b className="font-semibold text-ws-pip">The plan is drafted as a comment on {run.item?.key ?? "the ticket"}.</b> Read it, edit it or skip it. Nothing is posted until you approve it.
        </p>
      )}
      {decided && (
        <p data-plan-draft={decided} className="m-0 text-sm text-ws-ink3">
          {decided === "applied" ? "Its plan comment was posted." : decided === "skipped" ? "You skipped its plan comment." : "Its plan comment is out of date."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Btn tone="primary" icon="code" disabled={!build.enabled || drafting} title={build.reason ?? "Opens a Build draft that carries this plan, for you to read and edit before it starts"} onClick={on.buildFromPlan}>
          Build from this plan
        </Btn>
        {waiting ? (
          <Btn icon="ext" onClick={on.openPlanDraft}>
            Open the plan comment
          </Btn>
        ) : (
          <Btn icon="ext" disabled={!comment.enabled || drafting} title={comment.reason ?? "Makes a draft of the whole plan as a comment, for you to read and edit"} onClick={on.draftPlanComment}>
            Draft the plan as a comment
          </Btn>
        )}
      </div>
      {(!build.enabled || !comment.enabled) && build.reason && (
        <p role="note" className="m-0 text-sm text-ws-ink3">
          {build.reason}
        </p>
      )}
      <p className="m-0 text-xs text-ws-ink3">The status comment drafted when it finished holds only the short note for Jira. The whole plan goes to the ticket as the description update above, or as a comment if you draft that too. Nothing is written until you approve a draft.</p>
    </div>
  );
}

function TicketRunFound({ run, outcome, tickets, pickBlocker, drafting, waitingBreakdown, on }: ResultProps) {
  const text = run.result?.trim();
  const note = outcome?.note;
  const comment = commentControl(run);
  const blocker = blockerControl(run);
  const reason = comment.reason ?? blocker.reason;
  const draft = outcome?.draft?.state.type === "pending" ? outcome.draft : null;
  const decided = outcome?.draft && !draft ? outcome.draft.state.type : null;
  return (
    <Sec title={run.spec.kind === "plan" ? "The plan it wrote" : "What it found"}>
      <Box>
        {run.spec.kind === "plan" && <PlanBox run={run} outcome={outcome} drafting={drafting} on={on} />}
        {note?.text ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs font-semibold text-ws-ink3">
              {outcome?.summaryOnly ? SUMMARY_ONLY : outcome?.source === "structured" ? "For Jira, as the agent reported it" : note.fromMarker ? "For Jira, as the agent wrote it" : "No 'For Jira:' section, so this is its whole answer, shortened"}
              {outcome?.source ? (
                <SourceChip outcome={outcome} />
              ) : outcome?.summaryOnly ? (
                <span className="rounded-full bg-ws-warn/15 px-2 font-semibold text-ws-warn">Summary only</span>
              ) : (
                !note.fromMarker && <span className="rounded-full bg-ws-warn/15 px-2 font-semibold text-ws-warn">Not parsed</span>
              )}
            </p>
            <p data-note={outcome?.summaryOnly ? "summary" : outcome?.source === "structured" ? "structured" : note.fromMarker ? "section" : "whole"} className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">
              {note.text}
            </p>
          </>
        ) : text ? (
          <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">{text}</p>
        ) : (
          <p className="m-0 text-ws-ink3">It finished without a written answer.</p>
        )}
        <ReportNotes outcome={outcome} />
        {text && note?.fromMarker && (
          <Details summary="The full answer">
            <p className="selectable m-0 whitespace-pre-wrap text-[13.5px] text-ws-ink2 [overflow-wrap:anywhere]">{text}</p>
          </Details>
        )}
        <Breakdown run={run} outcome={outcome} drafting={drafting} waitingBreakdown={waitingBreakdown} on={on} />
        {run.spec.kind === "build" && <ReviewBox run={run} outcome={outcome} drafting={drafting} on={on} />}
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
          {run.spec.kind === "triage" && on.askPipDescription && (
            <Btn icon="spark" disabled={!comment.enabled || drafting} title={comment.reason ?? "Pip reads the whole run and the ticket, and drafts a new description for you to review as a diff"} onClick={on.askPipDescription}>
              Draft a description update
            </Btn>
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
