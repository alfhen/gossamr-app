import type { CheckState, CodeChange, CodeChangeState, CodeFilterKind, DevLink, LinkSource, ReviewState } from "../types";

/** What the code linked to one work item adds up to, for badges and the filters over them. */
export interface CodeSummary {
  prs: number;
  branches: number;
  commits: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
  /** The state of the pull request that matters most; null when there is none. */
  state: CodeChangeState | null;
  /** An open or draft pull request has failing checks. */
  failing: boolean;
  /** The pull request `state` and `failing` come from. */
  lead: CodeChange | null;
}

/** An open pull request needs attention before a draft, which comes before finished ones. */
const RELEVANCE: Record<CodeChangeState, number> = { open: 0, draft: 1, merged: 2, closed: 3 };

const isLive = (c: CodeChange) => c.state === "open" || c.state === "draft";

export function summarize(links: readonly DevLink[]): CodeSummary {
  const seen = new Set<string>();
  const changes = links.map((l) => l.change).filter((c) => !seen.has(c.externalId) && seen.add(c.externalId));
  const prs = changes.filter((c) => c.kind === "pullRequest");
  const count = (state: CodeChangeState) => prs.filter((c) => c.state === state).length;
  const lead = [...prs].sort((a, b) => RELEVANCE[a.state] - RELEVANCE[b.state] || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  return {
    prs: prs.length,
    branches: changes.filter((c) => c.kind === "branch").length,
    commits: changes.filter((c) => c.kind === "commit").length,
    open: count("open"),
    draft: count("draft"),
    merged: count("merged"),
    closed: count("closed"),
    state: lead?.state ?? null,
    failing: prs.some((c) => isLive(c) && c.checks === "failing"),
    lead,
  };
}

export const CODE_FILTERS: readonly CodeFilterKind[] = ["has", "none", "open", "merged", "failing"];

export const CODE_FILTER_LABEL: Record<CodeFilterKind, string> = {
  has: "Has PR",
  none: "No PR",
  open: "PR open",
  merged: "PR merged",
  failing: "Checks failing",
};

/** An item whose links haven't been read yet (`summary` undefined) matches nothing, so "No PR" never claims what it doesn't know. */
export function codeFilterMatches(check: CodeFilterKind, summary: CodeSummary | undefined): boolean {
  if (!summary) return false;
  switch (check) {
    case "has":
      return summary.prs > 0;
    case "none":
      return summary.prs === 0;
    case "open":
      return summary.open + summary.draft > 0;
    case "merged":
      return summary.merged > 0;
    case "failing":
      return summary.failing;
  }
}

export type Tone = "good" | "bad" | "pending" | "muted" | "merged" | "accent";

export interface Pill {
  label: string;
  tone: Tone;
}

const STATE_PILL: Record<CodeChangeState, Pill> = {
  open: { label: "Open", tone: "good" },
  draft: { label: "Draft", tone: "muted" },
  merged: { label: "Merged", tone: "merged" },
  closed: { label: "Closed", tone: "muted" },
};

/** The pill in front of a row: a pull request's state, or what a branch or a commit is. */
export function pillOf(change: Pick<CodeChange, "kind" | "state">): Pill {
  if (change.kind === "branch") return { label: "Branch", tone: "accent" };
  if (change.kind === "commit") return { label: "Commit", tone: "muted" };
  return STATE_PILL[change.state];
}

export function checksLine(checks: CheckState): { label: string; tone: Tone } | null {
  switch (checks) {
    case "passing":
      return { label: "Checks passing", tone: "good" };
    case "failing":
      return { label: "Checks failing", tone: "bad" };
    case "pending":
      return { label: "Checks running", tone: "pending" };
    case "none":
      return null;
  }
}

export function reviewLine(review: ReviewState): { label: string; tone: Tone } | null {
  switch (review) {
    case "approved":
      return { label: "Approved", tone: "good" };
    case "changesRequested":
      return { label: "Changes requested", tone: "bad" };
    case "requested":
      return { label: "Review requested", tone: "pending" };
    case "commented":
      return { label: "Commented", tone: "muted" };
    case "none":
      return null;
  }
}

export interface DiffStat {
  additions: number;
  deletions: number;
  files: number | null;
}

/** Null when nothing is known, which is how a branch or a commit from the cache arrives. */
export function diffStat(c: Pick<CodeChange, "additions" | "deletions" | "changedFiles">): DiffStat | null {
  if (c.additions === null && c.deletions === null && c.changedFiles === null) return null;
  return { additions: c.additions ?? 0, deletions: c.deletions ?? 0, files: c.changedFiles };
}

export const filesLabel = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

const PROVENANCE: Record<LinkSource, string> = {
  branch: "Linked because the ticket key is in the branch name",
  title: "Linked because the ticket key is in the pull request title",
  commit: "Linked because the ticket key is in a commit message",
  body: "Linked because the ticket key is in the description",
};

export const provenanceHint = (source: LinkSource) => PROVENANCE[source];

export const NO_PR_HINT = "No pull request yet. Open one on GitHub to get it reviewed.";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The tooltip on a badge: what is linked and whether anything needs attention. */
export function summaryLine(s: CodeSummary): string {
  if (s.prs === 0) return s.branches > 0 ? `${plural(s.branches, "branch")} without a pull request yet` : "";
  const parts = [
    s.open && `${s.open} open`,
    s.draft && `${s.draft} draft`,
    s.merged && `${s.merged} merged`,
    s.closed && `${s.closed} closed`,
  ].filter(Boolean);
  const lead = s.failing && s.lead ? `. Checks failing on ${s.lead.repo}#${s.lead.number}` : "";
  return `${plural(s.prs, "pull request")}: ${parts.join(", ")}${lead}`;
}

/** What the Pip pane lists under "What I can see" for a ticket with linked code; null when there is none. */
export function developmentLine(s: CodeSummary | undefined): string | null {
  if (!s || (s.prs === 0 && s.branches === 0 && s.commits === 0)) return null;
  const parts = [s.prs && plural(s.prs, "pull request"), s.branches && plural(s.branches, "branch"), s.commits && plural(s.commits, "commit")].filter(Boolean);
  const status = s.prs > 0 ? ` (${summaryLine(s).replace(/^\d+ pull requests?: /, "")})` : "";
  return `Development: ${parts.join(", ")} linked${status}`;
}

/** Rows in the Development section: pull requests first by relevance, then branches, then commits, each newest first. */
export function orderLinks(links: readonly DevLink[]): DevLink[] {
  const rank = (c: CodeChange) => (c.kind === "pullRequest" ? RELEVANCE[c.state] : c.kind === "branch" ? 10 : 20);
  return [...links].sort((a, b) => rank(a.change) - rank(b.change) || b.change.updatedAt.localeCompare(a.change.updatedAt));
}

/** Work item keys in a text, such as a pull request title. */
export function keysIn(text: string): string[] {
  return [...new Set((text.match(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9_]+-\d+(?![0-9])/g) ?? []).map((k) => k.toUpperCase()))];
}
