import { useEffect, useState } from "react";
import type { Backend } from "../backend/types";
import type { Run } from "../types";
import { Btn, Box, CodeBox, Sec } from "./AgentSheet";
import { branchOf } from "./agentsLogic";
import { formatBytes } from "./runSheetLogic";

/** What the session's files take up, read when the sheet opens; null while loading and "unknown" when it can't be read. */
export function useDisk(backend: Backend | null, runId: string): number | null | "unknown" {
  const [size, setSize] = useState<number | null | "unknown">(null);
  useEffect(() => {
    let live = true;
    setSize(null);
    backend?.runsDisk(runId).then(
      (n) => live && setSize(n),
      () => live && setSize("unknown"),
    );
    return () => {
      live = false;
    };
  }, [backend, runId]);
  return size;
}

export interface Place {
  label: string;
  value: string;
  what: string;
}

export const placesOf = (run: Pick<Run, "expectedWorktree" | "spec" | "branch">): Place[] => [
  { label: "Worktree: where it edits", value: run.expectedWorktree, what: "the worktree path" },
  { label: "Your clone it was made from", value: run.spec.clonePath, what: "the clone path" },
  { label: "Branch", value: branchOf(run), what: "the branch name" },
];

export function RunWhere({ run, disk, onReveal }: { run: Run; disk: number | null | "unknown"; onReveal(path: string): void }) {
  return (
    <Sec title="Where it runs" aside={<Btn tone="ghost" icon="folder" className="py-px" onClick={() => onReveal(run.expectedWorktree)}>Reveal in Finder</Btn>}>
      <Box>
        {placesOf(run).map((p) => (
          <div key={p.label} className="grid gap-1">
            <span className="text-xs font-medium text-ws-ink3">{p.label}</span>
            <CodeBox text={p.value} what={p.what} />
          </div>
        ))}
        <p className="m-0 text-sm text-ws-ink2">
          A separate worktree of your clone. Your own checkout is not touched, and stopping keeps everything it wrote.
          {typeof disk === "number" && disk > 0 && <> Its session files take up {formatBytes(disk)}.</>}
          {disk === "unknown" && <> The size of its session files couldn&apos;t be read.</>}
        </p>
      </Box>
    </Sec>
  );
}
