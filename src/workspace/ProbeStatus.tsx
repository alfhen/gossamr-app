import { useState } from "react";
import { Button } from "../components/Button";
import type { ProbeSnapshot } from "../types";
import { useWorkspace } from "../workspaceStore";
import { agoText } from "./watchLogic";

/** How loud a probe result is: a connection that can't work is an error, one that couldn't be checked is only unsure. */
export function probeTone(status: Pick<ProbeSnapshot, "state">): "ok" | "unsure" | "error" {
  if (status.state === "ready" || status.state === "off") return "ok";
  return status.state === "error" ? "unsure" : "error";
}

const TONE = { ok: "text-ws-ink3", unsure: "text-ws-ink2", error: "text-ws-blocked" } as const;

/** What the last probe of a connection found, when it looked, and a button to look again. */
export function ProbeStatus({ status, now }: { status: ProbeSnapshot; now: Date }) {
  const [checking, setChecking] = useState(false);
  const tone = probeTone(status);
  const check = async () => {
    setChecking(true);
    try {
      await useWorkspace.getState().refreshConnections(true);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div data-probe={status.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <p role={tone === "ok" ? undefined : "status"} className={`m-0 [overflow-wrap:anywhere] ${TONE[tone]}`}>
        {checking ? (
          "Checking…"
        ) : (
          <>
            {status.message}
            {status.fix && (
              <>
                {" "}
                Run <code className="rounded bg-ws-sel px-1 font-mono text-xs">{status.fix}</code>
              </>
            )}
          </>
        )}
      </p>
      <span className="text-ws-ink3">Checked {agoText(status.checkedAt, now)}</span>
      <Button variant="quiet" size="sm" disabled={checking} onClick={() => void check()}>
        Check again
      </Button>
    </div>
  );
}
