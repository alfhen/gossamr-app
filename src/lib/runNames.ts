/** How runs, drafts and spans of time read to the person: by what they are, never by an id or a raw count of hours. */
import type { Proposal, Run, RunKind } from "../types";

/** A run's step as a noun, for "the CA-402 review". The same steps the Agents view labels Investigate, Plan, Review... */
const KIND_NOUN: Record<RunKind, string> = { investigate: "investigation", triage: "triage", plan: "plan", build: "build", review: "review", verify: "verification" };

type Named = Pick<Run, "spec" | "item">;

/**
 * A run as the person knows it: by ticket and step ("the CA-402 review"), or by repository when it has no ticket ("the
 * investigation on acme/webshop"). Never its id.
 */
export function runPhrase(run: Named | null | undefined): string {
  if (!run) return "an agent run";
  const noun = KIND_NOUN[run.spec.kind] ?? "run";
  if (run.item?.key) return `the ${run.item.key} ${noun}`;
  if (run.spec.repo) return `the ${noun} on ${run.spec.repo}`;
  return `the ${noun}`;
}

/**
 * A draft as the person knows it, by what it is and where it goes: "the review of acme/webshop#218", "the comment
 * draft on CA-402". Never its id. `runs` names the run a follow-up or an answer is for.
 */
export function draftPhrase(p: Pick<Proposal, "intent">, runs: readonly (Named & Pick<Run, "id">)[] = []): string {
  const i = p.intent;
  const runOf = (id: string) => runs.find((r) => r.id === id);
  switch (i.type) {
    case "githubReview":
      return `the review of ${i.repo}#${i.number}`;
    case "comment":
      return `the comment draft on ${i.item.key}`;
    case "rewrite":
      return i.body ? `the description update for ${i.item.key}` : `the title change for ${i.item.key}`;
    case "subtasks":
      return `the breakdown of ${i.parent.key}`;
    case "create":
      return "the new ticket draft";
    case "transition":
      return `the status change for ${i.item.key}`;
    case "update":
      return `the change to ${i.item.key}`;
    case "link":
      return `the link from ${i.from.key} to ${i.to.key}`;
    case "startRun":
      return runPhrase({ spec: i.spec, item: i.item }).replace(/^the /, "the draft ");
    case "followUp": {
      const run = runOf(i.runId);
      return `the follow-up for ${run ? runPhrase(run) : i.item ? `the ${i.item.key} run` : "an agent run"}`;
    }
    case "runAnswer": {
      const run = runOf(i.runId);
      return `the answer for ${run ? runPhrase(run) : i.item ? `the ${i.item.key} run` : "an agent run"}`;
    }
  }
}

/** The ticket a draft is about, if any, for naming the run it came from when that run isn't known here. */
function draftTicket(i: Proposal["intent"]): string | null {
  if ("item" in i && i.item) return i.item.key;
  if (i.type === "subtasks") return i.parent.key;
  if (i.type === "link") return i.from.key;
  return null;
}

/**
 * The run a draft came from, for its "From the CA-402 review" line: `run` when it is known here, else the draft's own
 * ticket ("the CA-402 run", or "the CA-402 review" for a review draft), else "an agent run".
 */
export function fromRunPhrase(p: Pick<Proposal, "intent">, run: Named | null | undefined): string {
  if (run) return runPhrase(run);
  const key = draftTicket(p.intent);
  if (!key) return "an agent run";
  return `the ${key} ${p.intent.type === "githubReview" ? "review" : "run"}`;
}

/**
 * Text Gossamr wrote into a ticket that names the run it came from by id ("Drafted by an agent run (1000addd) on …", "The
 * whole of it is in agent run 1000addd."), as a card shows it: by `name`, "the CA-401 plan". For showing only; what goes
 * to the tracker keeps the id, as an audit trail there.
 */
export function withRunNamed(text: string, name: string): string {
  return text.replace(/\bDrafted by an agent run \([^)\s]+\)/g, `Drafted by ${name}`).replace(/\bin agent run [^\s\]]+?(?=\.?(?:\]|\s|$))/g, `in ${name}`);
}

/**
 * A span of `minutes` as a person reads it: "under a minute", "40 min" below two hours, "3 h" below two days, then
 * "10 days". Each unit is rounded down, so a run quiet for 247 hours reads "10 days", never "247 h".
 */
export function humanDuration(minutes: number): string {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} min`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
