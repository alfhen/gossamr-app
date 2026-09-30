import { useEffect, useMemo, useState } from "react";
import { itemKey } from "../lib/filter";
import { targetOf } from "../lib/proposals";
import type { StatusDef, WorkItem, Workflow } from "../types";
import { draftCounts, knownMoves, nameOf, workflowOfItem, useWorkspace } from "../workspaceStore";
import { approvableTransitions, blockedKeys, bulkMoves, bulkTargets, draftStatus, movesAreOpaque, pendingMoves, targetsFor, witherOf } from "./boardLogic";
import type { ItemCardProps } from "./ItemCard";
import { useTabs } from "./tabsStore";

export interface Notice {
  tone: "info" | "error";
  text: string;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Everything the board and the age view share: what a card shows, what its actions do, and the bulk actions. */
export function useCards(items: readonly WorkItem[], order: readonly string[]) {
  const allItems = useWorkspace((s) => s.items);
  const containers = useWorkspace((s) => s.containers);
  const proposals = useWorkspace((s) => s.proposals);
  const moves = useWorkspace((s) => s.moves);
  const names = useWorkspace((s) => s.names);
  const selected = useTabs((s) => s.selected);
  const ticked = useTabs((s) => s.marked);
  const marked = useMemo(() => ticked.filter((k) => order.includes(k)), [ticked, order]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => () => useTabs.getState().clearMarks(), []);

  const now = useMemo(() => new Date(), [items]);
  const blocked = useMemo(() => blockedKeys(Object.values(allItems)), [allItems]);
  const pending = useMemo(() => pendingMoves(proposals), [proposals]);
  const counts = useMemo(() => draftCounts({ proposals }), [proposals]);
  const workflowOf = (i: WorkItem): Workflow | null => workflowOfItem({ containers }, i);

  const say = (text: string, tone: Notice["tone"] = "info") => setNotice({ tone, text });
  const attempt = async (job: () => Promise<void>) => {
    try {
      await job();
    } catch (e) {
      say(messageOf(e), "error");
    }
  };

  const move = (item: WorkItem, to: StatusDef) =>
    attempt(async () => {
      setMenuFor(null);
      await useWorkspace.getState().draftTransition(item.item, to);
      useTabs.getState().select(itemKey(item.item));
      say(`Drafted ${item.item.key} → ${to.name}. Nothing changes until you approve.`);
    });

  const decide = (id: string, what: "approve" | "skip") =>
    attempt(async () => {
      setMenuFor(null);
      const done = await useWorkspace.getState()[what](id);
      if (done.error) say(done.error, "error");
      else say(what === "approve" ? "Approved." : "Skipped the draft.");
    });

  const cardProps = (item: WorkItem): ItemCardProps => {
    const key = itemKey(item.item);
    const wf = workflowOf(item);
    const p = pending.get(key);
    const to = p && (draftStatus(p, wf)?.name ?? p.label ?? (p.intent.type === "transition" ? p.intent.to : ""));
    return {
      item,
      assignee: nameOf({ names }, item.assignee),
      now,
      wither: witherOf(item, now),
      blocked: blocked.has(key),
      draft: p ? { id: p.id, to: to! } : null,
      moreDrafts: (counts[key] ?? 0) - (p ? 1 : 0),
      selected: selected === key,
      marked: marked.includes(key),
      menuOpen: menuFor === key,
      moveTargets: wf ? targetsFor(wf, item, knownMoves({ moves }, item)) : [],
      onSelect: (how) => (how === "one" ? useTabs.getState().select(key) : useTabs.getState().mark(key, how, order)),
      onMenu: (open) => {
        setMenuFor(open ? key : null);
        if (open && wf && movesAreOpaque(wf)) void useWorkspace.getState().loadMoves(item);
      },
      onMove: (s) => void move(item, s),
      onApprove: (id) => void decide(id, "approve"),
      onSkip: (id) => void decide(id, "skip"),
    };
  };

  const markedItems = useMemo(() => marked.flatMap((k) => allItems[k] ?? []), [marked, allItems]);
  const approvable = useMemo(
    () =>
      approvableTransitions(pending, marked).flatMap((p) => {
        const target = targetOf(p.intent);
        const item = target && allItems[itemKey(target)];
        if (!item) return [];
        return [{ id: p.id, key: item.item.key, from: item.status.name, to: draftStatus(p, workflowOf(item))?.name ?? p.label ?? "" }];
      }),
    [pending, marked, allItems, containers],
  );

  const bulk = {
    marked,
    approvable,
    confirming,
    targets: bulkTargets(markedItems, workflowOf),
    move: (name: string) =>
      attempt(async () => {
        const { moves, skipped } = bulkMoves(markedItems, workflowOf, name);
        for (const m of moves) await useWorkspace.getState().draftTransition(m.item.item, m.to);
        const drafted = `Drafted ${moves.length} move${moves.length === 1 ? "" : "s"} to ${name}.`;
        say(skipped.length ? `${drafted} ${skipped.length} can't get there: ${skipped.map((i) => i.item.key).join(", ")}.` : drafted, skipped.length ? "error" : "info");
      }),
    ask: () => setConfirming(true),
    cancel: () => setConfirming(false),
    approve: () =>
      attempt(async () => {
        setConfirming(false);
        const failed: string[] = [];
        for (const a of approvable) {
          const done = await useWorkspace.getState().approve(a.id);
          if (done.error) failed.push(`${a.key}: ${done.error}`);
        }
        const ok = approvable.length - failed.length;
        say(failed.length ? `Approved ${ok}. Failed: ${failed.join("; ")}` : `Approved ${ok} move${ok === 1 ? "" : "s"}.`, failed.length ? "error" : "info");
      }),
    clear: () => {
      setConfirming(false);
      useTabs.getState().clearMarks();
    },
  };

  return { cardProps, now, pending, blocked, counts, workflowOf, notice, dismissNotice: () => setNotice(null), say, bulk };
}
