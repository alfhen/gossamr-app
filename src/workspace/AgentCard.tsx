import type { KeyboardEvent } from "react";
import { archiveControl } from "../lib/archiveRuns";
import { runRef } from "../lib/composerVerbs";
import type { ReviewView, Run } from "../types";
import { Icon, KIND_ICON } from "./AgentIcons";
import { RunBody, StateChip, TONE, type FailureState } from "./AgentParts";
import { ownKey } from "./agentKeys";
import { KIND_LABEL, ageSince, ageText, branchOf, formatTokens, repoName, runTitle } from "./agentsLogic";
import { useStateView } from "./useStateView";
import { readOnlyHeadline, verdictChip, verdictText } from "./runSheetLogic";

export const agentId = (id: string) => `agent-${id}`;

export interface AgentItemProps {
  run: Run;
  now: number;
  selected: boolean;
  position: number;
  total: number;
  /** The ticket's title when it is cached. */
  ticketTitle: string | null;
  /** The run's short name in its workstream (`R1`), when it is shown grouped by workstream. */
  label?: string;
  onOpen(): void;
  onAttach(): void;
  /** Present on a finished run that has something to post. */
  onDraftComment?(): void;
  /** Present on a finished plan run that can be built from. */
  onBuildFromPlan?(): void;
  /** Present on a run that is over: takes it out of Agents and Needs you. */
  onArchive?(): void;
  /** Present on a run stopped at its limit: wakes it with the standard words, as Resume in its sheet does. Only the person's click does this. */
  onResume?(): void;
  /** Present on a finished build that opened a pull request that can be reviewed. */
  onReviewThis?(): void;
  /** A comment draft from this run is waiting. */
  draftReady?: boolean;
  /** A breakdown into subtasks from this run is waiting; opening it shows the ticket's drafts. */
  breakdownReady?: boolean;
  onOpenDraft?(): void;
  /** Opens the breakdown draft itself, apart from the comment or ticket draft. */
  onOpenBreakdown?(): void;
  /** A description update that adds this plan to its ticket is waiting as a draft. */
  descriptionReady?: boolean;
  onOpenDescription?(): void;
  /** A finished review's verdict; null when it gave none, absent while unread or for any other run. */
  review?: ReviewView | null;
  failure: FailureState;
  /** Present while the run is one of the things in Needs you: pressing it opens that need's decision at the top of the view. */
  onOpenNeed?(): void;
  /** What a key pressed on the card waits for Enter to do ("↵ allow this once in Terminal · any other key cancels"), while one does. */
  asking?: string;
}

/** The line a card or row shows while a key waits for Enter. */
export function KeyAsking({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span data-needs-asking role="status" className="min-w-0 text-xs font-semibold text-ws-pip [overflow-wrap:anywhere]">
      {text}
    </span>
  );
}

/** The pill on a run that is in Needs you; pressing it opens the need rather than the run. */
export function InNeedsYou({ onOpen }: { onOpen(): void }) {
  return (
    <button
      type="button"
      data-in-needs-you
      onClick={(ev) => (ev.stopPropagation(), onOpen())}
      onKeyDown={(ev) => ev.key === "Enter" && ev.stopPropagation()}
      title="This run is in Needs you. Open its decision at the top."
      className="inline-flex shrink-0 items-center rounded-full border border-ws-pip/50 bg-ws-pip-soft px-2 text-xs leading-[1.6] font-semibold whitespace-nowrap text-ws-pip hover:bg-ws-pip hover:text-ws-on-pip focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ws-pip"
    >
      In Needs you
    </button>
  );
}

/** A finished review's verdict in a chip: "Blocking · 2" or "Pass". */
export function VerdictChip({ review }: { review: ReviewView }) {
  const blocking = review.verdict === "blocking";
  return (
    <span
      data-verdict={review.verdict}
      data-blocking-count={review.blocking}
      title={`The reviewer's verdict: ${verdictText(review)}`}
      className={`inline-flex shrink-0 items-center rounded-full px-2 text-xs leading-[1.6] font-semibold whitespace-nowrap ${blocking ? "bg-ws-blocked-soft text-ws-blocked" : "bg-ws-done-soft text-ws-done"}`}
    >
      {verdictChip(review)}
    </span>
  );
}

export const ticketLabel = (run: Run) => run.item?.key ?? null;

export function onActivate(open: () => void) {
  return (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget || ev.key !== "Enter") return;
    ev.preventDefault();
    open();
  };
}

/** The part of the run's id the composer's commands take (`/stop 3f9a12bc`), shown wherever the run is. */
export function RunRef({ run, className = "" }: { run: Run; className?: string }) {
  const ref = runRef(run);
  return (
    <span data-run-ref={ref} title={`This run's id. In Pip, /stop ${ref}, /retry ${ref} or /answer ${ref} act on it.`} className={`font-mono text-xs text-ws-ink3 ${className}`}>
      {ref}
    </span>
  );
}

/** The short name of a run in its workstream, before the rest of its heading. */
export function RunLabel({ label }: { label?: string }) {
  if (!label) return null;
  const n = /^R(\d+)$/.exec(label)?.[1];
  return (
    <span data-run-label={label} title={n ? `Run ${n} in this workstream` : undefined} className="shrink-0 rounded bg-ws-pip-soft px-1 font-mono text-xs font-semibold text-ws-pip">
      {label}
    </span>
  );
}

/**
 * A small mark on a run launched read-only: Claude Code itself refused its edits and writes. Nothing for a Build, a run
 * from before, or one that carried on in a session Gossamr didn't launch. `compact` shows the shield alone, for a list
 * row whose title needs the room.
 */
export function ReadOnlyBadge({ run, compact = false }: { run: Run; compact?: boolean }) {
  if (!run.readOnly) return null;
  const headline = readOnlyHeadline(run.readOnly);
  if (compact) {
    return (
      <span data-read-only title={headline} aria-label={headline} role="img" className="inline-flex shrink-0 items-center text-ws-ink3">
        <Icon name="shield" className="size-3" />
      </span>
    );
  }
  return (
    <span data-read-only title={headline} className="inline-flex shrink-0 items-center gap-0.5 rounded bg-ws-hover px-1 text-xs font-medium text-ws-ink2">
      <Icon name="shield" className="size-3" />
      Read-only
    </span>
  );
}

export function AgentCard({ run, now, selected, position, total, ticketTitle, label, onOpen, onAttach, onDraftComment, onBuildFromPlan, onReviewThis, onResume, onArchive, draftReady, breakdownReady, onOpenDraft, onOpenBreakdown, descriptionReady, onOpenDescription, review, failure, onOpenNeed, asking }: AgentItemProps) {
  const view = useStateView(run, now);
  const tone = TONE[view.tone];
  const title = runTitle(run, ticketTitle);
  const tokens = formatTokens(run.tokens);
  const needs = view.tone === "pip";
  return (
    <article
      id={agentId(run.id)}
      data-run-id={run.id}
      data-state={run.state}
      tabIndex={0}
      aria-label={`${title}, ${view.label}`}
      aria-posinset={position}
      aria-setsize={total}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      // While a key of the Agents list waits for Enter, Enter is that key's (the window's handler does it), not "open".
      onKeyDown={asking ? undefined : onActivate(onOpen)}
      style={{ ["--c" as string]: tone.color, boxShadow: `inset 3px 0 0 var(--c)${selected ? ", 0 0 0 2px var(--color-ws-accent-soft)" : ""}` }}
      className={`ws-agent-card relative grid cursor-pointer content-start gap-2 rounded-[10px] border py-2.5 pr-3.5 pl-4 outline-offset-2 ${selected ? "border-ws-accent" : needs ? "border-ws-pip/45" : "border-ws-sep"} ${needs ? "bg-ws-pip-soft" : "bg-ws-win"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RunLabel label={label} />
        <span className="inline-flex items-center gap-1 text-xs font-medium text-ws-ink2">
          <Icon name={KIND_ICON[run.spec.kind]} className="size-[13px] text-ws-ink3" />
          {KIND_LABEL[run.spec.kind]}
        </span>
        <ReadOnlyBadge run={run} />
        {ticketLabel(run) && <span className="font-mono text-sm font-semibold text-ws-ink2">{ticketLabel(run)}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {review && <VerdictChip review={review} />}
          {onOpenNeed && <InNeedsYou onOpen={onOpenNeed} />}
          <StateChip run={run} now={now} />
        </span>
      </div>
      <h3 className="m-0 line-clamp-2 text-[13.5px] leading-[1.3] font-semibold text-balance [overflow-wrap:anywhere]">{title}</h3>
      <p className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-xs text-ws-ink3" title={`${run.spec.repo} on ${branchOf(run)}`}>
        <Icon name="branch" className="size-3" />
        <span className="min-w-0 truncate">
          {repoName(run.spec.repo)} · {branchOf(run)}
        </span>
        <RunRef run={run} className="ml-auto shrink-0" />
      </p>
      <KeyAsking text={asking} />
      <RunBody run={run} now={now} onAttach={onAttach} failure={failure} />
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {draftReady && onOpenDraft ? (
          <button
            type="button"
            onClick={(ev) => (ev.stopPropagation(), onOpenDraft())}
            onKeyDown={ownKey}
            title="The comment is a draft. Nothing is posted until you approve it."
            className="rounded-md border border-ws-pip bg-ws-pip-soft px-2 py-px text-sm font-semibold text-ws-pip hover:brightness-95"
          >
            Draft ready
          </button>
        ) : (
          onDraftComment && (
            <button
              type="button"
              onClick={(ev) => (ev.stopPropagation(), onDraftComment())}
              onKeyDown={ownKey}
              title="Makes a draft you read and edit. Nothing is posted."
              aria-label={`Draft comment on ${ticketLabel(run) ?? title}`}
              className="rounded-md border border-ws-pip px-2 py-px text-sm text-ws-pip hover:bg-ws-pip-soft"
            >
              Draft comment
            </button>
          )
        )}
        {onResume && (
          <button
            type="button"
            data-resume
            onClick={(ev) => (ev.stopPropagation(), onResume())}
            onKeyDown={ownKey}
            title="Wakes the agent to carry on from where it stopped. Its conversation and worktree are kept."
            className="rounded-md border border-ws-pip bg-ws-pip-soft px-2 py-px text-sm font-semibold text-ws-pip hover:brightness-95"
          >
            Resume
          </button>
        )}
        {onBuildFromPlan && (
          <button
            type="button"
            onClick={(ev) => (ev.stopPropagation(), onBuildFromPlan())}
            onKeyDown={ownKey}
            title="Opens a Build draft that carries this plan, for you to read and edit. Nothing starts."
            className="rounded-md border border-ws-pip px-2 py-px text-sm text-ws-pip hover:bg-ws-pip-soft"
          >
            Build from plan
          </button>
        )}
        {onReviewThis && (
          <button
            type="button"
            onClick={(ev) => (ev.stopPropagation(), onReviewThis())}
            onKeyDown={ownKey}
            title="Opens a Review draft for this build's pull request, for you to read and edit. Nothing starts."
            className="rounded-md border border-ws-pip px-2 py-px text-sm text-ws-pip hover:bg-ws-pip-soft"
          >
            Review this
          </button>
        )}
        {descriptionReady && onOpenDescription && (
          <button
            type="button"
            onClick={(ev) => (ev.stopPropagation(), onOpenDescription())}
            onKeyDown={ownKey}
            title="The ticket's description is drafted with this plan added. Nothing is written until you approve it."
            className="rounded-md border border-ws-pip bg-ws-pip-soft px-2 py-px text-sm font-semibold text-ws-pip hover:brightness-95"
          >
            Description update ready
          </button>
        )}
        {breakdownReady && onOpenBreakdown && (
          <button
            type="button"
            onClick={(ev) => (ev.stopPropagation(), onOpenBreakdown())}
            onKeyDown={ownKey}
            title="The subtasks are a draft. Nothing is created until you approve it."
            className="rounded-md border border-ws-pip bg-ws-pip-soft px-2 py-px text-sm font-semibold text-ws-pip hover:brightness-95"
          >
            Breakdown proposed
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 text-sm text-ws-ink3 tabular-nums">
        {tokens && <span>{tokens}</span>}
        {onArchive && (
          <button
            type="button"
            data-archive
            onClick={(ev) => (ev.stopPropagation(), onArchive())}
            onKeyDown={ownKey}
            title={archiveControl(run).title}
            className="rounded-md px-2 py-px text-sm text-ws-ink2 hover:bg-ws-hover"
          >
            Archive
          </button>
        )}
        <time dateTime={ageSince(run)} className="ml-auto" title={run.endedAt ? "Ended" : "Started"}>
          {ageText(run, now)}
        </time>
      </div>
    </article>
  );
}
