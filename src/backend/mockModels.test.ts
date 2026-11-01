import { describe, expect, it } from "vitest";
import type { ModelChoice } from "../types";
import { MockBackend } from "./mock";

describe("the mock model lists and defaults", () => {
  it("lists the Claude models and refuses an id that is not a provider", async () => {
    const b = new MockBackend();
    expect((await b.providerModels("claude")).map((m) => m.label)).toEqual(["Default", "Fable", "Opus", "Sonnet", "Haiku"]);
    await expect(b.providerModels("jira")).rejects.toThrow("isn't a provider");
    await expect(b.providerAddModel("github", "opus")).rejects.toThrow("isn't a provider");
  });

  it("adds a model to the list, once, and refuses a hostile id", async () => {
    const b = new MockBackend();
    await b.providerAddModel("claude", "claude-opus-5-5[1m]");
    const list = await b.providerAddModel("claude", "claude-opus-5-5[1m]");
    expect(list.filter((m) => m.id === "claude-opus-5-5[1m]")).toHaveLength(1);
    for (const hostile of ["--dangerously-skip-permissions", "a b", ""]) await expect(b.providerAddModel("claude", hostile)).rejects.toThrow("A model id uses");
    expect(await b.providerModels("claude")).toHaveLength(6);
  });

  it("starts with the documented defaults and saves a change", async () => {
    const b = new MockBackend();
    expect(await b.modelDefaults()).toEqual({ pip: { instanceId: "claude", model: "sonnet", effort: "medium" }, agents: { instanceId: "claude", model: "default" } });
    const next = { pip: { instanceId: "claude", model: "opus", effort: "high" }, agents: { instanceId: "claude", model: "haiku" } };
    expect(await b.modelSetDefaults(next)).toEqual(next);
    expect(await b.modelDefaults()).toEqual(next);
  });

  it("refuses a default Pip can't run, a model not on the list and an effort outside the list, and keeps the old one", async () => {
    const b = new MockBackend();
    const before = await b.modelDefaults();
    const agents = before.agents;
    await expect(b.modelSetDefaults({ pip: { instanceId: "claude", model: "default" }, agents })).rejects.toThrow("Pick a model for Pip.");
    await expect(b.modelSetDefaults({ pip: { instanceId: "claude", model: "--model" }, agents })).rejects.toThrow("Pick a model for Pip.");
    await expect(b.modelSetDefaults({ pip: { instanceId: "claude", model: "sonnet", effort: "extreme" }, agents })).rejects.toThrow("Pick a model for Pip.");
    await expect(b.modelSetDefaults({ pip: { instanceId: "gone", model: "sonnet" }, agents })).rejects.toThrow("Pick which Claude");
    await expect(b.modelSetDefaults({ pip: before.pip, agents: { instanceId: "gone", model: "default" } })).rejects.toThrow("That instance was removed. Pick another.");
    await expect(b.modelSetDefaults({ pip: before.pip, agents: { instanceId: "claude", model: "opus", effort: "high" } })).rejects.toThrow("Pick a model for this run.");
    expect(await b.modelDefaults()).toEqual(before);
  });

  it("takes a null effort as none and stops at 20 added models", async () => {
    const b = new MockBackend();
    const pip = { instanceId: "claude", model: "sonnet", effort: null } as unknown as ModelChoice;
    await b.modelSetDefaults({ pip, agents: { instanceId: "claude", model: "default" } });
    for (let n = 0; n < 20; n++) await b.providerAddModel("claude", `m${n}`);
    await expect(b.providerAddModel("claude", "one-more")).rejects.toThrow("Keep it to 20");
    expect(await b.providerAddModel("claude", "M3")).toHaveLength(25);
  });

  it("clears the defaults that named a removed instance", async () => {
    const b = new MockBackend();
    await b.connectionRemove("claude");
    expect(await b.modelDefaults()).toEqual({ pip: null, agents: null });
    await expect(b.providerModels("claude")).rejects.toThrow("isn't a provider");
  });
});
