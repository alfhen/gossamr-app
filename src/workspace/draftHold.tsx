import { connectionOf, heldNote } from "../lib/proposals";
import type { ConnectionInfo, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";

/** Who approving an open draft posts as: "Posts as alfhen-acme via GitHub". Null for the sample, which sends nothing. */
export function postsAs(p: Proposal, connections: readonly ConnectionInfo[]): string | null {
  const c = p.state.type === "pending" || p.state.type === "applying" ? connectionOf(p, connections) : null;
  if (!c || c.kind === "mock") return null;
  return `Posts as ${c.kind === "github" ? c.workspace : c.account} via ${c.displayName}`;
}

export function useHeldNote(p: Proposal): string | null {
  return useWorkspace((s) => heldNote(p, s.connections));
}

/** Under a draft's text: that it waits, if its connection is off, and the account it posts as. */
export function DraftAccount({ proposal }: { proposal: Proposal }) {
  const connections = useWorkspace((s) => s.connections);
  const held = heldNote(proposal, connections);
  const as = postsAs(proposal, connections);
  if (!held && !as) return null;
  return (
    <p data-draft-account className={`m-0 text-sm ${held ? "text-ws-ink2" : "text-ws-ink3"}`}>
      {held ?? as}
    </p>
  );
}
