import { docText } from "../lib/docs";
import { containerKey, itemKey } from "../lib/filter";
import { liveMentions, type Mention } from "../lib/mentions";
import type { ContainerRef, ItemRef, Proposal, ProposalEdit, WorkItem, WorkItemKind } from "../types";
import type { PeekSectionId } from "./peekLogic";
import { useTabs } from "./tabsStore";

const PREFIX = "draft:";

/** What `useTabs().selected` holds while a draft ticket is open; it can't equal an item key, which has a connection id in front. */
export const draftKey = (proposalId: string) => `${PREFIX}${proposalId}`;

export const draftIdOf = (key: string | null): string | null => (key?.startsWith(PREFIX) ? key.slice(PREFIX.length) : null);

export const ITEM_KINDS: readonly WorkItemKind[] = ["task", "bug", "story", "epic"];

/** Selects a draft ticket, which opens it in the peek sheet. */
export function showDraft(proposalId: string) {
  const tabs = useTabs.getState();
  tabs.setRoute("workspace");
  tabs.select(draftKey(proposalId));
}

type Created = Extract<Proposal["intent"], { type: "create" }>;

export const isCreate = (p: Proposal | undefined): p is Proposal & { intent: Created } => p?.intent.type === "create";

/** A draft the sheet can still show: waiting, being created, or just created and about to hand over to the real ticket. */
export const showsAsDraftTicket = (p: Proposal | undefined): p is Proposal & { intent: Created } => isCreate(p) && ["pending", "applying", "applied"].includes(p.state.type);

/** The sections a draft ticket has; the rest have nothing to show for an item that doesn't exist yet. */
export function draftSections(): Record<PeekSectionId | "subtasks" | "drafts", boolean> {
  return { description: true, subtasks: false, links: false, development: false, comments: false, history: false, drafts: false };
}

/** The draft as an item, so the sheet's layout can be reused. It is never stored. */
export function draftItem(p: Proposal & { intent: Created }, updated = p.updatedAt): WorkItem {
  const { fields, container } = p.intent;
  const ref: ItemRef = { connectionId: container.connectionId, externalId: draftKey(p.id), key: "NEW" };
  return {
    item: ref,
    container,
    kind: fields.kind,
    title: fields.title,
    body: fields.body,
    status: { id: "", name: "New", category: "todo" },
    assignee: fields.assignee,
    reporter: null,
    priority: fields.priority,
    parent: fields.parent,
    labels: fields.labels,
    created: p.createdAt,
    updated,
    links: [],
    commentCount: 0,
    lastCommenter: null,
    extra: null,
  };
}

export interface DraftFields {
  title: string;
  body: string;
  mentions: Mention[];
  kind: WorkItemKind;
  container: ContainerRef;
}

export function fieldsOf(p: Proposal & { intent: Created }): DraftFields {
  const { fields, container } = p.intent;
  return { title: fields.title, body: docText(fields.body), mentions: [], kind: fields.kind, container };
}

/** The edit that turns the draft into `next`, naming only what changed; null when nothing did. */
export function editFor(p: Proposal & { intent: Created }, next: DraftFields): ProposalEdit | null {
  const was = fieldsOf(p);
  const edit: Extract<ProposalEdit, { type: "create" }> = { type: "create" };
  if (next.title.trim() !== was.title.trim()) edit.title = next.title;
  if (next.body.trim() !== was.body.trim()) {
    edit.body = next.body;
    edit.mentions = liveMentions(next.body, next.mentions);
  }
  if (next.kind !== was.kind) edit.kind = next.kind;
  if (containerKey(next.container) !== containerKey(was.container)) edit.container = next.container;
  return Object.keys(edit).length > 1 ? edit : null;
}

/** Whether the real ticket of an applied draft is in the cache yet, by the key it was given. */
export const createdItemKey = (p: Proposal): string | null => (p.created[0] ? itemKey(p.created[0]) : null);
