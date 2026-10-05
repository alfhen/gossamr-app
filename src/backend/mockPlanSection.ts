import type { WorkBlock, WorkDoc, WorkInline } from "../types";
import { docFromText } from "../lib/docs";
import { PLAN_LIMIT } from "./mockRunKinds";
import { fit, planWithoutNote } from "./mockRunResult";
import { markdownOf } from "./mockMarkdown";

/** The marker of a description's plan section, as `PLAN_HEADING` in `domain/doc/plan.rs`. */
export const PLAN_HEADING = "Gossamr Plan";
const NEW_LEVEL = 2;
const MIN_PLAN_ROOM = 1_000;
const DESCRIPTION_LIMIT = 30_000;

const headingText = (content: WorkInline[]) => content.map((i) => (i.type === "text" || i.type === "link" ? i.text : "")).join("");
const isMarker = (b: WorkBlock) => b.type === "heading" && headingText(b.content).trim().replace(/:+$/, "").trim().toLowerCase() === PLAN_HEADING.toLowerCase();

/** The first marker heading and where its section ends: at the next heading of the same or a higher level. */
function range(doc: WorkDoc): { at: number; end: number; level: number } | null {
  const at = doc.blocks.findIndex(isMarker);
  const head = doc.blocks[at];
  if (head?.type !== "heading") return null;
  const next = doc.blocks.slice(at + 1).findIndex((b) => b.type === "heading" && b.level <= head.level);
  return { at, end: next < 0 ? doc.blocks.length : at + 1 + next, level: head.level };
}

/** What stands under the plan heading, without the heading. */
export function planSectionOf(doc: WorkDoc): WorkDoc | null {
  const r = range(doc);
  return r ? { blocks: doc.blocks.slice(r.at + 1, r.end) } : null;
}

export function withoutPlanSection(doc: WorkDoc): WorkDoc {
  const r = range(doc);
  return r ? { blocks: [...doc.blocks.slice(0, r.at), ...doc.blocks.slice(r.end)] } : doc;
}

/** `doc` with `intro` and `plan` as its plan section: replacing the one it has, or added at the end. As `with_plan_section` in `domain/doc/plan.rs`. */
export function withPlanSection(doc: WorkDoc, intro: string, plan: WorkDoc): WorkDoc {
  const r = range(doc);
  const level = r?.level ?? NEW_LEVEL;
  const before = r ? doc.blocks.slice(0, r.at) : doc.blocks;
  const after = r ? doc.blocks.slice(r.end) : [];
  const own = plan.blocks.map((b): WorkBlock => (isMarker(b) && b.type === "heading" ? { type: "paragraph", content: b.content } : b));
  const levels = own.flatMap((b) => (b.type === "heading" ? [b.level] : []));
  const shallowest = levels.length ? Math.min(...levels) : null;
  const shift = shallowest !== null && shallowest <= level ? level + 1 - shallowest : 0;
  const moved = own.map((b): WorkBlock => (b.type === "heading" ? { ...b, level: Math.min(6, b.level + shift) } : b));
  const heading: WorkBlock = { type: "heading", level, content: [{ type: "text", text: PLAN_HEADING, marks: [] }] };
  return { blocks: [...before, heading, ...docFromText(intro).blocks, ...moved, ...after] };
}

export interface RunLike {
  id: string;
  shortId: string | null;
  endedAt: string | null;
  queuedAt: string;
  result: string | null;
}

export function planIntro(run: Pick<RunLike, "shortId" | "endedAt" | "queuedAt">): string {
  const date = new Date(run.endedAt ?? run.queuedAt).toISOString().slice(0, 10);
  return `Drafted by an agent run${run.shortId ? ` (${run.shortId})` : ""} on ${date}. A person read and approved it in Gossamr before it was added here.`;
}

/** The description with the plan in it, or why that can't be done; the plan is cut to what the description has room for. */
export function assemblePlan(run: RunLike, body: WorkDoc, parse: (markdown: string) => WorkDoc): { to: WorkDoc; cut: boolean } | { problem: string } {
  const plan = planWithoutNote(run.result ?? "");
  const intro = planIntro(run);
  const rest = [...markdownOf(withoutPlanSection(body))].length;
  const which = run.shortId ?? run.id;
  let room = Math.min(PLAN_LIMIT, DESCRIPTION_LIMIT - (rest + PLAN_HEADING.length + [...intro].length + 64));
  for (let tries = 0; tries < 4 && room >= MIN_PLAN_ROOM; tries++) {
    const fitted = fit(plan, room, (total) => `[Cut here. The plan was ${total} characters and this section holds ${room}. The whole of it is in agent run ${which}.]`);
    const to = withPlanSection(body, intro, parse(fitted.text));
    const size = [...markdownOf(to)].length;
    if (size <= DESCRIPTION_LIMIT) return { to, cut: fitted.cut };
    room -= size - DESCRIPTION_LIMIT + 100;
  }
  return { problem: `The description is too long to add a plan to: Jira holds ${DESCRIPTION_LIMIT} characters in all. Post the plan as a comment instead.` };
}
