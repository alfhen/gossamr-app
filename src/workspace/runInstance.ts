import { CLAUDE_MODELS, CODEX_MODELS } from "../lib/models";
import type { ConnectionInfo, ModelChoice, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { signInCommand } from "./providerLogic";

/** The login a run is on, as the run's cards and its failure help name it. `signIn` is the command for a login in its own folder. */
export interface RunInstance {
  name: string;
  signIn: string | null;
}

const DEFAULT_INSTANCE = "claude";

export const modelLabel = (id: string): string => [...CLAUDE_MODELS, ...CODEX_MODELS].find((m) => m.id === id)?.label ?? id;

/** The provider row `instanceId` names, or its id alone when the row is gone. */
export function instanceOf(connections: readonly Pick<ConnectionInfo, "kind" | "instanceId" | "displayName" | "driver" | "configDir">[], instanceId: string): RunInstance {
  const row = connections.find((c) => c.kind === "provider" && c.instanceId === instanceId);
  if (!row) return { name: instanceId === DEFAULT_INSTANCE ? "Claude" : instanceId, signIn: null };
  return { name: row.displayName, signIn: row.driver && row.configDir ? signInCommand(row.driver, row.configDir) : null };
}

/** "Runs on Claude work · Sonnet" while the run waits to launch, "Ran on …" once it has; nothing for a run stored before runs recorded a choice. */
export function runsOnText(run: Pick<Run, "state" | "shortId" | "runsOn">, instance: RunInstance | null): string | null {
  const on: ModelChoice | null | undefined = run.runsOn;
  if (!on) return null;
  const launched = run.state !== "queued" && !(run.state === "failed" && !run.shortId);
  return `${launched ? "Ran on" : "Runs on"} ${instance?.name ?? on.instanceId} · ${modelLabel(on.model)}`;
}

export function useRunInstance(run: Pick<Run, "runsOn">): RunInstance {
  const connections = useWorkspace((s) => s.connections);
  return instanceOf(connections, run.runsOn?.instanceId ?? DEFAULT_INSTANCE);
}
