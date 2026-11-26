import type { PermissionRequest, Run } from "../types";

/** What the agent wants, after "wants to", by the kind of request. */
const WANTS: Record<PermissionRequest["kind"], string> = {
  command: "run a command",
  file_change: "change a file",
  permissions: "change its own permissions",
  tool: "use a tool",
  other: "do something Gossamr can't read",
};

export const permissionWants = (request: Pick<PermissionRequest, "kind">) => WANTS[request.kind] ?? WANTS.other;

/** The line a request for more permissions carries: the others ask for one action, this one for more reach. */
export const PERMISSIONS_WARNING = "Allowing this gives the agent more access than it started with.";

/** Why a request has no Allow, or null when it has one. */
export function denyOnlyWhy(request: Pick<PermissionRequest, "kind" | "denyOnly">): string | null {
  if (!request.denyOnly) return null;
  return request.kind === "other" ? "Gossamr can't read this kind of request, so you can only deny it." : "It was too long for Gossamr to get whole, so you can only deny it.";
}

/** The run's open requests: those of a run on the harness. A run without them asks in its own Terminal prompt. */
export const openPermissions = (run: Pick<Run, "permissions">): readonly PermissionRequest[] => run.permissions ?? [];

/** The one line a list row shows for a run with open requests. */
export function permissionsRow(requests: readonly PermissionRequest[]): string {
  return requests.length === 1 ? `Wants to ${permissionWants(requests[0])}` : `Asks ${requests.length} permissions`;
}

/** Where a request's answer is kept while it is on its way: by run and request, since ids are the harness's. */
export const answeringKey = (runId: string, requestId: string) => `${runId}\u0000${requestId}`;
