import { useEffect, useState } from "react";
import type { HarnessAction, HarnessStatus } from "../types";
import { useBackend } from "../backend/useBackend";
import { Button } from "../components/Button";

const WORD: Record<HarnessStatus["state"], string> = { starting: "Starting", running: "Running", stopped: "Stopped", failed: "Failed" };

/** Whether the harness runs, its build, and what you can do about it. */
export function HarnessSection() {
  const backend = useBackend();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const read = () =>
      backend.harnessStatus().then(
        (next) => live && setStatus(next),
        () => {},
      );
    void read();
    const off = backend.onHarnessChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [backend]);
  const act = (action: HarnessAction) => {
    if (!backend) return;
    setBusy(true);
    backend
      .harnessStatus(action)
      .then(setStatus, () => {})
      .finally(() => setBusy(false));
  };
  return <HarnessView status={status} busy={busy} onAction={act} />;
}

export function HarnessView({ status, busy, onAction }: { status: HarnessStatus | null; busy: boolean; onAction(action: HarnessAction): void }) {
  const [asking, setAsking] = useState(false);
  if (!status) return <p className="m-0 text-ws-ink2">Checking…</p>;
  const running = status.state === "running";
  return (
    <div data-harness className="grid gap-2.5">
      <p className="m-0 text-ws-ink2">The harness runs your agents beside Gossamr, and keeps them running when you quit.</p>
      <p className="m-0">
        <span data-harness-state>{WORD[status.state]}</span>
        {status.build && <span className="text-ws-ink2">, build {status.build}</span>}
        {status.update && status.bundledBuild && <span className="text-ws-ink2">. Gossamr has build {status.bundledBuild}.</span>}
      </p>
      {status.message && (
        <p className="m-0 text-ws-ink2" role={status.state === "failed" ? "alert" : undefined}>
          {status.message}
        </p>
      )}
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>This stops every agent the harness runs.</span>
          <Button
            destructive
            disabled={busy}
            onClick={() => {
              setAsking(false);
              onAction("stop");
            }}
          >
            Stop all
          </Button>
          <Button variant="quiet" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status.update && (
            <Button disabled={busy} onClick={() => onAction("restart")}>
              Restart the harness to update
            </Button>
          )}
          {(status.state === "stopped" || (status.state === "failed" && !status.update)) && (
            <Button disabled={busy} onClick={() => onAction("start")}>
              {status.state === "failed" ? "Try again" : "Start the harness"}
            </Button>
          )}
          {running && (
            <Button destructive disabled={busy} onClick={() => setAsking(true)}>
              Stop all agents and the harness
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
