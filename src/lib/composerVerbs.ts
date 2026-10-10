import type { Backend } from "../backend/types";
import type { Run } from "../types";
import { labelsByRun, runLabels } from "./workstreamStage";

/**
 * Commands typed into Pip's composer that act without going to Pip: `/stop R1`, `/retry R1`, `/answer R1 text` on a run,
 * and `/hold`, `/resume` on the conversation's workstream. They call the same user-only commands as the run's own
 * buttons and the workstream's header; Pip has no tool for any of them and never sees them.
 */

export const COMPOSER_VERBS = ["stop", "retry", "answer", "hold", "resume"] as const;
export type ComposerVerb = (typeof COMPOSER_VERBS)[number];
/** The verbs that act on the conversation's workstream and take no run. */
export const WORKSTREAM_VERBS = ["hold", "resume"] as const satisfies readonly ComposerVerb[];
type WorkstreamVerb = (typeof WORKSTREAM_VERBS)[number];
type RunVerb = Exclude<ComposerVerb, WorkstreamVerb>;

/** Fewest characters of a run's id that name it outside a workstream. */
export const MIN_ID_PREFIX = 4;

/** The part of a run's id the screen shows on its card, row and sheet, and that the commands take anywhere: its first 8 characters, or all of a short one. */
export const runRef = (run: Pick<Run, "id">) => (run.id.length <= 12 ? run.id : run.id.slice(0, 8));

export const VERB_HINT =
  "Commands are /stop R1, /retry R1 and /answer R1 your answer, and in a workstream /hold and /resume. R1 is a run in this workstream; a run's id works anywhere.";

export type ParsedVerb = { type: "verb"; verb: RunVerb; ref: string; text: string } | { type: "workstream"; verb: WorkstreamVerb } | { type: "problem"; message: string };

const isVerb = (word: string): word is ComposerVerb => (COMPOSER_VERBS as readonly string[]).includes(word);
const isWorkstreamVerb = (word: ComposerVerb): word is WorkstreamVerb => (WORKSTREAM_VERBS as readonly string[]).includes(word);

/** What the composer was given: a command, a command it can't take (with why), or null for a question that goes to Pip. */
export function parseVerb(input: string): ParsedVerb | null {
  const m = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  if (!isVerb(word)) return { type: "problem", message: `/${m[1]} isn't a command. ${VERB_HINT}` };
  if (isWorkstreamVerb(word)) return (m[2] ?? "").trim() ? { type: "problem", message: `/${word} takes no run; it ${word}s this workstream` } : { type: "workstream", verb: word };
  const [, ref = "", rest = ""] = /^(\S*)\s*([\s\S]*)$/.exec((m[2] ?? "").trim()) ?? [];
  if (!ref) return { type: "problem", message: `Say which run to ${word}, such as /${word} R1` };
  const text = rest.trim();
  if (word === "answer" && !text) return { type: "problem", message: "Say what to answer, such as /answer R1 use the staging database" };
  if (word !== "answer" && text) return { type: "problem", message: `/${word} takes only the run, such as /${word} R1` };
  return { type: "verb", verb: word, ref, text };
}

export type ResolvedRun = { run: Run; label: string } | { error: string };

/**
 * The run `ref` names: `R<n>` among the runs of `workstream` (numbered as its conversation numbers them), or a run's short
 * id, id or a prefix of its id at least MIN_ID_PREFIX long, among every run. `label` is how the outcome names it.
 */
export function resolveRun(ref: string, runs: readonly Run[], workstream: string | null): ResolvedRun {
  const short = /^R(\d+)$/i.exec(ref);
  const mine = workstream ? runs.filter((r) => r.spec.workstream === workstream) : [];
  const labels = new Map(runLabels(mine));
  const labelOf = (run: Run) => labels.get(run.id) ?? `run ${runRef(run)}`;
  if (short) {
    const name = `R${Number(short[1])}`;
    if (!workstream) {
      // R1 is a workstream's own numbering; here, point at the id the run's card shows.
      const named = [...labelsByRun(runs)].filter(([, label]) => label === name).map(([id]) => runs.find((r) => r.id === id));
      const only = named.length === 1 ? named[0] : undefined;
      return { error: only ? `${name} is a workstream's name for a run; here, use its id ${runRef(only)}` : `${name} names a run in a workstream; here, use the id shown on the run's card` };
    }
    const id = [...labels].find(([, label]) => label === name)?.[0];
    const run = id ? mine.find((r) => r.id === id) : undefined;
    return run ? { run, label: name } : { error: `No run ${name} in this workstream` };
  }
  if (ref.length < MIN_ID_PREFIX) return { error: `Give at least ${MIN_ID_PREFIX} characters of the run's id, or R1 in a workstream` };
  const want = ref.toLowerCase();
  const exact = runs.filter((r) => r.id.toLowerCase() === want || r.shortId?.toLowerCase() === want);
  const found = exact.length ? exact : runs.filter((r) => r.id.toLowerCase().startsWith(want) || !!r.shortId?.toLowerCase().startsWith(want));
  if (found.length === 1) return { run: found[0], label: labelOf(found[0]) };
  return { error: found.length ? `${ref} matches more than one run; give more of its id` : `No run ${ref}` };
}

export interface VerbOutcome {
  ok: boolean;
  message: string;
}

const DONE: Record<RunVerb, string> = { stop: "Stopped", retry: "Retrying", answer: "Answered" };
const WORKSTREAM_DONE: Record<WorkstreamVerb, string> = {
  hold: "Held this workstream. Its agents carry on; nothing starts on its own until you resume",
  resume: "Resumed this workstream",
};

/**
 * Carries out what the composer was given, or returns null when it is a question for Pip. The outcome is what to tell the
 * person; a refusal from the backend comes back as a failed outcome, not a throw.
 */
export function runComposerVerb(
  input: string,
  {
    runs,
    workstream,
    backend,
    heldReason = null,
  }: {
    runs: readonly Run[];
    workstream: string | null;
    backend: Pick<Backend, "runsStop" | "runsRetryLaunch" | "runsAnswer" | "workstreamsHold" | "workstreamsResume"> | null;
    /** Why the workstream is held now, if it is: a second /hold changes nothing and says so. */
    heldReason?: string | null;
  },
): Promise<VerbOutcome> | null {
  const parsed = parseVerb(input);
  if (!parsed) return null;
  if (parsed.type === "problem") return Promise.resolve({ ok: false, message: parsed.message });
  if (parsed.type === "workstream") {
    const { verb } = parsed;
    if (!workstream) return Promise.resolve({ ok: false, message: `/${verb} works in a workstream's conversation; open the workstream on its ticket first` });
    if (!backend) return Promise.resolve({ ok: false, message: "Not connected yet." });
    if (verb === "hold" && heldReason) return Promise.resolve({ ok: true, message: "This workstream is held already" });
    const call = async () => (verb === "hold" ? backend.workstreamsHold(workstream) : backend.workstreamsResume(workstream));
    return call().then(
      () => ({ ok: true, message: WORKSTREAM_DONE[verb] }),
      (e: unknown) => ({ ok: false, message: `Couldn't ${verb} this workstream. ${e instanceof Error ? e.message : String(e)}` }),
    );
  }
  const found = resolveRun(parsed.ref, runs, workstream);
  if ("error" in found) return Promise.resolve({ ok: false, message: found.error });
  if (!backend) return Promise.resolve({ ok: false, message: "Not connected yet." });
  const { run, label } = found;
  const { verb, text } = parsed;
  const call = async () => (verb === "stop" ? backend.runsStop(run.id) : verb === "retry" ? backend.runsRetryLaunch(run.id) : backend.runsAnswer(run.id, text));
  return call().then(
    () => ({ ok: true, message: `${DONE[verb]} ${label}` }),
    (e: unknown) => ({ ok: false, message: `Couldn't ${verb} ${label}. ${e instanceof Error ? e.message : String(e)}` }),
  );
}
