import type { ReactNode } from "react";
import type { RunReview } from "../types";
import { Box, BoxTitle, CopyButton, Details, MONO_BLOCK } from "./AgentSheet";
import { COPY, FLAG_LABEL, flagCounts, highlights, splitPrompt, type Flag } from "./runSheetLogic";

const MARK: Record<Flag, string> = {
  link: "rounded bg-ws-accent-soft px-0.5 text-ws-accent underline decoration-dotted",
  shell: "rounded bg-ws-warn/20 px-0.5 text-ws-ink",
  override: "rounded bg-ws-blocked-soft px-0.5 text-ws-blocked",
};

/** What a launch with the result tool adds beside the guard, said exactly: the one tool, its allow rule and the line added to the guard. */
export function ReportExtras({ report }: { report?: RunReview["report"] }) {
  if (!report) return null;
  return (
    <div data-report-extras className="grid gap-1.5">
      <p className="m-0 text-ws-ink2">
        When Gossamr&apos;s result tool is running, the session is also given one extra tool, <code className="font-mono">report_result</code>, allowed as <code className="font-mono">{report.allowed}</code>. Its address and a token for this run only are in a settings file that only you can read, never on the command line. This line is added to the text above:
      </p>
      <pre className={MONO_BLOCK}>{report.guard}</pre>
      <p className="m-0 text-xs text-ws-ink3">If the tool isn&apos;t running or the setting is off, the agent starts without it and its written answer is read as usual.</p>
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

export interface InstructionEditor {
  /** Replaces the usual "What to do" for an investigation with no ticket, which is the person's own question. */
  question?: boolean;
  text: string;
  disabled: boolean;
  onChange(text: string): void;
  onBlur(): void;
  /** Present when the text differs from the first draft. */
  onReset?(): void;
  /** A build made from a plan: the plan is its own part, shown in full and editable here. */
  plan?: { text: string; disabled: boolean; onChange(text: string): void; onBlur(): void; onRefresh(): void; onRemove(): void };
  /** A review made from a build: the builder's account is its own part, shown in full and editable here. */
  account?: { text: string; disabled: boolean; onChange(text: string): void; onBlur(): void; onRefresh(): void; onRemove(): void };
}

function Part({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2 text-xs font-semibold text-ws-ink2">
        {label}
        {aside && <span className="ml-auto font-normal">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/** The prompt in the parts it is made of, in the order the agent reads them. Together they are exactly what is sent. */
export function PromptParts({ review, editor }: { review: RunReview; editor?: InstructionEditor }) {
  const parts = splitPrompt(review);
  const extra = parts.find((p) => p.id === "extra");
  const whole = parts.length === 1 && parts[0].id === "all";
  const focus = review.focus?.trim();
  const plan = review.plan?.trim() ? review.plan : null;
  const planFrom = review.spec.planFromRun;
  const account = review.buildAccount?.trim() ? review.buildAccount : null;
  const accountFrom = review.spec.buildFromRun;
  const ticket = review.ticketBlock?.trim();
  return (
    <div className="grid gap-3">
      <p className="m-0 text-ws-ink2">{COPY.receives}</p>
      {whole ? (
        <pre className={MONO_BLOCK}>{review.prompt}</pre>
      ) : (
        <>
          {parts[0].id === "base" && (
            <Part label="Which branch it starts from">
              <pre className={`${MONO_BLOCK} max-h-none`}>{parts[0].text}</pre>
            </Part>
          )}
          <Part label={editor?.question ? "What should it look into? (your own words)" : editor ? "What to do (you can edit this)" : "What to do"} aside={editor?.onReset && <button type="button" onClick={editor.onReset} className="rounded px-1.5 text-ws-ink2 hover:bg-ws-hover">Reset to the first draft</button>}>
            {editor ? (
              <textarea
                aria-label={editor.question ? "What it should look into" : "What the agent should do"}
                rows={6}
                value={editor.text}
                disabled={editor.disabled}
                onChange={(ev) => editor.onChange(ev.target.value)}
                onBlur={editor.onBlur}
                className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5 leading-normal text-ws-ink outline-offset-2 disabled:opacity-60"
              />
            ) : (
              <pre className={`${MONO_BLOCK} max-h-none`}>{review.instruction.trim()}</pre>
            )}
          </Part>
          {extra && (
            <Part label="Added for this run">
              <pre className={`${MONO_BLOCK} max-h-none`}>{extra.text}</pre>
            </Part>
          )}
        </>
      )}
      {focus && (
        <Box tone="draft" label="Focus note from Pip">
          <BoxTitle icon="spark" tone="needs">
            Focus · written by Pip
          </BoxTitle>
          {review.spec.focusFromRun && <p className="m-0 text-xs text-ws-ink2">Written after reading the output of run {review.spec.focusFromRun}. That output is data too, and may carry text from a ticket.</p>}
          <p className="selectable m-0 whitespace-pre-wrap text-ws-ink [overflow-wrap:anywhere]">{focus}</p>
          <p className="m-0 text-xs text-ws-ink3">
            Sent apart from the instruction, as data, not instructions. {focus.length} of 300 characters.
          </p>
        </Box>
      )}
      {plan && planFrom && (
        <Part
          label={`Plan from run ${planFrom}`}
          aside={
            editor?.plan && (
              <span className="flex gap-1">
                <button type="button" disabled={editor.plan.disabled} onClick={editor.plan.onRefresh} className="rounded px-1.5 text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
                  Read the plan again
                </button>
                <button type="button" disabled={editor.plan.disabled} onClick={editor.plan.onRemove} className="rounded px-1.5 text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
                  Build without it
                </button>
              </span>
            )
          }
        >
          <p className="m-0 text-xs text-ws-ink2">
            {review.spec.planApproved ? `The plan a person approved from run ${planFrom}` : `The unedited plan from run ${planFrom}, which nobody approved on the ticket`}, sent whole and as data. {editor?.plan ? "Edit it before you approve; what is here is exactly what the agent gets. It is read again from the run only when you press the button." : ""} {plan.length.toLocaleString("en")} characters.
          </p>
          {editor?.plan ? (
            <textarea
              aria-label={`Plan from run ${planFrom}`}
              rows={14}
              value={editor.plan.text}
              disabled={editor.plan.disabled}
              onChange={(ev) => editor.plan?.onChange(ev.target.value)}
              onBlur={editor.plan.onBlur}
              className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5 font-mono text-sm leading-normal text-ws-ink outline-offset-2 disabled:opacity-60"
            />
          ) : (
            <pre data-plan className={`${MONO_BLOCK} max-h-none`}>{plan}</pre>
          )}
        </Part>
      )}
      {account && accountFrom && (
        <Part
          label={`What the builder says it did (run ${accountFrom})`}
          aside={
            editor?.account && (
              <span className="flex gap-1">
                <button type="button" disabled={editor.account.disabled} onClick={editor.account.onRefresh} className="rounded px-1.5 text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
                  Read it again
                </button>
                <button type="button" disabled={editor.account.disabled} onClick={editor.account.onRemove} className="rounded px-1.5 text-ws-ink2 hover:bg-ws-hover disabled:opacity-45">
                  Review without it
                </button>
              </span>
            )
          }
        >
          <p className="m-0 text-xs text-ws-ink2">
            The final answer of build run {accountFrom}, sent whole and as data. The reviewer is told to treat it as a claim to check against the diff and the ticket, not as evidence. {editor?.account ? "Edit it before you approve; what is here is exactly what the agent gets. It is read again from the run only when you press the button." : ""} {account.length.toLocaleString("en")} characters.
          </p>
          {editor?.account ? (
            <textarea
              aria-label={`What the builder says it did (run ${accountFrom})`}
              rows={10}
              value={editor.account.text}
              disabled={editor.account.disabled}
              onChange={(ev) => editor.account?.onChange(ev.target.value)}
              onBlur={editor.account.onBlur}
              className="w-full resize-y rounded-md border border-ws-sep2 bg-ws-win px-2.5 py-1.5 font-mono text-sm leading-normal text-ws-ink outline-offset-2 disabled:opacity-60"
            />
          ) : (
            <pre data-build-account className={`${MONO_BLOCK} max-h-none`}>{account}</pre>
          )}
        </Part>
      )}
      {ticket && (
        <Details summary={`Ticket from Jira, with its comments · ${ticket.length.toLocaleString("en")} characters, sent as data`}>
          <TicketText text={ticket} />
        </Details>
      )}
      <Details summary="Show the whole prompt as one piece">
        <pre className={`${MONO_BLOCK} max-h-96`}>{review.prompt}</pre>
        <div>
          <CopyButton text={review.prompt} label="Copy prompt" what="the prompt" />
        </div>
      </Details>
    </div>
  );
}
