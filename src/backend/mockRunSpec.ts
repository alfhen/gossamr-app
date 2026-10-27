import type { CodeChange, RunSpec } from "../types";

export const PLAN_LIMIT = 12_000;

/** Data markers removed until none are left, as `without_markers` in `domain/run.rs`. */
export function withoutMarkers(text: string): string {
  let out = text;
  const marker = /<<<TICKET|TICKET>>>|<<<FOCUS|FOCUS>>>|<<<PLAN|PLAN>>>|<<<BUILD|BUILD>>>|<<<FINDINGS|FINDINGS>>>/g;
  while (new RegExp(marker.source).test(out)) out = out.replace(marker, "");
  return out;
}

/** The most of its brief Pip may write, as `PIP_BRIEF_LIMIT` in `domain/run.rs`. */
export const PIP_BRIEF_LIMIT = 4_000;

/** Pip's brief as the run takes it, or why it is refused; as `valid_brief` in `agent/runs.rs`. */
export function pipBrief(text: string): { brief: string } | { problem: string } {
  const brief = withoutMarkers(text.replace(/\r\n/g, "\n")).trim();
  if (!brief) return { problem: "brief is empty; write what the agent is to do and what to give back" };
  const length = [...brief].length;
  if (length > PIP_BRIEF_LIMIT) return { problem: `brief is ${length} characters; the most is ${PIP_BRIEF_LIMIT}. Shorten it to what the agent needs.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(brief)) return { problem: "brief must be plain text" };
  return { brief };
}

/** A role as `Role::parse` takes it: 1 to 32 letters, digits, spaces and hyphens, trimmed and lowercased. */
export function parseRole(text: string): { role: string } | { problem: string } {
  const role = text.trim().toLowerCase();
  if (!role || [...role].length > 32) return { problem: "role must be 1 to 32 characters: a short label such as planner, builder or reviewer" };
  if (!/^[a-z0-9 -]+$/.test(role)) return { problem: "role may hold only letters, digits, spaces and hyphens" };
  return { role };
}

const FORK_REFUSAL = "That pull request comes from a fork. Reviewing it would run its code with your settings; Gossamr doesn't allow that yet.";

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Why an agent can't check out this pull request, or null; what the backend checks when it starts one. */
export function reviewRefusal(change: CodeChange | null, spec: Pick<RunSpec, "repo" | "pr">): string | null {
  if (!change) return `Pull request #${spec.pr} wasn't found in ${spec.repo}.`;
  if (change.state === "merged" || change.state === "closed") return `Pull request #${spec.pr} is ${change.state}, so there is nothing to review.`;
  if (!change.headRepo || !sameRepo(change.headRepo, spec.repo)) return FORK_REFUSAL;
  return null;
}
