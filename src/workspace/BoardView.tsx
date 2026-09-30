import { useMemo, useState, type DragEvent } from "react";
import { containerKey, itemKey } from "../lib/filter";
import { targetOf } from "../lib/proposals";
import type { WorkItem } from "../types";
import { knownMoves, useWorkspace } from "../workspaceStore";
import { CanvasFooter } from "./CanvasFooter";
import {
  boardSections,
  categorySection,
  categoryVerdict,
  draftStatus,
  dropVerdict,
  moveHint,
  movesAreOpaque,
  planCategoryDrop,
  planDrop,
  type BoardColumn,
  type BoardSection,
  type DropVerdict,
} from "./boardLogic";
import type { CanvasProps } from "./canvases";
import { projectOf } from "./filters";
import { StatusPill } from "./CanvasBits";
import { statusTone } from "./canvasShared";
import { GhostCard, ItemCard } from "./ItemCard";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

const DOT = { todo: "bg-ws-ink3", active: "bg-ws-accent", done: "bg-ws-done", review: "bg-ws-review", blocked: "bg-ws-blocked" } as const;

/** The project's own statuses in order, or why the columns are categories when no project is picked. */
export function WorkflowLine({ section }: { section: BoardSection | null }) {
  if (!section) return <p className="m-0 text-xs text-ws-ink3">Columns are status categories because each project has its own workflow. Pick a project to see its exact columns.</p>;
  return (
    <ol aria-label={`${section.name} workflow`} className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-xs text-ws-ink3">
      <li className="font-bold text-ws-ink2">{section.name} workflow</li>
      {section.workflow.statuses.map((s, at) => (
        <li key={s.id} className="flex items-center gap-1.5">
          {at > 0 && <span aria-hidden>›</span>}
          <StatusPill status={s} title={moveHint(section.workflow, s)} />
        </li>
      ))}
    </ol>
  );
}

export function BoardView({ tab, items }: CanvasProps) {
  const containers = useWorkspace((s) => s.containers);
  const moves = useWorkspace((s) => s.moves);
  const include = projectOf(tab.filter);
  const projectSections = useMemo(() => boardSections(items, containers, include), [items, containers, include?.connectionId, include?.externalId]);
  // Without a project the workflows differ, so the board falls back to the three status categories.
  const byCategory = !include;
  const sections = useMemo(() => (byCategory ? (items.length ? [categorySection(items)] : []) : projectSections), [byCategory, items, projectSections]);
  const ownSection = (item: WorkItem) => projectSections.find((p) => p.key === containerKey(item.container));
  const order = useMemo(() => sections.flatMap((s) => s.columns.flatMap((c) => c.items.map((i) => itemKey(i.item)))), [sections]);
  const cards = useCards(items, order);
  const [dragging, setDragging] = useState<WorkItem | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  const drop = async (section: BoardSection, column: BoardColumn) => {
    const item = dragging;
    endDrag();
    if (!item) return;
    const own = column.category ? ownSection(item) : section;
    if (!own) return;
    const known = movesAreOpaque(own.workflow) ? await useWorkspace.getState().loadMoves(item) : null;
    const plan = column.category ? planCategoryDrop(item, own, column.category, known) : planDrop(item, section, column.status.id, known);
    if (!plan.ok) {
      if (plan.reason) cards.say(plan.reason, "error");
      return;
    }
    cards.cardProps(item).onMove(plan.to);
  };

  const verdictOf = (item: WorkItem, section: BoardSection, column: BoardColumn): DropVerdict => {
    if (!column.category) return dropVerdict(item, section, column.status.id, knownMoves({ moves }, item));
    const own = ownSection(item);
    return own ? categoryVerdict(item, own, column.category, knownMoves({ moves }, item)) : "invalid";
  };

  const ghostsIn = (section: BoardSection, column: BoardColumn) =>
    [...cards.pending.values()].flatMap((p) => {
      const target = targetOf(p.intent);
      const item = target && items.find((i) => itemKey(i.item) === itemKey(target));
      if (!item) return [];
      const own = column.category ? ownSection(item) : section;
      if (!own || (!column.category && itemKey(item.container) !== section.key)) return [];
      const to = draftStatus(p, own.workflow);
      const here = column.category ? to?.category === column.category && item.status.category !== column.category : to?.id === column.status.id && item.status.id !== column.status.id;
      return to && here ? [{ item, draft: { id: p.id, to: to.name } }] : [];
    });

  if (!sections.length) return <p className="p-10 text-center text-ws-ink3">Nothing matches this filter.</p>;

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="px-6 pb-2">
        <WorkflowLine section={byCategory ? null : (sections[0] ?? null)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 pb-2">
        {sections.map((section) => (
          <section key={section.key} aria-label={`${section.name} board`} className="min-h-72 min-w-full flex-1 pt-1 pb-2">
            <div className="grid h-full auto-cols-[minmax(200px,1fr)] grid-flow-col gap-2.5">
              {section.columns.map((column) => {
                const id = `${section.key}|${column.status.id}`;
                const verdict = dragging ? verdictOf(dragging, section, column) : null;
                const ghosts = ghostsIn(section, column);
                return (
                  <div
                    key={id}
                    role="group"
                    aria-label={`${column.status.name}, ${column.items.length}`}
                    data-drop={verdict ?? undefined}
                    onDragOver={(ev: DragEvent) => {
                      if (verdict !== "ok") return;
                      ev.preventDefault();
                      setOver(id);
                    }}
                    onDragLeave={() => setOver((o) => (o === id ? null : o))}
                    onDrop={(ev) => {
                      ev.preventDefault();
                      void drop(section, column);
                    }}
                    className={`flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border-2 p-2 transition-colors ${
                      verdict === "ok" ? `border-dashed border-ws-pip ${over === id ? "bg-ws-pip-soft" : "bg-ws-bar"}` : "border-transparent bg-ws-bar"
                    } ${verdict === "invalid" ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-center text-sm font-bold text-ws-ink2">
                      <i className={`mr-1.5 size-2 rounded-full ${DOT[statusTone(column.status)]}`} />
                      {column.status.name}
                      <span className="ml-auto font-semibold text-ws-ink3">{column.items.length}</span>
                    </div>
                    <div className="-m-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1">
                      {ghosts.map((g) => (
                        <GhostCard key={g.draft.id} item={g.item} draft={g.draft} onApprove={(d) => cards.cardProps(g.item).onApprove(d)} onSkip={(d) => cards.cardProps(g.item).onSkip(d)} />
                      ))}
                      {column.items.map((item) => (
                        <ItemCard
                          key={itemKey(item.item)}
                          {...cards.cardProps(item)}
                          showStatus={byCategory}
                          onDragStart={(ev) => {
                            ev.dataTransfer.setData("text/plain", itemKey(item.item));
                            ev.dataTransfer.effectAllowed = "move";
                            setDragging(item);
                            if (movesAreOpaque(ownSection(item)?.workflow ?? section.workflow)) void useWorkspace.getState().loadMoves(item);
                          }}
                          onDragEnd={endDrag}
                        />
                      ))}
                      {!column.items.length && !ghosts.length && (
                        <p className="rounded-lg border border-dashed border-ws-sep2 p-3 text-center text-sm text-ws-ink3">{dragging ? "Drop here" : "Empty"}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <CanvasFooter cards={cards} view="board" />
    </div>
  );
}
