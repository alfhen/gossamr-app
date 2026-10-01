import { useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
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
import { ColumnGrip } from "./ColumnHeader";
import { gapAt, landingIndex, moveTo, movedMessage } from "./columnOrder";
import { GhostCard, ItemCard } from "./ItemCard";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

const DOT = { todo: "bg-ws-ink3", active: "bg-ws-accent", done: "bg-ws-done", review: "bg-ws-review", blocked: "bg-ws-blocked" } as const;

/** The project's own statuses in order, or why the columns are categories when no project is picked. */
export function WorkflowLine({ section }: { section: BoardSection | null }) {
  if (!section) return <p className="m-0 text-xs text-ws-ink3">Columns are status categories because each project has its own workflow. Pick a project to see its exact columns and reorder them.</p>;
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
  const columnOrder = usePrefs((s) => s.columnOrder);
  const projectSections = useMemo(() => boardSections(items, containers, include, columnOrder), [items, containers, include?.connectionId, include?.externalId, columnOrder]);
  // Without a project the workflows differ, so the board falls back to the three status categories.
  const byCategory = !include;
  const sections = useMemo(() => (byCategory ? (items.length ? [categorySection(items)] : []) : projectSections), [byCategory, items, projectSections]);
  const ownSection = (item: WorkItem) => projectSections.find((p) => p.key === containerKey(item.container));
  const order = useMemo(() => sections.flatMap((s) => s.columns.flatMap((c) => c.items.map((i) => itemKey(i.item)))), [sections]);
  const cards = useCards(items, order);
  const [dragging, setDragging] = useState<WorkItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lifted, setLifted] = useState<{ section: string; id: string } | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const columnEls = useRef(new Map<string, HTMLElement>());
  const before = useRef<{ rects: Map<string, number>; focus: string | null } | null>(null);

  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  const endColumnDrag = () => {
    setLifted(null);
    setGap(null);
  };

  const reorder = (section: BoardSection, from: number, to: number) => {
    const target = Math.min(Math.max(to, 0), section.columns.length - 1);
    if (from === target) return;
    before.current = { rects: new Map([...columnEls.current].map(([id, el]) => [id, el.getBoundingClientRect().left])), focus: section.columns[from].status.id };
    usePrefs.getState().setColumnOrder(section.key, moveTo(section.columns.map((c) => c.status.id), from, target));
    setAnnouncement(movedMessage(section.columns[from].status.name, target, section.columns.length));
  };

  const resetOrder = (section: BoardSection) => {
    usePrefs.getState().setColumnOrder(section.key, null);
    setAnnouncement(`${section.name} column order reset to the default`);
  };

  const orderKey = sections.map((s) => s.columns.map((c) => c.status.id).join()).join("|");
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [id, el] of columnEls.current) {
      const from = was.rects.get(id);
      const shift = from === undefined ? 0 : from - el.getBoundingClientRect().left;
      if (shift && !calm) el.animate([{ transform: `translateX(${shift}px)` }, { transform: "none" }], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    }
    if (was.focus) document.querySelector<HTMLElement>(`[data-column-grip][data-column="${CSS.escape(was.focus)}"]`)?.focus();
  }, [orderKey]);

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

  const dragColumn = (ev: DragEvent<HTMLElement>, section: BoardSection, statusId: string, id: string) => {
    ev.stopPropagation();
    const column = columnEls.current.get(id);
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("application/x-gossamr-column", statusId);
    if (column) liftImage(ev, column);
    setTimeout(() => setLifted({ section: section.key, id: statusId }));
  };

  if (!sections.length) return <p className="p-10 text-center text-ws-ink3">Nothing matches this filter.</p>;

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="px-6 pb-2">
        <WorkflowLine section={byCategory ? null : (sections[0] ?? null)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 pb-2">
        {sections.map((section) => (
          <section key={section.key} aria-label={`${section.name} board`} className="min-h-72 min-w-full flex-1 pt-1 pb-2">
            <div
              className="grid h-full auto-cols-[minmax(200px,1fr)] grid-flow-col gap-2.5"
              onDragOver={(ev: DragEvent) => {
                if (lifted?.section !== section.key) return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = "move";
                setGap(gapAt(ev.clientX, section.columns.map((c) => columnEls.current.get(`${section.key}|${c.status.id}`)?.getBoundingClientRect() ?? { left: 0, right: 0 })));
              }}
              onDragLeave={(ev: DragEvent) => {
                if (lifted && !ev.currentTarget.contains(ev.relatedTarget as Node | null)) setGap(null);
              }}
              onDrop={(ev: DragEvent) => {
                if (lifted?.section !== section.key) return;
                ev.preventDefault();
                const from = section.columns.findIndex((c) => c.status.id === lifted.id);
                const at = gap;
                endColumnDrag();
                if (from >= 0 && at !== null) reorder(section, from, landingIndex(from, at));
              }}
            >
              {section.columns.map((column, at) => {
                const id = `${section.key}|${column.status.id}`;
                const grip = byCategory ? null : { at, count: section.columns.length };
                const verdict = dragging ? verdictOf(dragging, section, column) : null;
                const ghosts = ghostsIn(section, column);
                return (
                  <div
                    key={id}
                    ref={(el) => {
                      if (el) columnEls.current.set(id, el);
                      else columnEls.current.delete(id);
                    }}
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
                      if (lifted) return;
                      ev.preventDefault();
                      void drop(section, column);
                    }}
                    className={`relative flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border-2 p-2 transition-colors ${
                      lifted?.id === column.status.id && lifted.section === section.key ? "ws-col-lifted" : ""
                    } ${
                      verdict === "ok" ? `border-dashed border-ws-pip ${over === id ? "bg-ws-pip-soft" : "bg-ws-bar"}` : "border-transparent bg-ws-bar"
                    } ${verdict === "invalid" ? "opacity-40" : ""}`}
                  >
                    {gap === at && lifted?.section === section.key && <DropBar side="left" />}
                    {gap === section.columns.length && at === section.columns.length - 1 && lifted?.section === section.key && <DropBar side="right" />}
                    <div className="flex items-center text-sm font-bold text-ws-ink2">
                      {grip && (
                        <ColumnGrip
                          id={column.status.id}
                          name={column.status.name}
                          reorder={{
                            ...grip,
                            custom: Boolean(columnOrder[section.key]),
                            onMove: (to) => reorder(section, at, to),
                            onReset: () => resetOrder(section),
                            onDragStart: (ev) => dragColumn(ev, section, column.status.id, id),
                            onDragEnd: endColumnDrag,
                          }}
                        />
                      )}
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

function DropBar({ side }: { side: "left" | "right" }) {
  return <span aria-hidden className={`ws-col-drop pointer-events-none absolute -inset-y-0.5 z-10 w-[3px] rounded-full bg-ws-pip ${side === "left" ? "-left-[6px]" : "-right-[6px]"}`} />;
}

/** A shadowed copy of the column to drag, since the live element can't show a shadow outside its own box. */
function liftImage(ev: DragEvent<HTMLElement>, column: HTMLElement) {
  const box = column.getBoundingClientRect();
  const pad = 16;
  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed;top:-9999px;left:-9999px;padding:${pad}px;pointer-events:none`;
  const copy = column.cloneNode(true) as HTMLElement;
  copy.style.cssText = `width:${box.width}px;height:${Math.min(box.height, 420)}px;overflow:hidden;box-shadow:var(--shadow-ws-pop);opacity:1`;
  holder.append(copy);
  document.body.append(holder);
  ev.dataTransfer.setDragImage(holder, ev.clientX - box.left + pad, ev.clientY - box.top + pad);
  setTimeout(() => holder.remove());
}
