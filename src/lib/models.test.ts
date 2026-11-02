import { describe, expect, it } from "vitest";
import { defaultModelDefaults, modelList, validModelId } from "./models";

describe("the model list", () => {
  it("is Default, Fable, Opus, Sonnet and Haiku, then the instance's own models", () => {
    expect(modelList(["claude-opus-5-5[1m]"]).map((m) => m.id)).toEqual(["default", "claude-fable-5-1", "opus", "sonnet", "haiku", "claude-opus-5-5[1m]"]);
    expect(modelList([]).find((m) => m.id === "claude-fable-5-1")?.label).toBe("Fable");
  });

  it("leaves out an added id that is already listed in any case, or that breaks the id rule", () => {
    expect(modelList(["Opus", "--model", "a b", "fine-1"]).map((m) => m.id).slice(5)).toEqual(["fine-1"]);
  });
});

describe("a model id", () => {
  it("starts with a letter or digit, uses letters, digits and . _ - [ ], and stops at 100 characters", () => {
    for (const good of ["opus", "claude-opus-5-5[1m]", "gpt-5.1_mini", "4o", "a".repeat(100)]) expect(validModelId(good), good).toBe(true);
    for (const bad of ["", "-x", "--dangerously-skip-permissions", ".hidden", "[1m]", "two words", "a;b", "a$(id)", "a\nb", "é", "a".repeat(101)]) expect(validModelId(bad), bad).toBe(false);
  });
});

describe("the default choices", () => {
  it("are Sonnet at medium for Pip and Default for agents, both on the default Claude", () => {
    expect(defaultModelDefaults()).toEqual({ pip: { instanceId: "claude", model: "sonnet", effort: "medium" }, agents: { instanceId: "claude", model: "default" } });
  });
});
