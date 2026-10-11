import { Dot, RowText, StateChip } from "./AgentParts";
import { KIND_LABEL, ageText, formatTokens, repoName, runTitle, stateView } from "./agentsLogic";
import { AutoStarted, ReadOnlyBadge, RunLabel, RunRef, agentId, onActivate, ticketLabel, type AgentItemProps } from "./AgentCard";

/** Shared by the header and the rows so the columns line up. */
export const ROW_GRID = "grid items-center gap-x-3 px-3.5 grid-cols-[10px_100px_minmax(0,1.3fr)_minmax(0,1.6fr)_44px] @6xl:grid-cols-[10px_100px_minmax(0,1.3fr)_88px_minmax(0,0.8fr)_minmax(0,1.6fr)_72px_44px]";

export function AgentRowHeader() {
  const h = "text-xs font-semibold tracking-[0.05em] text-ws-ink3 uppercase";
  return (
    <div aria-hidden className={`${ROW_GRID} border-b border-ws-sep bg-ws-bar py-1.5 ${h}`}>
      <span />
      <span>Ticket</span>
      <span>Run</span>
      <span className="hidden @6xl:block">Kind</span>
      <span className="hidden @6xl:block">Repo</span>
      <span>Now</span>
      <span className="hidden text-right @6xl:block">Tokens</span>
      <span className="text-right">Age</span>
    </div>
  );
}

export function AgentRow({ run, now, selected, position, total, ticketTitle, label, onOpen }: AgentItemProps) {
  const view = stateView(run, now);
  const title = runTitle(run, ticketTitle);
  const tokens = formatTokens(run.tokens);
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
      style={selected ? { boxShadow: "inset 3px 0 0 var(--color-ws-accent)" } : undefined}
      className={`${ROW_GRID} cursor-pointer border-b border-ws-sep py-2 outline-offset-[-2px] last:border-b-0 hover:bg-ws-hover ${selected ? "bg-ws-sel" : "bg-ws-win"}`}
    >
      <span title={view.label} className="grid place-items-center">
        <Dot tone={view.tone} live={view.live} />
      </span>
      <span className="truncate font-mono text-sm font-semibold text-ws-ink2">{ticketLabel(run) ?? "none"}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <RunLabel label={label} />
        <span className="min-w-[6ch] truncate font-semibold">{title}</span>
        <RunRef run={run} className="shrink-0" />
        <ReadOnlyBadge run={run} compact />
        <AutoStarted run={run} className="hidden @6xl:inline" />
      </span>
      <span className="hidden truncate text-ws-ink2 @6xl:block">{KIND_LABEL[run.spec.kind]}</span>
      <span className="hidden truncate font-mono text-xs text-ws-ink3 @6xl:block">{repoName(run.spec.repo)}</span>
      <span className="flex min-w-0 items-center gap-2 text-ws-ink2">
        <span className="hidden shrink-0 @md:inline-flex">
          <StateChip run={run} now={now} />
        </span>
        <span className={`min-w-0 truncate ${view.tone === "blocked" ? "text-ws-blocked" : ""}`}><RowText run={run} now={now} /></span>
      </span>
      <span className="hidden truncate text-right text-ws-ink3 tabular-nums @6xl:block">{tokens?.replace(/ tokens?$/, "") ?? ""}</span>
      <span className="text-right text-ws-ink3 tabular-nums">{ageText(run, now)}</span>
    </article>
  );
}
