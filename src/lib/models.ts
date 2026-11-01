import type { ModelChoice, ModelDefaults, ModelOption } from "../types";

export const DEFAULT_MODEL = "default";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_ID_LIMIT = 100;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]*$/;

/** Letters, digits, `.`, `_`, `-`, `[` and `]`, starting with a letter or digit. The same rule Rust applies. */
export function validModelId(id: string): boolean {
  return id.length <= MODEL_ID_LIMIT && MODEL_ID.test(id);
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: DEFAULT_MODEL, label: "Default" },
  { id: "claude-fable-5-1", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** The built-in list, then the ids added to the instance, leaving out any that is already listed in some case. */
export function modelList(custom: string[]): ModelOption[] {
  const list = [...CLAUDE_MODELS];
  for (const id of custom) {
    if (validModelId(id) && !list.some((m) => m.id.toLowerCase() === id.toLowerCase())) list.push({ id, label: id });
  }
  return list;
}

export function defaultModelDefaults(): ModelDefaults {
  return {
    pip: { instanceId: "claude", model: "sonnet", effort: "medium" } satisfies ModelChoice,
    agents: { instanceId: "claude", model: DEFAULT_MODEL },
  };
}
