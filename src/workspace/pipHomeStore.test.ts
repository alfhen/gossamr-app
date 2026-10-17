import { beforeEach, describe, expect, it } from "vitest";
import { usePipHome } from "./pipHomeStore";

beforeEach(() => usePipHome.getState().reset());

describe("a decision stays with its workstream (G2)", () => {
  it("drops the open decision, batch and question when another workstream or General is opened", () => {
    const { decide, openWorkstream, openGeneral, ask } = usePipHome.getState();
    decide("k", "A");
    ask({ kind: "x" } as never);
    openWorkstream("B");
    expect(usePipHome.getState()).toMatchObject({ selected: "B", deciding: null, batch: null, asking: null });
    decide("k", "A");
    openGeneral();
    expect(usePipHome.getState()).toMatchObject({ selected: null, deciding: null });
  });

  it("keeps them when the same workstream is opened", () => {
    const { decide, openWorkstream } = usePipHome.getState();
    decide("k", "A");
    openWorkstream("A");
    expect(usePipHome.getState()).toMatchObject({ selected: "A", deciding: "k" });
  });
});
