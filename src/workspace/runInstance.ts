import { staticModels } from "../lib/models";
import { instanceModelLabel } from "../lib/modelPicker";
import type { ModelChoice, Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { DEFAULT_INSTANCE, instanceOf, type RunInstance } from "./providerLogic";

export { instanceOf, type RunInstance };

/** "Runs on Claude work · Sonnet" while the run waits to launch, "Ran on …" once it has; nothing for a run stored before runs recorded a choice. */
export function runsOnText(run: Pick<Run, "state" | "shortId" | "runsOn">, instance: RunInstance | null): string | null {
  const on: ModelChoice | null | undefined = run.runsOn;
  if (!on) return null;
  const launched = run.state !== "queued" && !(run.state === "failed" && !run.shortId);
  return `${launched ? "Ran on" : "Runs on"} ${instanceModelLabel(instance?.name ?? on.instanceId, on.model, staticModels)}`;
}

export function useRunInstance(run: Pick<Run, "runsOn">): RunInstance {
  const connections = useWorkspace((s) => s.connections);
  return instanceOf(connections, run.runsOn?.instanceId ?? DEFAULT_INSTANCE);
}
