import type { WorkstreamStage } from "../types";

/** The work Gossamr's drafts and workstream stages know how to read a result of. Mirrors `ResultKind` in src-tauri/src/domain/run.rs. */
export type Step = Exclude<WorkstreamStage, "intake" | "done">;

const NOUNS: Record<string, Step> = { investigator: "investigate", triager: "triage", planner: "plan", builder: "build", reviewer: "review", verifier: "verify" };
const STEPS: readonly Step[] = ["investigate", "triage", "plan", "build", "review", "verify"];

/** The step a role names (`plan` or `planner`), or null for any other label. */
export const stepOf = (role: string): Step | null => STEPS.find((s) => s === role) ?? NOUNS[role] ?? null;

/** The step a workstream counts a run as: an unknown role counts as a build. */
export const stageOf = (role: string): Step => stepOf(role) ?? "build";

/** A role as a label: "builder" reads "Builder". */
export const roleLabel = (role: string): string => (role ? role.charAt(0).toUpperCase() + role.slice(1) : "Agent");
