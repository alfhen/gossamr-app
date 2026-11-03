import { useEffect } from "react";
import { ModelPicker } from "../components/ModelPicker";
import { pipModels } from "../lib/modelPicker";
import type { ModelDefaults } from "../types";
import { useWorkspace } from "../workspaceStore";
import { defaultsWith } from "./connectionsLogic";
import { useModelOptions } from "./PipModelPicker";

/** The Settings defaults: the Claude and model Pip and new agents use when nothing narrower says. */
export function ModelsSection({ onDefaults }: { onDefaults(defaults: ModelDefaults | null): void }) {
  const pip = useModelOptions("pip");
  const agents = useModelOptions("agents");
  const { backend, defaults } = agents;
  useEffect(() => onDefaults(defaults), [defaults, onDefaults]);
  if (!backend || !defaults) return null;

  const save = async (which: "pip" | "agents", choice: Parameters<typeof defaultsWith>[2]) => {
    try {
      await backend.modelSetDefaults(defaultsWith(defaults, which, choice));
    } catch (e) {
      useWorkspace.getState().report("Couldn't save the model", e);
    } finally {
      await Promise.all([pip.read(), agents.read()]);
    }
  };
  const addModel = async (instanceId: string, model: string) => {
    const listed = await backend.providerAddModel(instanceId, model);
    await Promise.all([pip.read(), agents.read()]);
    return listed;
  };

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4">
        <span className="text-sm font-semibold text-ws-ink2">Pip uses</span>
        <ModelPicker
          instances={pip.instances}
          models={pip.models}
          value={defaults.pip}
          onChange={(choice) => void save("pip", choice)}
          onAddModel={async (instanceId, model) => pipModels(await addModel(instanceId, model))}
          name="Pip uses"
          title="Choose the Claude and model Pip uses by default"
        />
      </div>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4">
        <span className="text-sm font-semibold text-ws-ink2">New agents use</span>
        <ModelPicker
          instances={agents.instances}
          models={agents.models}
          value={defaults.agents}
          onChange={(choice) => void save("agents", choice)}
          onAddModel={addModel}
          name="New agents use"
          title="Choose the Claude and model new agents use by default"
        />
      </div>
    </div>
  );
}
