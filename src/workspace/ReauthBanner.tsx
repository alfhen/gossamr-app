import { useWorkspace } from "../workspaceStore";
import { Button } from "../components/Button";

export function ReauthBanner() {
  const declined = useWorkspace((s) => s.reauth === "declined");
  if (!declined) return null;
  return (
    <div role="alert" className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ws-blocked/40 bg-ws-blocked-soft px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 text-ws-ink2">Jira signed out, so nothing is syncing. Your drafts, runs and proposals are kept.</span>
      <Button size="sm" onClick={() => void useWorkspace.getState().reconnect()}>
        Reconnect
      </Button>
    </div>
  );
}
