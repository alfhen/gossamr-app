import { beforeEach, describe, expect, it } from "vitest";
import { useWorkView } from "./workViewStore";

beforeEach(() => useWorkView.getState().reset());

describe("the open workstream and the open decision", () => {
  it("keeps a decision open while a workstream's detail opens and closes beside it", () => {
    const { decide, openWorkstream, closeWorkstream } = useWorkView.getState();
    decide("k");
    openWorkstream("B");
    expect(useWorkView.getState()).toMatchObject({ selected: "B", deciding: "k" });
    closeWorkstream();
    expect(useWorkView.getState()).toMatchObject({ selected: null, deciding: "k" });
  });

  it("opening a decision does not open a workstream", () => {
    useWorkView.getState().decide("k");
    expect(useWorkView.getState().selected).toBeNull();
  });

  it("opening another workstream drops the card asked for in the first", () => {
    const { openWorkstream, focus } = useWorkView.getState();
    openWorkstream("A");
    focus({ type: "draft", id: "d" });
    openWorkstream("B");
    expect(useWorkView.getState().focusTarget).toBeNull();
  });
});
