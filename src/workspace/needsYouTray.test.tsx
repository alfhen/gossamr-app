import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal } from "../types";
import { NO_FILTERS, agentsWaitingOnYou, attentionCount, groupRuns, slotWaiters, stopAllLabel, stoppable, summaryLine, yourAgents } from "./agentsLogic";
import { NeedsYouTray, needsYouText, openNeedsYou } from "./NeedsYouTray";
import { composerFooter, needsYouItems, type NeedsYouItem } from "./pipHomeLogic";
import { PipRunStripView } from "./PipRunCard";
import { railBadgeText } from "./Rail";
import { usePipHome } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { loadTabs, useTabs } from "./tabsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

const NOW = new Date("2026-09-30T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const items: NeedsYouItem[] = [
  { key: "draft:d1", kind: "draft", workstreamId: "ws-1", label: "CA-401 · Draft comment", head: "CA-401 · Welcome flow refresh", reason: "Draft comment", at: ago(12), target: { type: "draft", id: "d1" } },
  { key: "run:r2", kind: "question", workstreamId: "ws-1", label: "R2 asks a question", head: null, reason: "R2 asks a question", at: ago(5), target: { type: "run", id: "r2" } },
  { key: "held:ws-2", kind: "held", workstreamId: "ws-2", label: "Held: budget", head: null, reason: "Held: budget", at: ago(2), target: { type: "workstream" } },
  { key: "draft:d9", kind: "draft", workstreamId: null, label: "CA-500 · Draft move", head: "CA-500", reason: "Draft move", at: ago(1), target: { type: "draft", id: "d9" } },
];

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
});

afterEach(() => {
  usePipHome.getState().reset();
  useRuns.setState({ sheet: null, selectedId: null });
  useTabs.getState().setRoute("workspace");
  vi.unstubAllGlobals();
});

describe("the Needs you tray", () => {
  it("shows the count and each item in the order given, with how long it has waited", () => {
    const html = renderToStaticMarkup(<NeedsYouTray items={items} now={NOW} />);
    expect(html).toContain('<section aria-label="Needs you"');
    expect(html).toMatch(/data-needs-you-count[^>]*>4</);
    const heads = [...html.matchAll(/data-needs-you-head="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual(["CA-401 · Welcome flow refresh", "R2 asks a question · 5m", "Held: budget", "CA-500"]);
    const reasons = [...html.matchAll(/data-needs-you-reason="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(reasons).toEqual(["Draft comment · 12m", "Draft move · 1m"]);
  });

  it("puts the ticket and its title on the first line and the wait on the second, with the whole line as the name and tooltip", () => {
    const html = renderToStaticMarkup(<NeedsYouTray items={items.slice(0, 1)} now={NOW} />);
    expect(html).toContain('aria-label="CA-401 · Welcome flow refresh · Draft comment · 12m"');
    expect(html).toContain('title="CA-401 · Welcome flow refresh · Draft comment · 12m"');
    expect(html.indexOf("data-needs-you-head")).toBeLessThan(html.indexOf("data-needs-you-reason"));
    expect(needsYouText(items[3], NOW)).toBe("CA-500 · Draft move · 1m");
  });

  it("says so when nothing waits", () => {
    const html = renderToStaticMarkup(<NeedsYouTray items={[]} now={NOW} />);
    expect(html).toMatch(/data-needs-you-count[^>]*>0</);
    expect(html).toContain("Nothing needs you.");
  });

  it("ages a hold not at all: the hold says what it is", () => {
    expect(needsYouText(items[2], NOW)).toBe("Held: budget");
  });
});

describe("activating an item", () => {
  it("on Pip home selects its workstream and asks for its card, staying on the route", () => {
    useTabs.getState().setRoute("pip");
    openNeedsYou(items[0]);
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().selected).toBe("ws-1");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "draft", id: "d1" });
    expect(useRuns.getState().sheet).toBeNull();
  });

  it("from another route goes to Pip home first", () => {
    useTabs.getState().setRoute("workspace");
    openNeedsYou(items[2]);
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().selected).toBe("ws-2");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "workstream" });
  });

  it("opens a run's sheet over Pip home, where its question is answered", () => {
    useTabs.getState().setRoute("agents");
    openNeedsYou(items[1]);
    expect(useTabs.getState().route).toBe("pip");
    expect(usePipHome.getState().focusTarget).toEqual({ type: "run", id: "r2" });
    expect(useRuns.getState().sheet).toEqual({ type: "run", id: "r2" });
  });

  it("goes to General for an item in no workstream", () => {
    usePipHome.getState().openWorkstream("ws-1");
    openNeedsYou(items[3]);
    expect(usePipHome.getState().selected).toBeNull();
    expect(usePipHome.getState().focusTarget).toEqual({ type: "draft", id: "d9" });
  });
});

describe("every count of needs you and of agents, from one fixture (D4, D5, N3)", () => {
  const backend = new MockBackend();
  const runs = backend.runs.list();
  const at = Date.now();
  const proposal = (id: string, intent: Intent): Proposal =>
    ({ id, createdAt: ago(3), updatedAt: ago(3), origin: { type: "chat", requestId: `q-${id}`, workstream: null }, createdBy: "pip", intent, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null }) as unknown as Proposal;
  const ticket = { connectionId: "mock", externalId: "CA-401", key: "CA-401" };
  const proposals = [proposal("p1", { type: "comment", item: ticket, body: docFromText("Checking in."), mentions: [] } as unknown as Intent), proposal("p2", { type: "startRun", connectionId: "mock", item: ticket, spec: { ...runs[0].spec, kind: "investigate" } } as unknown as Intent)];
  const failed = runs.find((r) => r.state === "failed")!;

  for (const seen of [new Set<string>(), new Set([failed.id])]) {
    it(`agrees on Pip home, the tray, both rail badges, the Agents header, Your agents and Stop all${seen.size ? ", once the failed run was looked at" : ""}`, () => {
      const items = needsYouItems({ workstreams: [], runs, proposals, seenFailed: seen });
      const n = items.length;
      // Needs you: the tray's pill, the Pip home badge and the composer footer.
      expect(renderToStaticMarkup(<NeedsYouTray items={items} now={NOW} />)).toMatch(new RegExp(`data-needs-you-count[^>]*>${n}<`));
      expect(railBadgeText.pipHome(n)).toBe(`${n} items wait in Needs you`);
      expect(Number(/(\d+) needs? you/.exec(composerFooter(runs, items, at))?.[1])).toBe(n);
      // Its agent part: the tray's run items, the Agents rail badge and the Agents header's "waiting on you".
      const waiting = agentsWaitingOnYou(runs, seen);
      const runItems = items.filter((i) => i.kind === "question" || i.kind === "permission" || i.kind === "failure");
      expect(runItems).toHaveLength(waiting.length);
      expect(attentionCount(runs, seen)).toBe(waiting.length);
      expect(summaryLine(runs, at, seen)).toMatch(new RegExp(`^${waiting.length} waiting on you · `));
      expect(railBadgeText.agents(waiting.length)).toMatch(/agent runs? waits? on you$/);
      // Drafts are the rest: Needs you is the agents waiting plus the drafts waiting.
      expect(n).toBe(waiting.length + proposals.length);
      // Your agents: the strip's "3 of M" is every agent, the waiting ones among them.
      const mine = yourAgents(runs, seen);
      const strip = renderToStaticMarkup(<PipRunStripView runs={runs} enabled now={at} seenFailed={seen} titleOf={() => null} onOpen={() => {}} onSeeAll={() => {}} />);
      expect(Number(/data-strip-count[^>]*>\d+ of (\d+)</.exec(strip)?.[1])).toBe(mine.length);
      for (const r of waiting) expect(mine).toContain(r);
      // Failed or stuck in the header is the lane of that name, card for card (N3).
      const bad = groupRuns(runs, NO_FILTERS, at).find((g) => g.lane === "bad")?.runs.length ?? 0;
      expect(Number(/(\d+) failed or stuck/.exec(summaryLine(runs, at, seen))?.[1])).toBe(bad);
      // Stop all counts a set of its own, and says so.
      expect(stopAllLabel(stoppable(runs).length + slotWaiters(runs).length)).toMatch(/^Stop all \(\d+ stoppable\)$/);
    });
  }

  it("keeps a folder to trust in every count after Agents was opened and marked its failures seen (R5)", () => {
    const trust = runs.find((r) => r.failure?.type === "untrustedFolder")!;
    const other = { ...trust, id: "r-other", failure: { type: "other" } } as unknown as typeof trust;
    const all = [...runs, other];
    useRuns.setState({ runs: all, seenFailed: new Set() });
    useRuns.getState().markSeen();
    const seen = useRuns.getState().seenFailed;
    expect(seen.has(trust.id)).toBe(false);
    expect(seen.has(other.id)).toBe(true);
    const items = needsYouItems({ workstreams: [], runs: all, proposals: [], seenFailed: seen });
    const waiting = agentsWaitingOnYou(all, seen);
    expect(waiting).toContain(trust);
    expect(items.some((i) => i.key === `run:${trust.id}` && i.kind === "permission")).toBe(true);
    expect(items).toHaveLength(waiting.length);
    expect(attentionCount(all, seen)).toBe(waiting.length);
    expect(summaryLine(all, at, seen)).toMatch(new RegExp(`^${waiting.length} waiting on you · `));
  });
});
