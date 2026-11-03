import type { ModelChoice, ModelDefaults, ModelOption } from "../types";

export const DEFAULT_MODEL = "default";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const MODEL_ID_LIMIT = 100;
export const MODEL_ID_RULE = `Use letters, digits and . _ - [ ], starting with a letter or digit, up to ${MODEL_ID_LIMIT} characters.`;
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

/** What the desktop app lists for Codex when `codex debug models` can't be read. */
export const CODEX_MODELS: ModelOption[] = [
  { id: DEFAULT_MODEL, label: "Default" },
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
  { id: "gpt-6-sol", label: "GPT-6-Sol" },
  { id: "gpt-6-luna", label: "GPT-6-Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

export type Driver = "claude" | "codex";

/** What each driver can run. Mirrors `Driver::runs_pip` and `Driver::runs_agents` in connections.rs; a test keeps them equal. */
export const DRIVERS: Record<Driver, { label: string; runsPip: boolean; runsAgents: boolean; beta: boolean }> = {
  claude: { label: "Claude", runsPip: true, runsAgents: true, beta: false },
  codex: { label: "Codex", runsPip: false, runsAgents: true, beta: true },
};

/** The driver's built-in list, then the ids added to the instance, leaving out any that is already listed in some case. */
export function modelList(custom: string[], driver: Driver = "claude"): ModelOption[] {
  const list = [...(driver === "codex" ? CODEX_MODELS : CLAUDE_MODELS)];
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

/** The label the built-in lists give a model id, for a place that has no instance's list at hand. */
export const staticModels: readonly ModelOption[] = [...CLAUDE_MODELS, ...CODEX_MODELS];
