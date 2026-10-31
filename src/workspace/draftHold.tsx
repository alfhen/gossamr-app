import { connectionOf, heldNote, madeText } from "../lib/proposals";
import type { ConnectionInfo, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";

/** Who approving an open draft posts as: "Posts as alfhen-acme via GitHub". Null for the sample, which sends nothing. */
export function postsAs(p: Proposal, connections: readonly ConnectionInfo[]): string | null {
  const c = p.state.type === "pending" || p.state.type === "applying" ? connectionOf(p, connections) : null;
  if (!c || c.kind === "mock") return null;
  return `Posts as ${c.kind === "github" ? c.workspace : c.account} via ${c.displayName}`;
}

/** The same as `useHeldNote`, read when asked: for the keys and the palette, which decide at the moment they are used. */
export const heldNow = (p: Proposal): string | null => heldNote(p, useWorkspace.getState().connections);

export function useHeldNote(p: Proposal): string | null {
  return useWorkspace((s) => heldNote(p, s.connections));
}

/** Under a draft's text: that it waits, with how old it is, if its connection is off or being checked again, and otherwise the account it posts as. */
export function DraftAccount({ proposal, className = "text-sm" }: { proposal: Proposal; className?: string }) {
  const connections = useWorkspace((s) => s.connections);
  const held = heldNote(proposal, connections);
  const as = postsAs(proposal, connections);
  if (!held && !as) return null;
  return (
    <p data-draft-account className={`m-0 ${className} ${held ? "text-ws-ink2" : "text-ws-ink3"}`}>
      {held ? `${held} ${madeText(proposal.createdAt, new Date())}.` : as}
    </p>
  );
}
