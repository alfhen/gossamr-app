/** Mirrors the conversation ids of src-tauri/src/agent/mod.rs: Pip's General conversation, and one per workstream. */

export const GENERAL_CONVERSATION = "general";
/** What the General conversation was called before workstreams; stored turns under it are General's. */
export const LEGACY_CONVERSATION = "workspace";
const WORKSTREAM_PREFIX = "ws:";

/** The conversation of workstream `id`. */
export const workstreamConversation = (id: string) => `${WORKSTREAM_PREFIX}${id}`;

/** The workstream a conversation belongs to, or null for General and a ticket's own drawer conversation. */
export function workstreamOfConversation(conversation: string | null | undefined): string | null {
  if (!conversation?.startsWith(WORKSTREAM_PREFIX)) return null;
  const id = conversation.slice(WORKSTREAM_PREFIX.length);
  return id || null;
}

/** A conversation id as it is kept: the old name of General reads as General, as `conversation_id` does in Rust. */
export const conversationId = (raw: string) => (raw === LEGACY_CONVERSATION ? GENERAL_CONVERSATION : raw);

/** The connection a conversation id names and the conversation's own name. A workstream's id and a bare name name no connection. As `split_conversation` in Rust. */
export function splitConversation(id: string): { connectionId: string | null; name: string } {
  const at = id.lastIndexOf(":");
  if (id.startsWith(WORKSTREAM_PREFIX) || at <= 0 || at === id.length - 1) return { connectionId: null, name: id };
  return { connectionId: id.slice(0, at), name: id.slice(at + 1) };
}

/** The key a turn on `connectionId` is kept under: `<connection>:<name>`, a workstream's id as it is. As `conversation_in` in Rust. */
export function conversationIn(raw: string, connectionId: string): string {
  const id = conversationId(raw);
  return id.startsWith(WORKSTREAM_PREFIX) ? id : `${connectionId}:${splitConversation(id).name}`;
}

/** The key `raw` is read under: the connection it names, else the primary's. */
export const conversationRead = (raw: string, primary: string): string => {
  const id = conversationId(raw);
  return id.startsWith(WORKSTREAM_PREFIX) || splitConversation(id).connectionId ? id : conversationIn(id, primary);
};

/**
 * The page's key for General while a ticket on `connectionId` is open: the bare name on the primary's connection, which
 * Rust reads as the primary's, else the connection-qualified id Rust stores it under. With no primary known, a known
 * connection qualifies.
 */
export const generalOn = (connectionId: string | null | undefined, primary: string | null | undefined): string =>
  connectionId && connectionId !== primary ? conversationIn(GENERAL_CONVERSATION, connectionId) : GENERAL_CONVERSATION;

/** Whether a conversation is one of the Pip pane's (General or a workstream's), not a ticket's drawer. */
export const isPaneConversation = (id: string) => splitConversation(id).name === GENERAL_CONVERSATION || workstreamOfConversation(id) !== null;
