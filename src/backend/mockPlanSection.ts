import type { WorkBlock, WorkDoc, WorkInline } from "../types";
import { docFromText } from "../lib/docs";
import { PLAN_LIMIT } from "./mockRunSpec";
import { fit } from "./mockRunResult";
import { markdownOf } from "./mockMarkdown";

/** The marker of a description's plan section, as `PLAN_HEADING` in `domain/doc/plan.rs`. */
export const PLAN_HEADING = "Gossamr Plan";
const MIN_PLAN_ROOM = 1_000;
const DESCRIPTION_LIMIT = 30_000;

const headingText = (content: WorkInline[]) => content.map((i) => (i.type === "text" || i.type === "link" ? i.text : "")).join("");
const isMarker = (b: WorkBlock) => b.type === "heading" && headingText(b.content).trim().replace(/:+$/, "").trim().toLowerCase() === PLAN_HEADING.toLowerCase();

/** Whether `b` is the expand a plan is written into: a top-level collapsible titled `Gossamr Plan`. As `is_plan_expand` in `domain/doc/plan.rs`. */
export const isPlanExpand = (b: WorkBlock) => b.type === "expand" && b.title.trim().replace(/:+$/, "").trim().toLowerCase() === PLAN_HEADING.toLowerCase();

/** Where the plan lives and where it ends: the first top-level plan expand (its one block), or the first marker heading and what follows it up to the next heading of the same or a higher level (the form older tickets carry), whichever stands first. */
function range(doc: WorkDoc): { at: number; end: number } | null {
  const at = doc.blocks.findIndex((b) => isPlanExpand(b) || isMarker(b));
  const head = doc.blocks[at];
  if (!head) return null;
  if (head.type !== "heading") return { at, end: at + 1 };
  const next = doc.blocks.slice(at + 1).findIndex((b) => b.type === "heading" && b.level <= head.level);
  return { at, end: next < 0 ? doc.blocks.length : at + 1 + next };
}

/** What stands in the plan: the expand's content, or what stands under the old plan heading. */
export function planSectionOf(doc: WorkDoc): WorkDoc | null {
  const r = range(doc);
  if (!r) return null;
  const head = doc.blocks[r.at];
  return { blocks: head.type === "expand" ? head.content : doc.blocks.slice(r.at + 1, r.end) };
}

/** Where the plan stands among the blocks, null without one. */
export const planStartOf = (doc: WorkDoc): number | null => range(doc)?.at ?? null;

export function withoutPlanSection(doc: WorkDoc): WorkDoc {
  const r = range(doc);
  return r ? { blocks: [...doc.blocks.slice(0, r.at), ...doc.blocks.slice(r.end)] } : doc;
}

/** `doc` with `intro` and `plan` as its plan: one `Gossamr Plan` expand in place of the plan it has (an expand, or the older heading section) or added at the end. As `with_plan_section` in `domain/doc/plan.rs`. */
export function withPlanSection(doc: WorkDoc, intro: string, plan: WorkDoc): WorkDoc {
  const r = range(doc);
  const before = r ? doc.blocks.slice(0, r.at) : doc.blocks;
  const after = r ? doc.blocks.slice(r.end) : [];
  const own = plan.blocks.map((b): WorkBlock => (isMarker(b) && b.type === "heading" ? { type: "paragraph", content: b.content } : b));
  const expand: WorkBlock = { type: "expand", title: PLAN_HEADING, content: [...docFromText(intro).blocks, ...own] };
  return { blocks: [...before, expand, ...after] };
}

export interface RunLike {
  id: string;
  shortId: string | null;
  endedAt: string | null;
  queuedAt: string;
  result: string | null;
}

/** How `planIntro` starts, and how it started before it stopped naming the run; an approved section's intro is matched by these, as `INTRO_STARTS` in `inbox/plan_description.rs`. */
const INTRO_STARTS = ["Drafted by an agent on", "Drafted by an agent run"];

/** A description's plan section as Markdown without the intro paragraph Gossamr put at its top, as `plan_text_of` in `inbox/plan_description.rs`. */
export function approvedPlanText(section: WorkDoc): string {
  const [first, ...rest] = section.blocks;
  const intro = first?.type === "paragraph" && INTRO_STARTS.some((s) => headingText(first.content).trimStart().startsWith(s));
  return markdownOf({ blocks: intro ? rest : section.blocks }).trim();
}

export function planIntro(run: Pick<RunLike, "endedAt" | "queuedAt">): string {
  const date = new Date(run.endedAt ?? run.queuedAt).toISOString().slice(0, 10);
  return `Drafted by an agent on ${date}. A person read and approved it before it was added here.`;
}

/** The description with the plan in it, or why that can't be done; the plan is cut to what the description has room for. */
export function assemblePlan(run: RunLike, body: WorkDoc, parse: (markdown: string) => WorkDoc): { to: WorkDoc; cut: boolean } | { problem: string } {
  const plan = (run.result ?? "").trim();
  const intro = planIntro(run);
  const rest = [...markdownOf(withoutPlanSection(body))].length;
  const which = run.shortId ?? run.id;
  let room = Math.min(PLAN_LIMIT, DESCRIPTION_LIMIT - (rest + PLAN_HEADING.length + [...intro].length + 96));
  for (let tries = 0; tries < 4 && room >= MIN_PLAN_ROOM; tries++) {
    const fitted = fit(plan, room, (total) => `[Cut here. The plan was ${total} characters and this section holds ${room}. The whole of it is in agent run ${which}.]`);
    const to = withPlanSection(body, intro, parse(fitted.text));
    const size = [...markdownOf(to)].length;
    if (size <= DESCRIPTION_LIMIT) return { to, cut: fitted.cut };
    room -= size - DESCRIPTION_LIMIT + 100;
  }
  return { problem: `The description is too long to add a plan to: Jira holds ${DESCRIPTION_LIMIT} characters in all. Post the plan as a comment instead.` };
}
