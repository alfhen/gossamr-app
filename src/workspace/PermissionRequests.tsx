import { useMemo } from "react";
import { Button } from "../components/Button";
import { ButtonGroup } from "../components/ButtonGroup";
import { labelsByRun } from "../lib/workstreamStage";
import type { PermissionRequest, Run } from "../types";
import { CodeBox } from "./AgentSheet";
import { PERMISSIONS_WARNING, answeringKey, canAllow, denyOnlyWhy, openPermissions, permissionWants } from "./permissionLogic";
import { RequestInput } from "./RequestInput";
import { useRuns } from "./runsStore";

type Size = "sm" | "md";

/** What the agent is called in a request: its label in the workstream, else "The agent". */
function useAgentName(run: Run, label?: string) {
  const runs = useRuns((s) => s.runs);
  return useMemo(() => label ?? labelsByRun(runs).get(run.id) ?? "The agent", [label, runs, run.id]);
}

/**
 * One open request with Allow and Deny. Neither is the default: nothing takes the keyboard, neither is the prominent style,
 * and Enter on the card around it opens the run, so allowing takes a deliberate press.
 */
export function PermissionItem({ run, request, label, size }: { run: Run; request: PermissionRequest; label?: string; size?: Size }) {
  const name = useAgentName(run, label);
  const answering = useRuns((s) => s.permissionAnswering.get(answeringKey(run.id, request.id)));
  return <PermissionItemView name={name} request={request} answering={answering ?? null} size={size} onAnswer={(decision) => void useRuns.getState().answerPermission(run.id, request.id, decision)} />;
}

export function PermissionItemView({ name, request, answering, size = "md", onAnswer }: { name: string; request: PermissionRequest; answering: "allow" | "deny" | null; size?: Size; onAnswer(decision: "allow" | "deny"): void }) {
  const why = denyOnlyWhy(request);
  return (
    <div data-permission-request={request.id} className="grid gap-2">
      <p className="m-0 font-semibold text-ws-ink">
        {name} wants to {permissionWants(request)}
      </p>
      {request.tool && (
        <p className="m-0 text-sm text-ws-ink2">
          With <code className="font-mono">{request.tool}</code>:
        </p>
      )}
      {/* Every field of what an allow passes the agent, not only its heading. */}
      {request.input != null ? <RequestInput kind={request.kind} input={request.input} /> : request.subject && <CodeBox text={request.subject} what="the request" wrap />}
      {request.kind === "permissions" && <p className="m-0 text-sm font-semibold text-ws-warn">{PERMISSIONS_WARNING}</p>}
      {why && <p className="m-0 text-sm text-ws-ink2">{why}</p>}
      {/* The card behind takes a click or Enter as opening the run; these buttons are answers of their own. */}
      <div onClick={(ev) => ev.stopPropagation()} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && ev.stopPropagation()}>
        <ButtonGroup label="Answer the permission request">
          {canAllow(request) && (
            <Button size={size} disabled={!!answering} onClick={() => onAnswer("allow")}>
              {answering === "allow" ? "Allowing…" : "Allow"}
            </Button>
          )}
          <Button size={size} disabled={!!answering} onClick={() => onAnswer("deny")}>
            {answering === "deny" ? "Denying…" : "Deny"}
          </Button>
        </ButtonGroup>
      </div>
    </div>
  );
}

/** Every open request of a run, oldest first, each answered on its own. */
export function PermissionRequests({ run, label, size }: { run: Run; label?: string; size?: Size }) {
  return (
    <div data-permission-requests className="grid gap-3">
      {openPermissions(run).map((request) => (
        <PermissionItem key={request.id} run={run} request={request} label={label} size={size} />
      ))}
    </div>
  );
}
