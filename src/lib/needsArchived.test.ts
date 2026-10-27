import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { needs, type NeedsInput } from "./needs";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const base = new MockBackend().runs.list()[0];
const ref = { connectionId: "mock", externalId: "CA-401", key: "CA-401" };
const failed = (id: string, minutesAgo: number, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  state: "failed",
  item: ref,
  spec: { ...base.spec, role: "investigate", workstream: null },
  failure: null,
  needs: null,
  error: "boom",
  queuedAt: iso(minutesAgo),
  lastProgressAt: iso(minutesAgo),
  endedAt: iso(minutesAgo),
  archivedAt: null,
  ...over,
});
const input = (runs: Run[]): NeedsInput => ({ workstreams: [], runs, proposals: [], dismissed: new Set() });

describe("needs: archived runs", () => {
  it("an archived run is closed: its failure is no longer a need", () => {
    expect(needs(input([failed("r1", 30)])).map((n) => n.kind)).toEqual(["failure"]);
    expect(needs(input([failed("r1", 30, { archivedAt: iso(1) })]))).toEqual([]);
  });

  it("archiving the newest failure does not bring an older one of the same kind back", () => {
    const older = failed("older", 90);
    const newest = failed("newest", 30);
    expect(needs(input([older, newest])).map((n) => n.runId)).toEqual(["newest"]);
    expect(needs(input([older, { ...newest, archivedAt: iso(1) }]))).toEqual([]);
  });
});
