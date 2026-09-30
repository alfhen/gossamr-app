import type { ReactNode } from "react";
import { checksLine, pillOf, reviewLine, summaryLine, type CodeSummary, type Tone } from "../lib/devLinks";
import type { CheckState, CodeChange, CodeChangeState } from "../types";

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-ws-done",
  bad: "text-ws-blocked",
  pending: "text-ws-warn",
  muted: "text-ws-ink3",
  merged: "text-ws-review",
  accent: "text-ws-accent",
};

export const TONE_PILL: Record<Tone, string> = {
  good: "bg-ws-done-soft text-ws-done",
  bad: "bg-ws-blocked-soft text-ws-blocked",
  pending: "bg-ws-sel text-ws-warn",
  muted: "bg-ws-sel text-ws-ink2",
  merged: "bg-ws-review-soft text-ws-review",
  accent: "bg-ws-accent-soft text-ws-accent",
};

const BADGE_TONE: Record<CodeChangeState, Tone> = { open: "good", draft: "muted", merged: "merged", closed: "muted" };

function Svg({ children, className = "size-3.5", dashed = false }: { children: ReactNode; className?: string; dashed?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed ? "2 1.6" : undefined}>
      {children}
    </svg>
  );
}

export function PullIcon({ state, className }: { state: CodeChangeState; className?: string }) {
  if (state === "merged") {
    return (
      <Svg className={className}>
        <circle cx="4" cy="3.5" r="1.6" />
        <circle cx="4" cy="12.5" r="1.6" />
        <circle cx="12" cy="9" r="1.6" />
        <path d="M4 5.1v5.8M4 6.5c0 2 1.6 2.5 3.5 2.5h2.9" />
      </Svg>
    );
  }
  return (
    <Svg className={className} dashed={state === "draft"}>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 00-2-2H8.5" />
      {state === "closed" ? <path d="M10.4 2.6l3 3M13.4 2.6l-3 3" /> : <path d="M10 3L8.5 4.5 10 6" />}
    </Svg>
  );
}

export function BranchIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="5.5" r="1.6" />
      <path d="M4 5.1v5.8M12 7.1c0 2.6-3.2 2.4-6.4 4.4" />
    </Svg>
  );
}

export function CommitIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M1.5 8h4.1M10.4 8h4.1" />
    </Svg>
  );
}

export function ChecksIcon({ state, className }: { state: CheckState; className?: string }) {
  if (state === "failing") {
    return (
      <Svg className={className}>
        <circle cx="8" cy="8" r="5.6" />
        <path d="M6 6l4 4M10 6l-4 4" />
      </Svg>
    );
  }
  if (state === "passing") {
    return (
      <Svg className={className}>
        <circle cx="8" cy="8" r="5.6" />
        <path d="M5.6 8.2l1.7 1.7 3.2-3.6" />
      </Svg>
    );
  }
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="5.6" strokeDasharray="2.6 2" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    </Svg>
  );
}

export function StatePill({ change }: { change: Pick<CodeChange, "kind" | "state"> }) {
  const pill = pillOf(change);
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-px text-xs font-semibold ${TONE_PILL[pill.tone]}`}>{pill.label}</span>;
}

export function ChecksMark({ checks }: { checks: CheckState }) {
  const line = checksLine(checks);
  if (!line) return null;
  return (
    <span role="img" aria-label={line.label} title={line.label} className={`inline-flex shrink-0 items-center ${TONE_TEXT[line.tone]}`}>
      <ChecksIcon state={checks} />
    </span>
  );
}

export function ReviewChip({ review }: { review: CodeChange["review"] }) {
  const line = reviewLine(review);
  if (!line) return null;
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-px text-xs font-semibold ${TONE_PILL[line.tone]}`}>{line.label}</span>;
}

/** A compact mark for a ticket that has code: the lead pull request's state and how many there are. */
export function PrBadge({ summary, className = "" }: { summary: CodeSummary | null | undefined; className?: string }) {
  if (!summary || (summary.prs === 0 && summary.branches === 0)) return null;
  const tone = summary.state ? BADGE_TONE[summary.state] : "accent";
  const n = summary.prs > 0 ? summary.prs : summary.branches;
  const text = summaryLine(summary);
  return (
    <span
      data-pr-state={summary.state ?? "branch"}
      data-checks={summary.failing ? "failing" : undefined}
      role="img"
      aria-label={text}
      title={text}
      className={`relative inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-xs font-semibold ${TONE_PILL[tone]} ${summary.state === "closed" ? "opacity-60" : ""} ${summary.failing ? "ring-1 ring-ws-blocked" : ""} ${className}`}
    >
      {summary.prs > 0 && summary.state ? <PullIcon state={summary.state} className="size-3" /> : <BranchIcon className="size-3" />}
      {n}
      {summary.failing && <i aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-ws-blocked" />}
    </span>
  );
}

/** GitHub's mark, for rows that come from it. */
export function GithubMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`${className} shrink-0`} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
