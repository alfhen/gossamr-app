import { useWorkspace } from "../workspaceStore";
import type { Run } from "../types";

/** The account gh has active, which is who agents push as unless the person's git setup says otherwise. */
function usePushesAs(): string | null {
  return useWorkspace((s) => s.connections.find((c) => c.kind === "github" && c.status?.activeLogin)?.status?.activeLogin ?? null);
}

/** Who a run's commits are by and who pushes them, or nothing before the clone was read. */
export function commitLine(run: Pick<Run, "commitEmail">, pushesAs: string | null): string | null {
  if (!run.commitEmail) return null;
  return pushesAs ? `Commits as ${run.commitEmail} · pushes as ${pushesAs}` : `Commits as ${run.commitEmail}`;
}

/** The run's commit line as a paragraph, or nothing before the clone was read. */
export function CommitsAs({ run, className }: { run: Pick<Run, "commitEmail">; className: string }) {
  const line = commitLine(run, usePushesAs());
  return line && (
    <p data-commits-as className={`m-0 ${className}`} title={line}>
      {line}
    </p>
  );
}
