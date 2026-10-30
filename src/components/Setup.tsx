import type { AuthStatus } from "../backend/auth";
import { ConnectJiraForm } from "../workspace/ConnectJira";
import { Button } from "./Button";

export function Setup({ onSignedIn, onUseSampleData }: { onSignedIn: (s: AuthStatus) => void; onUseSampleData: () => void }) {
  return (
    <div data-tauri-drag-region className="grid h-full place-items-center overflow-auto bg-ws-win px-6 py-10 text-ws-ink">
      <div className="grid w-full max-w-[520px] gap-5">
        <div>
          <h1 className="font-display m-0 text-xl font-bold">Connect Jira</h1>
          <p className="mt-1 mb-0 text-ws-ink2">Gossamr signs in with an API token you make, so it acts as you with your permissions.</p>
        </div>
        <ConnectJiraForm onConnected={onSignedIn} />
        <div className="border-t border-ws-sep pt-4">
          <Button variant="quiet" onClick={onUseSampleData}>
            Try it with sample data
          </Button>
        </div>
      </div>
    </div>
  );
}
