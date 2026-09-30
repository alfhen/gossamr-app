import { useStore } from "../store";
import { useWorkspace } from "../workspaceStore";
import type { Backend } from "./types";

/** The backend of whichever interface is running: the workspace's, or the classic inbox's. */
export function useBackend(): Backend | null {
  const workspace = useWorkspace((s) => s.backend);
  const classic = useStore((s) => s.backend);
  return workspace ?? classic;
}
