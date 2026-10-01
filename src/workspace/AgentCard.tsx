import type { KeyboardEvent } from "react";
import type { Run } from "../types";
import { Icon, KIND_ICON } from "./AgentIcons";
import { RunBody, StateChip, TONE, type FailureState } from "./AgentParts";
import { KIND_LABEL, ageSince, ageText, branchOf, formatTokens, repoName, runTitle, stateView } from "./agentsLogic";

export const agentId = (id: string) => `agent-${id}`;

export interface AgentItemProps {
  run: Run;
  now: number;
  selected: boolean;
  position: number;
  total: number;
  /** The ticket's title when it is cached. */
  ticketTitle: string | null;
  onOpen(): void;
  onAttach(): void;
  /** Present on a finished run that has something to post. */
  onDraftComment?(): void;
  failure: FailureState;
}

export const ticketLabel = (run: Run) => run.item?.key ?? null;

export function onActivate(open: () => void) {
  return (ev: KeyboardEvent) => {
    if (ev.target !== ev.currentTarget || ev.key !== "Enter") return;
    ev.preventDefault();
    open();
  };
}

export function AgentCard({ run, now, selected, position, total, ticketTitle, onOpen, onAttach, onDraftComment, failure }: AgentItemProps) {
  const view = stateView(run, now);
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
      onKeyDown={onActivate(onOpen)}
      style={{ ["--c" as string]: tone.color, boxShadow: `inset 3px 0 0 var(--c)${selected ? ", 0 0 0 2px var(--color-ws-accent-soft)" : ""}` }}
      className={`ws-agent-card relative grid cursor-pointer content-start gap-2 rounded-[10px] border py-2.5 pr-3.5 pl-4 outline-offset-2 ${selected ? "border-ws-accent" : needs ? "border-ws-pip/45" : "border-ws-sep"} ${needs ? "bg-ws-pip-soft" : "bg-ws-win"}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-ws-ink2">
          <Icon name={KIND_ICON[run.spec.kind]} className="size-[13px] text-ws-ink3" />
          {KIND_LABEL[run.spec.kind]}
        </span>
        {ticketLabel(run) && <span className="font-mono text-sm font-semibold text-ws-ink2">{ticketLabel(run)}</span>}
        <span className="ml-auto shrink-0">
          <StateChip run={run} now={now} />
        </span>
      </div>
      <h3 className="m-0 line-clamp-2 text-[13.5px] leading-[1.3] font-semibold text-balance [overflow-wrap:anywhere]">{title}</h3>
      <p className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-xs text-ws-ink3" title={`${run.spec.repo} on ${branchOf(run)}`}>
        <Icon name="branch" className="size-3" />
        <span className="min-w-0 truncate">
          {repoName(run.spec.repo)} · {branchOf(run)}
        </span>
      </p>
      <RunBody run={run} now={now} onAttach={onAttach} failure={failure} />
      {onDraftComment && (
        <div>
          <button
            type="button"
            onClick={(ev) => (ev.stopPropagation(), onDraftComment())}
            onKeyDown={(ev) => ev.stopPropagation()}
            title="Makes a draft you read and edit. Nothing is posted."
            className="rounded-md border border-ws-pip px-2 py-px text-sm text-ws-pip hover:bg-ws-pip-soft"
          >
            Draft comment
          </button>
        </div>
      )}
      <div className="flex items-center gap-3 text-sm text-ws-ink3 tabular-nums">
        {tokens && <span>{tokens}</span>}
        <time dateTime={ageSince(run)} className="ml-auto" title={run.endedAt ? "Ended" : "Started"}>
          {ageText(run, now)}
        </time>
      </div>
    </article>
  );
}
