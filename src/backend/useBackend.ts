import { useWorkspace } from "../workspaceStore";
import type { Backend } from "./types";

export function useBackend(): Backend | null {
  return useWorkspace((s) => s.backend);
}
