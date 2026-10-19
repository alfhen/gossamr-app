import { useWorkspace } from "../workspaceStore";

export function ReauthBanner() {
  const declined = useWorkspace((s) => s.reauth === "declined");
  if (!declined) return null;
  return (
    <div role="alert" className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ws-blocked/40 bg-ws-blocked-soft px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 text-ws-ink2">Jira signed out, so nothing is syncing. Your drafts, runs and proposals are kept.</span>
      <button type="button" onClick={() => void useWorkspace.getState().reconnect()} className="rounded-md px-2 py-0.5 font-semibold text-ws-accent hover:bg-ws-hover">
        Reconnect
      </button>
    </div>
  );
}
