import type { Run } from "../types";
import { useWorkspace } from "../workspaceStore";

/** "Commits as alf@acme.com · pushes as alfhen"; nothing until git's address in the run's clone has been read. */
export function commitsAsText(run: Pick<Run, "commitEmail">, pushLogin: string | null): string | null {
  const email = run.commitEmail?.trim();
  if (!email) return null;
  return pushLogin ? `Commits as ${email} · pushes as ${pushLogin}` : `Commits as ${email}`;
}

/** The account `gh` is signed in to, which agents push with unless git has another credential. */
function usePushLogin(): string | null {
  return useWorkspace((s) => s.connections.find((c) => c.kind === "github" && c.status?.activeLogin)?.status?.activeLogin ?? null);
}

export function CommitsAs({ run }: { run: Pick<Run, "commitEmail"> }) {
  const text = commitsAsText(run, usePushLogin());
  if (!text) return null;
  return (
    <p data-commits-as className="selectable m-0 text-sm text-ws-ink3 [overflow-wrap:anywhere]">
      {text}
    </p>
  );
}
