import { useCallback, useEffect, useState } from "react";
import type { ModelPickerProps } from "../components/ModelPicker";
import { useClaude } from "../claudeStore";
import { movesTo, pickerInstances, pipModels, switchingLine, type PickerInstance } from "../lib/modelPicker";
import type { ModelChoice, ModelDefaults, ModelOption } from "../types";
import { useWorkspace } from "../workspaceStore";
import { providersVisible } from "./connectionsLogic";
import { useTabs } from "./tabsStore";

interface Options {
  instances: PickerInstance[];
  models: Record<string, ModelOption[]>;
  defaults: ModelDefaults | null;
}

/** The provider instances Pip could run on, their models and the Settings default, kept current as connections change. */
function useOptions() {
  const backend = useWorkspace((s) => s.backend);
  const [options, setOptions] = useState<Options>({ instances: [], models: {}, defaults: null });
  const read = useCallback(async () => {
    if (!backend) return;
    try {
      const [connections, defaults] = await Promise.all([backend.connectionsList(), backend.modelDefaults()]);
      const instances = pickerInstances(connections);
      const lists = await Promise.all(instances.map((i) => (i.unavailable ? Promise.resolve([]) : backend.providerModels(i.id).then(pipModels, () => []))));
      setOptions({ instances, models: Object.fromEntries(instances.map((i, at) => [i.id, lists[at]])), defaults });
    } catch {
      // The header still shows the choice without names; Settings reports what is wrong with a provider.
    }
  }, [backend]);
  useEffect(() => {
    void read();
    return backend?.onConnectionsChanged(() => void read());
  }, [backend, read]);
  return { ...options, backend, read };
}

/** What Pip's header needs to show and change the instance and model its next turns in `conversation` run on; null before the backend is there. */
export function usePipModel(conversation: string): { picker: ModelPickerProps; note: string | null } | null {
  const { instances, models, defaults, backend, read } = useOptions();
  const chosen = useClaude((s) => s.choices[conversation]);
  const ranOn = useClaude((s) => [...(s.byTicket[conversation]?.turns ?? [])].reverse().find((t) => t.model)?.model?.instanceId);
  if (!backend) return null;
  const value: ModelChoice | null = chosen ?? defaults?.pip ?? null;
  const target = movesTo(instances, value, ranOn, defaults?.pip?.instanceId);
  return {
    picker: {
      instances,
      models,
      value,
      onChange: (choice) => useClaude.getState().choose(conversation, choice),
      onAddModel: async (instanceId, model) => {
        await backend.providerAddModel(instanceId, model);
        await read();
      },
      ...(providersVisible() ? { onManage: () => useTabs.getState().openSettings("connections") } : {}),
    },
    note: target ? switchingLine(target.name) : null,
  };
}
