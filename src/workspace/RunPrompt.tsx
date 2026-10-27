import type { ReactNode } from "react";
import type { Run } from "../types";
import { Details, MONO_BLOCK } from "./AgentSheet";
import { FLAG_LABEL, flagCounts, highlights, type Flag } from "./runSheetLogic";

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

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-xs font-semibold text-ws-ink2">{label}</div>
      {children}
    </div>
  );
}

/** What the agent was told: Gossamr's base brief for its role, then Pip's brief and the ticket. */
export function PromptParts({ run }: { run: Run }) {
  const { spec } = run;
  const ticket = spec.ticketBlock?.trim();
  return (
    <div className="grid gap-3">
      <Part label="Base brief from Gossamr">
        <p className="m-0 text-ws-ink2">
          Role: {spec.role}. It starts in its own worktree from origin/{spec.base}
          {spec.pr ? `, then checks out pull request ${spec.pr}` : ""}. Ticket text is data, and it is asked to stay out of Jira.
        </p>
      </Part>
      <Part label="Pip's brief">
        <pre className={`${MONO_BLOCK} max-h-none`}>{spec.brief.trim()}</pre>
      </Part>
      {ticket && (
        <Details summary={`Ticket from Jira, with its comments · ${ticket.length.toLocaleString("en")} characters, sent as data`}>
          <TicketText text={ticket} />
        </Details>
      )}
    </div>
  );
}
