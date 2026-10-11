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

/** Whether a conversation is one of the Pip pane's (General or a workstream's), not a ticket's drawer. */
export const isPaneConversation = (id: string) => id === GENERAL_CONVERSATION || workstreamOfConversation(id) !== null;
