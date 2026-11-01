import type { ModelChoice, ModelDefaults, ModelOption } from "../types";
import { DEFAULT_MODEL, EFFORTS, MODEL_ID_LIMIT, defaultModelDefaults, modelList, validModelId } from "../lib/models";

const NOT_A_PROVIDER = "This isn't a provider. Reopen Settings.";
const CUSTOM_MODEL_LIMIT = 20;

/** Model lists and Settings defaults for the mock's provider instances, checked the way the desktop backend checks them. */
export class MockModels {
  private custom = new Map<string, string[]>();
  private defaults: ModelDefaults = defaultModelDefaults();

  constructor(private readonly isProvider: (instanceId: string) => boolean) {}

  list(instanceId: string): ModelOption[] {
    this.require(instanceId);
    return modelList(this.custom.get(instanceId) ?? []);
  }

  add(instanceId: string, model: string): ModelOption[] {
    this.require(instanceId);
    if (!validModelId(model)) throw new Error(`A model id uses letters, digits and . _ - [ ], starts with a letter or digit, and is at most ${MODEL_ID_LIMIT} characters.`);
    if (this.list(instanceId).some((m) => m.id.toLowerCase() === model.toLowerCase())) return this.list(instanceId);
    const added = this.custom.get(instanceId) ?? [];
    if (added.length >= CUSTOM_MODEL_LIMIT) throw new Error(`Keep it to ${CUSTOM_MODEL_LIMIT} added models. Remove one from config.json first.`);
    this.custom.set(instanceId, [...added, model]);
    return this.list(instanceId);
  }

  get(): ModelDefaults {
    return structuredClone(this.defaults);
  }

  set(next: ModelDefaults): ModelDefaults {
    this.check("Pip", next.pip);
    this.check("this run", next.agents);
    this.defaults = structuredClone(next);
    return this.get();
  }

  /** A removed instance takes the defaults that named it, and its added models. */
  forget(instanceId: string) {
    this.custom.delete(instanceId);
    for (const key of ["pip", "agents"] as const) if (this.defaults[key]?.instanceId === instanceId) this.defaults[key] = null;
  }

  private require(instanceId: string) {
    if (!this.isProvider(instanceId)) throw new Error(NOT_A_PROVIDER);
  }

  private check(what: string, choice: ModelChoice | null) {
    if (!choice) return;
    const forPip = what === "Pip";
    const listed = this.isProvider(choice.instanceId) && this.list(choice.instanceId).some((m) => m.id === choice.model);
    const effortOk = choice.effort == null || (forPip && (EFFORTS as readonly string[]).includes(choice.effort));
    if (!this.isProvider(choice.instanceId)) throw new Error(forPip ? "Pick which Claude Pip runs on." : "That instance was removed. Pick another.");
    if (!listed || !effortOk || (forPip && choice.model === DEFAULT_MODEL)) throw new Error(`Pick a model for ${what}.`);
  }
}
