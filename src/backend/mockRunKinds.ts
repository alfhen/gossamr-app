import type { CodeChange, RunKind, RunSpec } from "../types";

/** The default instruction of each kind, as in src-tauri/src/domain/run.rs. */
export const INSTRUCTIONS: Record<RunKind, string> = {
  investigate: "Investigate this work. Read the code and logs you need, and change nothing. Report what you found, how sure you are, and what you would do next. If you have anything for the tracker, put it under 'For Jira:'.",
  triage: "Triage this work. Size it, say how sure you are, and name the areas of the code it touches and who likely owns them, going by the code and its history. List any duplicates you can find in the code or its notes. Change nothing. Put anything for the tracker under 'For Jira:'.",
  verify: "Check that the change described here works. Read the code, and run the existing tests or commands that only read. Say exactly what you ran and what you could not check. Change nothing. Put anything for the tracker under 'For Jira:'.",
  build: "Make the change this work describes, on your worktree's branch. Keep it small and follow the repository's conventions. Run its tests and commit with a clear message; do not push and do not open a pull request unless a later sentence says you may. Put anything for the tracker under 'For Jira:'.",
  review: "Review the pull request named below, at the commit named there. Fetch it with read-only commands such as `git fetch origin pull/<number>/head` or `gh pr view` and `gh pr diff`. Change nothing on the pull request and do not comment on it. Write your comments most important first, and put anything for the tracker under 'For Jira:'.",
};

export const PUSH_ALLOWED = "You may push your branch and open a pull request. Say what you pushed.";

export const FORK_REFUSAL = "That pull request comes from a fork. Reviewing it would run its code with your settings; Gossamr doesn't allow that yet.";

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why a review can't read this pull request, or null; what the backend checks at draft, review and approve. */
export function reviewRefusal(change: CodeChange | null, spec: Pick<RunSpec, "repo" | "pr">): string | null {
  if (!change) return `Pull request #${spec.pr} wasn't found in ${spec.repo}.`;
  if (change.state === "merged" || change.state === "closed") return `Pull request #${spec.pr} is ${change.state}, so there is nothing to review.`;
  if (change.state === "draft") return `Pull request #${spec.pr} is still a draft.`;
  if (!change.headRepo || !sameRepo(change.headRepo, spec.repo)) return FORK_REFUSAL;
  return null;
}

/** Why a spec can't be drafted, or null; the same matrix as `RunSpec::validate` and `proposals::check`. */
export function specProblem(spec: RunSpec, hasItem: boolean): string | null {
  if (spec.kind === "build" && !hasItem) return "Build needs a ticket.";
  if (spec.kind === "review" && spec.pr == null) return "A review needs a pull request.";
  if (spec.kind !== "review" && spec.pr != null) return "Only a review reads a pull request.";
  if (spec.allowPush && spec.kind !== "build") return "Only a build can push.";
  return null;
}
