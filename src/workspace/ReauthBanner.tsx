import { useWorkspace } from "../workspaceStore";
import { Button } from "../components/Button";
import { useJiraUi } from "./jiraUi";

export function ReauthBanner() {
  return <ReauthBannerView dead={useWorkspace((s) => s.reauth)} />;
}

export function ReauthBannerView({ dead }: { dead: boolean }) {
  if (!dead) return null;
  return (
    <div role="alert" className="mx-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ws-blocked/40 bg-ws-blocked-soft px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 text-ws-ink2">Jira turned down your token, so nothing is syncing. Your drafts, runs and proposals are kept.</span>
      <Button size="sm" onClick={() => useJiraUi.getState().openConnect()}>
        Make a new token
      </Button>
    </div>
  );
}
