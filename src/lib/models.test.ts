import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_MODELS, defaultModelDefaults, DRIVERS, modelList, validModelId, type Driver } from "./models";

describe("DRIVERS", () => {
  it("say what Rust says each driver can run", () => {
    const rust = readFileSync("src-tauri/src/connections.rs", "utf8");
    const runs = (flag: string, driver: Driver) => {
      const variants = new RegExp(`fn ${flag}\\(self\\) -> bool \\{\\s*matches!\\(self, ([^)]*)\\)`).exec(rust)?.[1] ?? "";
      return variants.split("|").some((v) => v.trim() === `Self::${DRIVERS[driver].label}`);
    };
    for (const driver of Object.keys(DRIVERS) as Driver[]) {
      expect({ runsPip: DRIVERS[driver].runsPip, runsAgents: DRIVERS[driver].runsAgents }).toEqual({ runsPip: runs("runs_pip", driver), runsAgents: runs("runs_agents", driver) });
    }
  });
});

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

  it("lists Default and the built-in Codex models for a Codex instance, then its added ids", () => {
    expect(modelList(["gpt-next", "GPT-5.5"], "codex").map((m) => m.id)).toEqual([...CODEX_MODELS.map((m) => m.id), "gpt-next"]);
    expect(modelList([], "codex")[0]).toEqual({ id: "default", label: "Default" });
  });
});
