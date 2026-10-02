import type { DevLink, ItemRef, Person, WorkComment, WorkItem } from "../types";
import { docText } from "../lib/docs";

/** The limits the backend's ticket snapshot keeps, so the sample prompt is as long as a real one can be. */
export const TICKET_BLOCK_LIMIT = 10_000;
const HEAD_BUDGET = 1_000;
const DESCRIPTION_BUDGET = 3_500;
const COMMENTS_BUDGET = 5_000;
const COMMENT_LIMIT = 1_200;
const COMMENT_COUNT = 10;
const MARKERS = ["<<<TICKET", "TICKET>>>", "<<<FOCUS", "FOCUS>>>"];

function withoutMarkers(text: string): string {
  let out = text;
  for (let found = MARKERS.find((m) => out.includes(m)); found; found = MARKERS.find((m) => out.includes(m))) out = out.split(found).join("");
  return out;
}

export interface TicketMaterial {
  item: WorkItem;
  comments: WorkComment[];
  people: Person[];
  titleOf: (ref: ItemRef) => string | null;
  code: DevLink[];
}

const CHECKS: Record<string, string> = { none: "", pending: ", checks pending", passing: ", checks passing", failing: ", checks failing" };
const oneLine = (text: string, limit: number) => text.replace(/\s+/g, " ").trim().slice(0, limit);

function relation(kind: string, outward: boolean): string {
  if (kind === "blocks") return outward ? "blocks" : "is blocked by";
  if (kind === "duplicates") return outward ? "duplicates" : "is duplicated by";
  return "relates to";
}

function head(m: TicketMaterial): string {
  const { item } = m;
  const name = (ref: { accountId: string } | null, none: string) => (ref ? (m.people.find((p) => p.accountId === ref.accountId)?.name ?? none) : none);
  const meta = [
    `Kind: ${item.kind}`,
    `Status: ${item.status.name}`,
    `Priority: ${item.priority ?? "none"}`,
    `Assignee: ${name(item.assignee, "unassigned")}`,
    `Reporter: ${name(item.reporter, "unknown")}`,
    ...(item.labels.length ? [`Labels: ${item.labels.join(", ")}`] : []),
  ];
  const lines = [oneLine(`${item.item.key}: ${item.title}`, 300), oneLine(meta.join(" | "), 300)];
  const titled = (ref: ItemRef) => {
    const title = m.titleOf(ref);
    return title ? `${ref.key} ${title}` : ref.key;
  };
  if (item.parent) lines.push(`Parent: ${oneLine(titled(item.parent), 300)}`);
  const linked = item.links.filter((l) => l.kind !== "implementedBy").map((l) => {
    const outward = l.from.key === item.item.key;
    return `${relation(l.kind, outward)} ${titled(outward ? l.to : l.from)}`;
  });
  const code = m.code.map(({ change: c }) => (c.kind === "pullRequest" ? `pull request ${c.repo}#${c.number} (${c.state}${CHECKS[c.checks]}), branch ${c.headRef}: ${c.title}` : `${c.kind} ${c.repo}:${c.headRef} (${c.state})`));
  let used = lines.reduce((n, l) => n + l.length + 1, 0);
  for (const [label, entries] of [["Linked tickets:", linked], ["Pull requests and branches:", code]] as const) {
    if (!entries.length) continue;
    lines.push(label);
    used += label.length + 1;
    for (const [at, entry] of entries.entries()) {
      const line = `- ${oneLine(entry, 300)}`;
      used += line.length + 1;
      if (used > HEAD_BUDGET) {
        lines.push(`- ${entries.length - at} more omitted`);
        break;
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

function comments(m: TicketMaterial): string {
  if (!m.comments.length) return "Comments: none.";
  const picked: string[] = [];
  let used = 0;
  for (const c of m.comments.slice(-COMMENT_COUNT).reverse()) {
    const author = m.people.find((p) => p.accountId === c.author.accountId)?.name ?? "unknown";
    const when = c.created.slice(0, 16).replace("T", " ");
    const text = docText(c.body);
    const body = (text.length > COMMENT_LIMIT ? `${text.slice(0, COMMENT_LIMIT)}\n… [cut]` : text || "(empty)").split("\n").map((l) => (l.trim() ? `  ${l}` : "")).join("\n");
    const block = `[${author}, ${when} UTC]\n${body}`;
    if (used + block.length > COMMENTS_BUDGET) break;
    used += block.length + 2;
    picked.push(block);
  }
  picked.reverse();
  const omitted = m.comments.length - picked.length;
  return ["Comments (oldest first, newest last):", ...(omitted ? [`older comments omitted: ${omitted}`] : []), "", picked.join("\n\n")].join("\n").trimEnd();
}

/** The ticket as the backend's snapshot would show it, from what the mock holds. */
export function ticketBlockText(m: TicketMaterial): string {
  const text = docText(m.item.body);
  const description = !text ? "Description: none." : `Description:\n${text.slice(0, DESCRIPTION_BUDGET)}${text.length > DESCRIPTION_BUDGET ? `\n[description cut at ${DESCRIPTION_BUDGET} characters]` : ""}`;
  return withoutMarkers([head(m), description, comments(m)].join("\n\n")).trim().slice(0, TICKET_BLOCK_LIMIT);
}
