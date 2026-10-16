import { useEffect, useMemo, useState } from "react";
import { needs as buildNeeds, type Need } from "../lib/needs";
import { reporterAsk, type ReporterAsk } from "../lib/reporterWait";
import { isHeldByYou } from "../lib/workstreamHold";
import { useWorkspace } from "../workspaceStore";
import { lastHeldAt } from "./pipHomeLogic";
import { useRuns } from "./runsStore";
import { useNow } from "./useNow";
import { useWorkstreams } from "./workstreamsStore";

/**
 * When each held open workstream was last held, read from its audit once per hold, so a hold ranks in the list by when it
 * happened rather than by when the workstream opened. Only reads.
 */
let lastRead: Record<string, string> = {};

/** The hold times last read, shared so Pip is told the same order and top need as the list shows. */
export const lastReadHeldTimes = () => lastRead;
export const setLastReadHeldTimes = (times: Record<string, string>) => void (lastRead = times);

function useHeldTimes(): Record<string, string> {
  const backend = useWorkstreams((s) => s.backend);
  const holds = useWorkstreams((s) =>
    s.list
      .filter((v) => v.workstream.closedAt === null && v.workstream.heldReason && !isHeldByYou(v.workstream.heldReason))
      .map((v) => `${v.workstream.id}\n${v.workstream.heldReason}`)
      .join("\t"),
  );
  const [times, setTimes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!backend || !holds) return;
    let live = true;
    const ids = holds.split("\t").map((h) => h.split("\n")[0]);
    void Promise.all(ids.map((id) => backend.workstreamsEvents(id).then((events) => [id, lastHeldAt(events)] as const, () => [id, null] as const))).then((read) => {
      if (!live) return;
      const next = Object.fromEntries(read.filter((r): r is readonly [string, string] => r[1] !== null));
      setLastReadHeldTimes(next);
      setTimes(next);
    });
    return () => {
      live = false;
    };
  }, [backend, holds]);
  return times;
}

/** When the reporter was asked and nudged, as last read; shared like the hold times. */
let lastAsked: Record<string, ReporterAsk> = {};

/**
 * When the reporter was asked (and nudged) on each open workstream with a readiness decision showing, read from its audit,
 * so the decision says what the person already did. Only reads.
 */
function useReporterAsks(): Record<string, ReporterAsk> {
  const backend = useWorkstreams((s) => s.backend);
  const stops = useWorkstreams((s) =>
    s.list
      .filter((v) => v.workstream.closedAt === null && v.readiness)
      .map((v) => `${v.workstream.id}\n${v.readiness!.triageRun}\n${v.readiness!.changed ? 1 : 0}${v.readiness!.replied ? 1 : 0}`)
      .join("\t"),
  );
  const [asks, setAsks] = useState<Record<string, ReporterAsk>>({});
  useEffect(() => {
    if (!backend || !stops) return void setAsks({});
    let live = true;
    const ids = stops.split("\t").map((h) => h.split("\n")[0]);
    void Promise.all(ids.map((id) => backend.workstreamsEvents(id).then((events) => [id, reporterAsk(events)] as const, () => [id, null] as const))).then((read) => {
      if (!live) return;
      const next = Object.fromEntries(read.filter((r): r is readonly [string, ReporterAsk] => r[1] !== null));
      lastAsked = next;
      setAsks(next);
    });
    return () => {
      live = false;
    };
  }, [backend, stops]);
  return asks;
}

/**
 * Everything waiting on the person across the workstreams and General, highest rank first, kept current from the live
 * stores: `needs` (src/lib/needs.ts) over what they hold. Its length is the one count every screen gives.
 */
export function useNeedsYou(): Need[] {
  const workstreams = useWorkstreams((s) => s.list);
  const runs = useRuns((s) => s.runs);
  const dismissed = useRuns((s) => s.dismissed);
  const proposals = useWorkspace((s) => s.proposals);
  const items = useWorkspace((s) => s.items);
  const peeked = useWorkspace((s) => s.peeked);
  const heldAt = useHeldTimes();
  const asked = useReporterAsks();
  // Quiet runs come and go with the clock, so it ticks with the Agents view's.
  const now = useNow();
  return useMemo(() => buildNeeds({ workstreams, runs, proposals: Object.values(proposals), dismissed, heldAt, asked, titleOf: titlesOf(items, peeked), now }), [workstreams, runs, proposals, dismissed, heldAt, asked, items, peeked, now]);
}

/** A ticket's title by its key; one peeked from outside the watched projects has its title in the peek. */
function titlesOf(items: ReturnType<typeof useWorkspace.getState>["items"], peeked: ReturnType<typeof useWorkspace.getState>["peeked"]) {
  const titles = new Map([...Object.values(peeked).map((p) => [p.item.item.key, p.item.title] as const), ...Object.values(items).map((i) => [i.item.key, i.title] as const)]);
  return (key: string) => titles.get(key);
}

/** What needs the person right now, read from the stores when asked rather than kept current: for what Pip is told of the screen. */
export function currentNeeds(): Need[] {
  const ws = useWorkspace.getState();
  const runs = useRuns.getState();
  return buildNeeds({ workstreams: useWorkstreams.getState().list, runs: runs.runs, proposals: Object.values(ws.proposals), dismissed: runs.dismissed, heldAt: lastRead, asked: lastAsked, titleOf: titlesOf(ws.items, ws.peeked), now: Date.now() });
}

/** "1 thing needs you", "3 things need you": the one count, in the words the rail badge and the launcher say it. */
export const needsYouText = (n: number) => `${n} ${n === 1 ? "thing needs" : "things need"} you`;

