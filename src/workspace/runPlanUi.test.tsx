import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { AgentCard } from "./AgentCard";
import { buildFromPlanControl } from "./runSheetLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const backend = new MockBackend({ runs: { seed: "kinds", epoch: NOW } });
const plan: Run = backend.runs.list().find((r) => r.spec.role === "planner")!;

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("every surface shows the plan run's role", () => {
  it("names the role on the card", () => {
    const card = renderToStaticMarkup(<AgentCard run={plan} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(card).toContain(">Planner<");
  });
});

describe("Ask Pip to build on a card", () => {
  const card = (run: Run, onBuildFromPlan?: () => void) =>
    renderToStaticMarkup(<AgentCard run={run} now={NOW} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} onBuildFromPlan={onBuildFromPlan} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);

  it("shows the button only when it is given one", () => {
    expect(card(plan, vi.fn())).toContain("Ask Pip to build");
    expect(card(plan)).not.toContain("Ask Pip to build");
  });

  it("is enabled for a finished, fully read plan run on a ticket, and for nothing else", () => {
    expect(buildFromPlanControl(plan)).toEqual({ enabled: true, reason: null });
    const off = (over: Partial<Run>) => buildFromPlanControl({ ...plan, ...over });
    expect(off({ state: "working" }).enabled).toBe(false);
    expect(off({ item: null }).reason).toContain("needs a ticket");
    expect(off({ result: "  " }).reason).toContain("no plan");
    expect(off({ resultComplete: false }).reason).toContain("read in full");
    expect(off({ spec: { ...plan.spec, role: "triager" } }).reason).toContain("Only a plan run");
  });
});
