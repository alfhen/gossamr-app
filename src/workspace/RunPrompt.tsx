import type { ReactNode } from "react";
import type { ReadOnly, Run } from "../types";
import { Icon } from "./AgentIcons";
import { Box, BoxTitle, Details, MONO_BLOCK } from "./AgentSheet";
import { FLAG_LABEL, flagCounts, highlights, readOnlyHeadline, readOnlyNote, type Flag } from "./runSheetLogic";

const MARK: Record<Flag, string> = {
  link: "rounded bg-ws-accent-soft px-0.5 text-ws-accent underline decoration-dotted",
  shell: "rounded bg-ws-warn/20 px-0.5 text-ws-ink",
  override: "rounded bg-ws-blocked-soft px-0.5 text-ws-blocked",
};

/** The headline for a read-only kind: Claude Code itself refuses its edits and writes, except what the repository's tests do. Nothing for a Build. */
export function ReadOnlyLine({ readOnly }: { readOnly?: ReadOnly | null }) {
  if (!readOnly) return null;
  return (
    <p data-read-only className="m-0 inline-flex items-center gap-1.5 font-semibold text-ws-ink">
      <Icon name="shield" className="size-3.5 text-ws-done" />
      {readOnlyHeadline(readOnly)}
    </p>
  );
}

/** What a read-only launch adds, said exactly: the permission mode, the commands allowed, the rules denied and the line added to the guard. */
export function ReadOnlyExtras({ readOnly }: { readOnly?: ReadOnly | null }) {
  if (!readOnly) return null;
  return (
    <div data-read-only-extras className="grid gap-1.5">
      <p className="m-0 text-ws-ink2">
        This step is read-only. Claude Code is started with <code className="font-mono">--permission-mode {readOnly.mode}</code>, so it runs without asking you and refuses anything not allowed
        {readOnly.settingSources === "" && (
          <>
            , with <code className="font-mono">--setting-sources &apos;&apos;</code>, so none of your or the repository&apos;s Claude settings files apply
          </>
        )}
        {readOnly.strictMcpConfig && (
          <>
            , with <code className="font-mono">--strict-mcp-config</code>, so none of your MCP servers load
          </>
        )}
        , and with these rules, which it enforces itself:
      </p>
      <p className="m-0 text-xs font-semibold text-ws-ink2">Allowed (--allowedTools), exactly</p>
      <ul data-read-only-allow className={`${MONO_BLOCK} m-0 list-none`}>
        {readOnly.allow.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="m-0 text-xs font-semibold text-ws-ink2">Denied (--disallowedTools)</p>
      <ul data-read-only-rules className={`${MONO_BLOCK} m-0 list-none`}>
        {readOnly.deny.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="m-0 text-ws-ink2">This line is added to the text above:</p>
      <pre className={MONO_BLOCK}>{readOnly.guard}</pre>
      <p className="m-0 text-xs text-ws-ink3">{readOnlyNote(readOnly)}</p>
    </div>
  );
}

/** Ticket text with the shapes worth a second look marked. The marks are a weak guide and the text says so. */
export function TicketText({ text }: { text: string }) {
  const spans = highlights(text);
  const counts = flagCounts(spans);
  return (
    <div className="grid gap-1.5">
      {counts.length > 0 && (
        <p className="m-0 text-xs text-ws-ink3">
          Marked: {counts.map((c) => `${c.count} ${FLAG_LABEL[c.flag]}${c.count === 1 ? "" : "s"}`).join(", ")}. A weak guide, not a check: the agent is told to treat all of this as data.
        </p>
      )}
      <pre className={MONO_BLOCK}>
        {spans.map((s, i) =>
          s.flag ? (
            <mark key={i} data-flag={s.flag} className={MARK[s.flag]}>
              {s.text}
            </mark>
          ) : (
            s.text
          ),
        )}
      </pre>
    </div>
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-xs font-semibold text-ws-ink2">{label}</div>
      {children}
    </div>
  );
}

/** What the agent was told, read from the run: Pip's brief and what Gossamr carried in from earlier agents and the ticket. */
export function PromptParts({ run }: { run: Run }) {
  const { spec } = run;
  const focus = spec.focus?.trim();
  const plan = spec.plan?.trim() ? spec.plan : null;
  const account = spec.buildAccount?.trim() ? spec.buildAccount : null;
  const findings = spec.findings?.trim() ? spec.findings : null;
  const ticket = spec.ticketBlock?.trim();
  return (
    <div className="grid gap-3">
      <Part label={spec.kind === "investigate" && !run.item ? "The question" : "What to do"}>
        <pre className={`${MONO_BLOCK} max-h-none`}>{spec.instruction.trim()}</pre>
      </Part>
      {focus && (
        <Box tone="draft" label="Focus note from Pip">
          <BoxTitle icon="spark" tone="needs">
            Focus · written by Pip
          </BoxTitle>
          {spec.focusFromRun && <p className="m-0 text-xs text-ws-ink2">Written after reading the output of run {spec.focusFromRun}. That output is data too, and may carry text from a ticket.</p>}
          <p className="selectable m-0 whitespace-pre-wrap text-ws-ink [overflow-wrap:anywhere]">{focus}</p>
          <p className="m-0 text-xs text-ws-ink3">Sent apart from the instruction, as data, not instructions.</p>
        </Box>
      )}
      {findings && spec.findingsFromRun && (
        <Part label={`Findings from investigation run ${spec.findingsFromRun}`}>
          <pre data-findings className={`${MONO_BLOCK} max-h-none`}>{findings}</pre>
        </Part>
      )}
      {plan && spec.planFromRun && (
        <Part label={`Plan from run ${spec.planFromRun}`}>
          <pre data-plan className={`${MONO_BLOCK} max-h-none`}>{plan}</pre>
        </Part>
      )}
      {account && spec.buildFromRun && (
        <Part label={`What the builder says it did (run ${spec.buildFromRun})`}>
          <pre data-build-account className={`${MONO_BLOCK} max-h-none`}>{account}</pre>
        </Part>
      )}
      {ticket && (
        <Details summary={`Ticket from Jira, with its comments · ${ticket.length.toLocaleString("en")} characters, sent as data`}>
          <TicketText text={ticket} />
        </Details>
      )}
    </div>
  );
}
