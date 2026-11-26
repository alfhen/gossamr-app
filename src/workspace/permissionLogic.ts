import type { PermissionRequest, Run } from "../types";
import { segments, type Seg } from "./permissionInput";

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

/**
 * Whether Allow may be offered: only where every field of the input is on screen, so never for a request that is masked,
 * cut (its input is text), rebuilt with no input, or that the app marks deny-only.
 */
export const canAllow = (request: Pick<PermissionRequest, "denyOnly" | "masked" | "input">) => !request.denyOnly && !request.masked && request.input != null && typeof request.input === "object" && !Array.isArray(request.input);

/** Why a request has no Allow, or null when it has one: the app's own refusal of an Allow, in runs/on_harness.rs. */
export function denyOnlyWhy(request: Pick<PermissionRequest, "denyOnly" | "masked" | "input">): string | null {
  if (canAllow(request)) return null;
  if (request.masked) return "Part of this is hidden; run it yourself in Terminal if you trust it.";
  if (typeof request.input === "string") return "This request was too large to show whole, so it can only be denied.";
  return "Gossamr can't show all of this request, so it can only be denied.";
}

/** The run's open requests: those of a run on the harness. A run without them asks in its own Terminal prompt. */
export const openPermissions = (run: Pick<Run, "permissions">): readonly PermissionRequest[] => run.permissions ?? [];

/** The one line a list row shows for a run with open requests. */
export function permissionsRow(requests: readonly PermissionRequest[]): string {
  return requests.length === 1 ? `Wants to ${permissionWants(requests[0])}` : `Asks for ${requests.length} permissions`;
}

/** Which of a run's open requests this is, when it has more than one: the same words in its Needs you row and its heading. */
export function requestOrdinal(run: Pick<Run, "permissions">, requestId: string): string | null {
  const open = openPermissions(run);
  return open.length > 1 ? `request ${open.findIndex((p) => p.id === requestId) + 1} of ${open.length}` : null;
}

/** Characters of the subject a Needs you row shows, so two requests of one kind can be told apart. */
const ROW_CHARS = 80;

/**
 * The subject's first line for a row: cut, and with what a terminal hides shown as placeholders. The whole request is in
 * its decision, beside its buttons; this only tells requests apart.
 */
export function subjectLine(subject: string): string {
  const first = flat(segments(subject.split("\n")[0] ?? ""));
  const chars = [...first];
  const more = chars.length > ROW_CHARS || subject.includes("\n");
  return chars.slice(0, ROW_CHARS).join("").trimEnd() + (more ? "…" : "");
}

const flat = (segs: Seg[]) => segs.map((seg) => ("text" in seg ? seg.text : seg.hidden)).join("");

/**
 * Whether a run's requests all wait: one of its answers is on its way, or went through while its request is still listed.
 * Until the list has settled, a click meant for one request can't land on another of the same run.
 */
export function runAnswerPending(runId: string, open: readonly Pick<PermissionRequest, "id">[], answering: ReadonlyMap<string, unknown>, answered: ReadonlySet<string>): boolean {
  const own = (key: string) => key.startsWith(`${runId}\u0000`);
  return [...answering.keys()].some(own) || open.some((request) => answered.has(answeringKey(runId, request.id)));
}

/** Where a request's answer is kept while it is on its way: by run and request, since ids are the harness's. */
export const answeringKey = (runId: string, requestId: string) => `${runId}\u0000${requestId}`;
