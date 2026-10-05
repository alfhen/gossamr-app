import { useState } from "react";
import type { Run } from "../types";
import { Box, BoxTitle, Btn } from "./AgentSheet";
import { offeredSessions } from "./runSheetLogic";

/** Sessions that may be this run's conversation carried on under a new id. Gossamr never takes one over when it isn't sure. */
export function RunContinuation({ run, adopt }: { run: Run; adopt(session: string): Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const offered = offeredSessions(run);
  if (offered.length === 0) return null;
  const take = async (session: string) => {
    setBusy(session);
    try {
      await adopt(session);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Box tone="warn" label="Possible continuation">
      <BoxTitle icon="help" tone="warn">
        This run may have continued in another session
      </BoxTitle>
      <p className="m-0 text-ws-ink2">
        {offered.length === 1 ? "A session" : "Sessions"} named like this run{offered.length === 1 ? " was" : " were"} started after it last made progress, and Gossamr couldn&apos;t be sure {offered.length === 1 ? "it is" : "which is"} the same conversation. If it is, adopt it: the run follows that session from then on and keeps this one&apos;s history.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {offered.map((s) => (
          <Btn key={s.shortId} icon="play" disabled={busy !== null} onClick={() => void take(s.shortId)}>
            {busy === s.shortId ? "Adopting…" : <>Adopt session <span className="font-mono">{s.shortId}</span></>}
          </Btn>
        ))}
      </div>
    </Box>
  );
}
