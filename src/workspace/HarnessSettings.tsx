import { useEffect, useState } from "react";
import type { HarnessAction, HarnessStatus } from "../types";
import { useBackend } from "../backend/useBackend";
import { Button } from "../components/Button";

const WORD: Record<HarnessStatus["state"], string> = { starting: "Starting", running: "Running", stopped: "Stopped", failed: "Failed" };
const COULD_NOT: Record<HarnessAction, string> = {
  start: "Couldn't start the harness. Try again.",
  restart: "Couldn't restart the harness. Try again.",
  stop: "Couldn't stop the harness. Try again.",
};

/** Whether the harness runs, its build, and what you can do about it. */
export function HarnessSection() {
  const backend = useBackend();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(false);
  const [asks, setAsks] = useState(0);
  const [failed, setFailed] = useState<HarnessAction | null>(null);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const read = () =>
      backend.harnessStatus().then(
        (next) => {
          if (!live) return;
          setStatus(next);
          setUnread(false);
        },
        () => live && setUnread(true),
      );
    void read();
    const off = backend.onHarnessChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [backend, asks]);
  const act = (action: HarnessAction) => {
    if (!backend) return;
    setBusy(true);
    setFailed(null);
    backend
      .harnessStatus(action)
      .then(setStatus, () => setFailed(action))
      .finally(() => setBusy(false));
  };
  if (unread && !status) {
    return (
      <div data-harness className="flex flex-wrap items-center gap-2">
        <span className="text-ws-ink2">Gossamr couldn't ask how the harness stands.</span>
        <Button onClick={() => setAsks((n) => n + 1)}>Try again</Button>
      </div>
    );
  }
  return <HarnessView status={status} busy={busy} failed={failed} unread={unread} onRetry={() => setAsks((n) => n + 1)} onAction={act} />;
}

/** `failed` is the action whose call didn't come back, and `unread` a later read that failed, so the status shown is the one from before. */
export function HarnessView({
  status,
  busy,
  failed = null,
  unread = false,
  onRetry,
  onAction,
}: {
  status: HarnessStatus | null;
  busy: boolean;
  failed?: HarnessAction | null;
  unread?: boolean;
  onRetry?(): void;
  onAction(action: HarnessAction): void;
}) {
  /** Both stop every agent the harness runs, so each asks first. */
  const [asking, setAsking] = useState<"stop" | "restart" | null>(null);
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
      {unread && (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <span className="text-ws-ink2">Gossamr couldn't ask how the harness stands now.</span>
          <Button onClick={onRetry}>Try again</Button>
        </div>
      )}
      {failed && (
        <p className="m-0 text-ws-ink2" role="alert">
          {COULD_NOT[failed]}
        </p>
      )}
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{asking === "stop" ? "This stops every agent the harness runs." : "Restarting stops every agent the harness runs."}</span>
          <Button
            destructive
            disabled={busy}
            onClick={() => {
              setAsking(null);
              onAction(asking);
            }}
          >
            {asking === "stop" ? "Stop all" : "Restart"}
          </Button>
          <Button variant="quiet" onClick={() => setAsking(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status.update && (
            <Button disabled={busy} onClick={() => setAsking("restart")}>
              Restart the harness to update
            </Button>
          )}
          {(status.state === "stopped" || (status.state === "failed" && !status.update)) && (
            <Button disabled={busy} onClick={() => onAction("start")}>
              {status.state === "failed" ? "Try again" : "Start the harness"}
            </Button>
          )}
          {running && (
            <Button destructive disabled={busy} onClick={() => setAsking("stop")}>
              Stop all agents and the harness
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
