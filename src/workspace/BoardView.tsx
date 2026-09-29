import { useMemo, useState, type DragEvent } from "react";
import { itemKey } from "../lib/filter";
import { targetOf } from "../lib/proposals";
import type { WorkItem } from "../types";
import { useWorkspace } from "../workspaceStore";
import { BulkBar } from "./BulkBar";
import { boardSections, draftStatus, dropVerdict, planDrop, type BoardColumn, type BoardSection } from "./boardLogic";
import type { CanvasProps } from "./canvases";
import { projectOf } from "./filters";
import { GhostCard, ItemCard } from "./ItemCard";
import { NoticeLine } from "./Notice";
import { useTabs } from "./tabsStore";
import { useCards } from "./useCards";

const DOT = { todo: "bg-ws-ink3", active: "bg-ws-accent", done: "bg-ws-done" } as const;

export function BoardView({ tab, items }: CanvasProps) {
  const containers = useWorkspace((s) => s.containers);
  const include = projectOf(tab.filter);
  const sections = useMemo(() => boardSections(items, containers, include), [items, containers, include?.connectionId, include?.externalId]);
  const order = useMemo(() => sections.flatMap((s) => s.columns.flatMap((c) => c.items.map((i) => itemKey(i.item)))), [sections]);
  const cards = useCards(items, order);
  const [dragging, setDragging] = useState<WorkItem | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  const drop = (section: BoardSection, column: BoardColumn) => {
    const item = dragging;
    endDrag();
    if (!item) return;
    const plan = planDrop(item, section, column.status.id);
    if (!plan.ok) {
      if (plan.reason) cards.say(plan.reason, "error");
      return;
    }
    cards.cardProps(item).onMove(plan.to);
  };

  const ghostsIn = (section: BoardSection, column: BoardColumn) =>
    [...cards.pending.values()].flatMap((p) => {
      const target = targetOf(p.intent);
      const item = target && items.find((i) => itemKey(i.item) === itemKey(target));
      if (!item || itemKey(item.container) !== section.key || item.status.id === column.status.id) return [];
      const to = draftStatus(p, section.workflow);
      return to?.id === column.status.id ? [{ item, draft: { id: p.id, to: to.name } }] : [];
    });

  if (!sections.length) return <p className="p-10 text-center text-ws-ink3">Nothing matches this filter.</p>;

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape" && cards.bulk.marked.length) useTabs.getState().clearMarks();
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
        {sections.map((section) => (
          <section key={section.key} aria-label={`${section.name} board`} className="mb-6 w-max min-w-full">
            <h2 className="sticky left-0 mb-2 flex items-baseline gap-2 pt-1 font-bold text-ws-ink2">
              {section.name}
              <span className="font-mono text-sm font-semibold text-ws-ink3">{section.code}</span>
              <span className="text-sm font-normal text-ws-ink3">
                {section.count} {section.count === 1 ? "ticket" : "tickets"}
              </span>
            </h2>
            <div className="grid min-h-40 auto-cols-[minmax(210px,1fr)] grid-flow-col gap-2.5">
              {section.columns.map((column) => {
                const id = `${section.key}|${column.status.id}`;
                const verdict = dragging ? dropVerdict(dragging, section, column.status.id) : null;
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
                      drop(section, column);
                    }}
                    className={`flex flex-col gap-2 rounded-xl border-2 p-2 transition-colors ${
                      verdict === "ok" ? `border-dashed border-ws-pip ${over === id ? "bg-ws-pip-soft" : "bg-ws-bar"}` : "border-transparent bg-ws-bar"
                    } ${verdict === "invalid" ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-center text-sm font-bold text-ws-ink2">
                      <i className={`mr-1.5 size-2 rounded-full ${DOT[column.status.category]}`} />
                      {column.status.name}
                      <span className="ml-auto font-semibold text-ws-ink3">{column.items.length}</span>
                    </div>
                    {ghosts.map((g) => (
                      <GhostCard key={g.draft.id} item={g.item} draft={g.draft} onApprove={(d) => cards.cardProps(g.item).onApprove(d)} onSkip={(d) => cards.cardProps(g.item).onSkip(d)} />
                    ))}
                    {column.items.map((item) => (
                      <ItemCard
                        key={itemKey(item.item)}
                        {...cards.cardProps(item)}
                        onDragStart={(ev) => {
                          ev.dataTransfer.setData("text/plain", itemKey(item.item));
                          ev.dataTransfer.effectAllowed = "move";
                          setDragging(item);
                        }}
                        onDragEnd={endDrag}
                      />
                    ))}
                    {!column.items.length && !ghosts.length && (
                      <p className="rounded-lg border border-dashed border-ws-sep2 p-3 text-center text-sm text-ws-ink3">{dragging ? "Drop here" : "Empty"}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <NoticeLine notice={cards.notice} onDismiss={cards.dismissNotice} />
      {cards.bulk.marked.length > 1 && (
        <BulkBar
          count={cards.bulk.marked.length}
          targets={cards.bulk.targets}
          approvable={cards.bulk.approvable}
          confirming={cards.bulk.confirming}
          onMoveAll={(n) => void cards.bulk.move(n)}
          onAsk={cards.bulk.ask}
          onCancel={cards.bulk.cancel}
          onApprove={() => void cards.bulk.approve()}
          onClear={cards.bulk.clear}
        />
      )}
    </div>
  );
}
