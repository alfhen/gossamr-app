import type { Preflight, RunsEnvironment } from "../types";

const UNKNOWN: RunsEnvironment = { claude: "unknown", version: null };

/** Reads the Claude rows of a pre-flight made without a run; rows that are not about Claude are ignored. */
export function environmentFromPreflight(preflight: Preflight): RunsEnvironment {
  const failed = preflight.rows.filter((r) => r.level === "red").map((r) => r.text);
  const version = preflight.rows.map((r) => /^Claude(?: Code)? (\d+(?:\.\d+)+)\b/.exec(r.text)?.[1]).find(Boolean) ?? null;
  if (failed.some((t) => /claude/i.test(t) && /(not found|isn.t installed|not installed|missing)/i.test(t))) return { claude: "missing", version: null };
  if (failed.some((t) => /(signed in|sign in|signed out|log ?in)/i.test(t))) return { claude: "signedOut", version };
  return { claude: "ok", version };
}

/** A check that cannot be made must not look like a problem with Claude, so any failure reads as unknown. */
export async function readEnvironment(check: () => Promise<Preflight>): Promise<RunsEnvironment> {
  try {
    return environmentFromPreflight(await check());
  } catch {
    return UNKNOWN;
  }
}
