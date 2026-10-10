import { describe, expect, it } from "vitest";
import type { RunKind } from "../types";
import fixtures from "./readOnly.fixtures.json";
import { READ_ONLY_DENY, READ_ONLY_GUARD, READ_ONLY_KINDS, TEST_RUNNERS, isReadOnlyKind, readOnlyRules } from "./mockRunKinds";

const KINDS: RunKind[] = ["investigate", "triage", "plan", "build", "review", "verify"];

describe("the read-only restriction the Rust side gives too (readOnly.fixtures.json)", () => {
  it.each(fixtures.cases.map((c) => [`${c.kind} on ${c.base}${c.pr != null ? ` #${c.pr}` : ""}${c.prSha ? ` at ${c.prSha}` : ""}`, c] as const))("%s", (_, c) => {
    expect(readOnlyRules({ kind: c.kind as RunKind, base: c.base, pr: c.pr, prSha: c.prSha })).toEqual(c.expected);
  });

  it("covers every kind, and only a Build launches without one", () => {
    expect(new Set(fixtures.cases.map((c) => c.kind))).toEqual(new Set(KINDS));
    expect(KINDS.filter(isReadOnlyKind)).toEqual(KINDS.filter((k) => k !== "build"));
    expect([...READ_ONLY_KINDS].sort()).toEqual(KINDS.filter((k) => k !== "build").sort());
  });

  it("uses the same deny list and guard as domain/run.rs", () => {
    const investigate = fixtures.cases.find((c) => c.kind === "investigate")!.expected!;
    expect(READ_ONLY_DENY).toEqual(investigate.deny);
    expect(READ_ONLY_GUARD).toBe(investigate.guard);
    for (const write of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(git push *)", "Bash(git commit *)", "Bash(rm *)"]) expect(READ_ONLY_DENY).toContain(write);
  });

  it("allows no prefix rule but the test runners, and those only to a review or a verify", () => {
    for (const kind of KINDS.filter(isReadOnlyKind)) {
      const rules = readOnlyRules({ kind, base: "main", pr: kind === "review" ? 3 : null, prSha: null })!;
      for (const rule of rules.allow) if (rule.endsWith(" *)")) expect(TEST_RUNNERS).toContain(rule);
      expect(TEST_RUNNERS.every((t) => rules.allow.includes(t))).toBe(kind === "review" || kind === "verify");
    }
  });

  it("hands out a fresh copy each time, so changing one changes no other", () => {
    const a = readOnlyRules({ kind: "triage", base: "main", pr: null, prSha: null })!;
    a.deny.pop();
    expect(readOnlyRules({ kind: "triage", base: "main", pr: null, prSha: null })!.deny).toEqual(READ_ONLY_DENY);
  });
});
