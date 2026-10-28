import { SUMMARY_ONLY, type CodeChange, type Run, type RunOutcome } from "../types";
import { Box, Btn, CopyButton, Sec } from "./AgentSheet";
import { changeSummary, reportNotes, SOURCE_CHIP } from "./runSheetLogic";

export interface ResultActions {
  askPip(): void;
  openChange(url: string): void;
}

export interface ResultProps {
  run: Run;
  outcome: RunOutcome | null;
  on: ResultActions;
}

export function Found({ run, outcome, on }: ResultProps) {
  const text = outcome?.note ?? run.result;
  const source = outcome?.source ? SOURCE_CHIP[outcome.source] : null;
  return (
    <Sec title="What it found">
      <Box>
        {source && <p className="m-0 text-xs text-ws-ink3">{source.label}</p>}
        {outcome?.summaryOnly && <p role="note" className="m-0 text-sm text-ws-warn">{SUMMARY_ONLY}</p>}
        <p data-run-report className="selectable m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text || "It finished without a written answer."}</p>
        {reportNotes(outcome).map((note) => <p key={note} className="m-0 text-sm text-ws-ink3">{note}</p>)}
        <div className="flex flex-wrap items-center gap-2">
          <Btn icon="spark" onClick={on.askPip}>Ask Pip</Btn>
          {text && <CopyButton text={text} label="Copy" what="the result" />}
        </div>
        <p className="m-0 text-xs text-ws-ink3">Pip can draft from this report. Nothing reaches Jira or GitHub until you approve a draft.</p>
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
