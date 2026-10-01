import type { ReactNode } from "react";
import type { RunReview } from "../types";
import { Box, BoxTitle, CopyButton, Details, MONO_BLOCK } from "./AgentSheet";
import { COPY, FLAG_LABEL, flagCounts, highlights, splitPrompt, type Flag } from "./runSheetLogic";

const MARK: Record<Flag, string> = {
  link: "rounded bg-ws-accent-soft px-0.5 text-ws-accent underline decoration-dotted",
  shell: "rounded bg-ws-warn/20 px-0.5 text-ws-ink",
  override: "rounded bg-ws-blocked-soft px-0.5 text-ws-blocked",
};

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
  text: string;
  disabled: boolean;
  onChange(text: string): void;
  onBlur(): void;
  /** Present when the text differs from the first draft. */
  onReset?(): void;
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
          <Part label={editor ? "What to do (you can edit this)" : "What to do"} aside={editor?.onReset && <button type="button" onClick={editor.onReset} className="rounded px-1.5 text-ws-ink2 hover:bg-ws-hover">Reset to the first draft</button>}>
            {editor ? (
              <textarea
                aria-label="What the agent should do"
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
      {ticket && (
        <Details summary={`Ticket text from Jira · ${ticket.length.toLocaleString("en")} characters, sent as data`}>
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
