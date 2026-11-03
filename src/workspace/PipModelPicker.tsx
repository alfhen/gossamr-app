import { useEffect } from "react";
import type { ModelPickerProps } from "../components/ModelPicker";
import { useClaude } from "../claudeStore";
import { movesTo, pipModels, switchingLine } from "../lib/modelPicker";
import type { ModelChoice } from "../types";
import { useTabs } from "./tabsStore";
import { useModelOptions } from "./useModelOptions";

/** What Pip's header needs to show and change the instance and model its next turns in `conversation` run on; null before the backend is there. */
export function usePipModel(conversation: string): { picker: ModelPickerProps; note: string | null } | null {
  const { instances, models, defaults, backend, read } = useModelOptions();
  const chosen = useClaude((s) => s.choices[conversation]);
  const ranOn = useClaude((s) => [...(s.byTicket[conversation]?.turns ?? [])].reverse().find((t) => t.model)?.model?.instanceId);
  const fallback = defaults?.pip ?? null;
  useEffect(() => useClaude.getState().setFallback(fallback), [fallback]);
  if (!backend) return null;
  const value: ModelChoice | null = chosen ?? fallback;
  const target = movesTo(instances, value, ranOn, defaults?.pip?.instanceId);
  return {
    picker: {
      instances,
      models,
      value,
      onChange: (choice) => useClaude.getState().choose(conversation, choice),
      name: "Your next message to Pip runs on",
      title: "Choose the Claude and model for your next message to Pip",
      onAddModel: async (instanceId, model) => {
        const listed = await backend.providerAddModel(instanceId, model);
        await read();
        return pipModels(listed);
      },
      onManage: () => useTabs.getState().openSettings("connections"),
    },
    note: target ? switchingLine(target.name) : null,
  };
}
