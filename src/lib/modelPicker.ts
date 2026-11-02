import type { ConnectionInfo, ModelChoice, ModelOption } from "../types";
import { DEFAULT_MODEL } from "./models";

/** A provider instance as the picker lists it. `unavailable` is why Pip can't run on it now, or null. */
export interface PickerInstance {
  id: string;
  name: string;
  driver: "claude" | "codex";
  unavailable: string | null;
}

/** Why Pip can't run on this provider row right now, in the words the picker greys it with. */
export function unavailableReason(c: Pick<ConnectionInfo, "enabled" | "driver" | "status">): string | null {
  if (c.driver === "codex") return "Pip can't run on Codex yet";
  if (!c.enabled) return "Off";
  switch (c.status?.state) {
    case "notSignedIn":
      return "Not signed in";
    case "notFound":
      return "Not installed";
    case "off":
      return "Off";
    default:
      return null;
  }
}

/** The provider instances in `connections`, in the order given. The row standing in for an unreadable providers list is left out. */
export function pickerInstances(connections: readonly ConnectionInfo[]): PickerInstance[] {
  return connections
    .filter((c) => c.kind === "provider" && c.driver)
    .map((c) => ({ id: c.instanceId, name: c.displayName, driver: c.driver!, unavailable: unavailableReason(c) }));
}

/** Pip's models: whatever the instance lists except "Default", which would leave the choice to the CLI's own default. */
export const pipModels = (models: readonly ModelOption[]): ModelOption[] => models.filter((m) => m.id !== DEFAULT_MODEL);

/** "Claude work · Sonnet": the instance's name and the model's label, or the id when the list doesn't have it. */
export function choiceLabel(choice: ModelChoice | null, instances: readonly PickerInstance[], models: Readonly<Record<string, readonly ModelOption[]>>): string | null {
  const instance = instances.find((i) => i.id === choice?.instanceId);
  if (!choice || !instance) return null;
  const model = models[instance.id]?.find((m) => m.id === choice.model);
  return `${instance.name} · ${model?.label ?? choice.model}`;
}

/** Shown once the person picks a model on another instance than the one Pip last ran on in this conversation. */
export const switchingLine = (name: string) => `Switching to ${name} starts Pip fresh in this conversation. Your messages and drafts stay.`;

/** The instance the choice moves Pip onto, or none when it stays on the one it last ran on (else the Settings default's) in this conversation. */
export function movesTo(instances: readonly PickerInstance[], choice: ModelChoice | null, ranOn: string | undefined, fallback: string | undefined): PickerInstance | undefined {
  if (!choice || (ranOn ?? fallback) === choice.instanceId) return undefined;
  return instances.find((i) => i.id === choice.instanceId);
}
