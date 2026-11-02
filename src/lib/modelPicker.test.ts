import { describe, expect, it } from "vitest";
import type { ConnectionInfo, ProbeSnapshot } from "../types";
import { choiceLabel, movesTo, pickerInstances, pipModels, switchingLine, unavailableReason } from "./modelPicker";

const status = (state: ProbeSnapshot["state"]): ProbeSnapshot => ({ installed: true, version: null, state, account: null, activeLogin: null, message: "", detail: null, fix: null, checkedAt: "" });
const row = (over: Partial<ConnectionInfo>): ConnectionInfo => ({ id: "claude", instanceId: "claude", displayName: "Claude", enabled: true, kind: "provider", driver: "claude", workspace: "", url: "", account: "", lastSyncAt: null, syncing: false, error: null, transient: false, reauth: false, status: status("ready"), rechecking: false, ...over });

describe("unavailableReason", () => {
  it("is none for a signed-in Claude that is on", () => {
    expect(unavailableReason(row({}))).toBeNull();
  });

  it("says why a Claude that is off, signed out or missing can't run Pip", () => {
    expect(unavailableReason(row({ enabled: false }))).toBe("Off");
    expect(unavailableReason(row({ status: status("notSignedIn") }))).toBe("Not signed in");
    expect(unavailableReason(row({ status: status("notFound") }))).toBe("Not installed");
  });

  it("says Pip can't run on Codex yet", () => {
    expect(unavailableReason(row({ driver: "codex" }))).toBe("Pip can't run on Codex yet");
  });
});

describe("pickerInstances", () => {
  it("lists provider rows in order and leaves out other connections and the unreadable-list row", () => {
    const rows = [row({ kind: "github", driver: undefined, instanceId: "github" }), row({ instanceId: "claude_work", displayName: "Claude work" }), row({ instanceId: "providers", driver: undefined, error: "x" }), row({})];
    expect(pickerInstances(rows).map((i) => i.id)).toEqual(["claude_work", "claude"]);
  });
});

describe("pipModels", () => {
  it("leaves out Default, which Pip never runs on", () => {
    expect(pipModels([{ id: "default", label: "Default" }, { id: "opus", label: "Opus" }])).toEqual([{ id: "opus", label: "Opus" }]);
  });
});

describe("choiceLabel", () => {
  const instances = pickerInstances([row({ instanceId: "claude_work", displayName: "Claude work" })]);
  const models = { claude_work: [{ id: "sonnet", label: "Sonnet" }] };

  it("joins the instance name and the model's label", () => {
    expect(choiceLabel({ instanceId: "claude_work", model: "sonnet" }, instances, models)).toBe("Claude work · Sonnet");
  });

  it("falls back to the model id when the list doesn't have it", () => {
    expect(choiceLabel({ instanceId: "claude_work", model: "claude-next-1" }, instances, models)).toBe("Claude work · claude-next-1");
  });

  it("is null without a choice or for an instance that is gone", () => {
    expect(choiceLabel(null, instances, models)).toBeNull();
    expect(choiceLabel({ instanceId: "gone", model: "opus" }, instances, models)).toBeNull();
  });
});

it("words the switch as the proposal does", () => {
  expect(switchingLine("Claude personal")).toBe("Switching to Claude personal starts Pip fresh in this conversation. Your messages and drafts stay.");
});

describe("movesTo", () => {
  const instances = pickerInstances([row({ instanceId: "claude_work", displayName: "Claude work" }), row({})]);
  const work = { instanceId: "claude_work", model: "opus" };

  it("names the instance when the choice is on another one than Pip last ran on", () => {
    expect(movesTo(instances, work, "claude", "claude")?.name).toBe("Claude work");
  });

  it("is none while the choice stays on the instance Pip last ran on", () => {
    expect(movesTo(instances, work, "claude_work", "claude")).toBeUndefined();
  });

  it("compares with the Settings default's instance when Pip hasn't run here yet", () => {
    expect(movesTo(instances, work, undefined, "claude_work")).toBeUndefined();
    expect(movesTo(instances, work, undefined, "claude")?.id).toBe("claude_work");
  });

  it("is none without a choice", () => {
    expect(movesTo(instances, null, "claude", "claude")).toBeUndefined();
  });
});
