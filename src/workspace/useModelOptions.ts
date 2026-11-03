import { useCallback, useEffect, useRef, useState } from "react";
import { pickerInstances, pipModels, type PickerInstance, type PickerPurpose } from "../lib/modelPicker";
import type { ModelDefaults, ModelOption } from "../types";
import { useWorkspace } from "../workspaceStore";

interface Options {
  instances: PickerInstance[];
  models: Record<string, ModelOption[]>;
  defaults: ModelDefaults | null;
}

/** The provider instances `purpose` could run on, their models and the Settings defaults, kept current as connections change. */
export function useModelOptions(purpose: PickerPurpose = "pip") {
  const backend = useWorkspace((s) => s.backend);
  const [options, setOptions] = useState<Options>({ instances: [], models: {}, defaults: null });
  const latest = useRef(0);
  const read = useCallback(async () => {
    if (!backend) return;
    const mine = ++latest.current;
    try {
      const [connections, defaults] = await Promise.all([backend.connectionsList(), backend.modelDefaults()]);
      const instances = pickerInstances(connections, purpose);
      const lists = await Promise.all(instances.map((i) => backend.providerModels(i.id).then(purpose === "pip" ? pipModels : (m) => m, () => null)));
      if (mine !== latest.current) return;
      setOptions((prev) => ({ instances, models: Object.fromEntries(instances.map((i, at) => [i.id, lists[at] ?? prev.models[i.id] ?? []])), defaults }));
    } catch {
      // Settings reports what is wrong with a provider; the list stays as it was.
    }
  }, [backend, purpose]);
  useEffect(() => {
    void read();
    return backend?.onConnectionsChanged(() => void read());
  }, [backend, read]);
  return { ...options, backend, read };
}
