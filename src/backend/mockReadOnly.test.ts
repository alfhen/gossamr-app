import { describe, expect, it } from "vitest";
import type { RunKind, RunSpec } from "../types";
import fixtures from "./readOnly.fixtures.json";
import { runsTests } from "../workspace/runSheetLogic";
import { INSTRUCTIONS, READ_ONLY_DENY, READ_ONLY_GUARD, READ_ONLY_KINDS, TEST_RUNNERS, isReadOnlyKind, readOnlyRules, testCommands } from "./mockRunKinds";
import { renderPrompt } from "./mockRuns";

const KINDS: RunKind[] = ["investigate", "triage", "plan", "build", "review", "verify"];
const fixtureSpec: RunSpec = { kind: "investigate", repo: "acme/webshop", clonePath: "/Users/me/Code/webshop", base: "main", name: "ca-1-x-ab12", instruction: "", focus: null, focusFromRun: null, ticketBlock: "CA-1: x" };

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

  it("allows no prefix rule, and the test runners, each with no argument, only to a review or a verify", () => {
    for (const kind of KINDS.filter(isReadOnlyKind)) {
      const rules = readOnlyRules({ kind, base: "main", pr: kind === "review" ? 3 : null, prSha: null })!;
      for (const rule of rules.allow) expect(rule).not.toContain("*");
      expect(TEST_RUNNERS.every((t) => rules.allow.includes(t))).toBe(kind === "review" || kind === "verify");
      expect(rules).toMatchObject({ settingSources: "", strictMcpConfig: true });
    }
    for (const runner of TEST_RUNNERS) expect(runner).not.toMatch(/\*| -/);
    // The page tells a step that runs tests apart by these rules (`runsTests`).
    expect(runsTests(readOnlyRules({ kind: "verify", base: "main", pr: null, prSha: null }))).toBe(true);
    expect(runsTests(readOnlyRules({ kind: "triage", base: "main", pr: null, prSha: null }))).toBe(false);
    for (const runner of TEST_RUNNERS) expect(runsTests({ mode: "dontAsk", allow: [runner], deny: [], guard: "" })).toBe(true);
  });

  it("names in the prompt every command it allows, and allows every command the prompt names, as the Rust side does", () => {
    const VETTED_READS = ["gh pr view", "gh pr diff"];
    const named = (prompt: string) => prompt.split("`").filter((_, i) => i % 2 === 1).filter((c) => c.includes(" ") || testCommands().includes(c));
    const specs = KINDS.filter(isReadOnlyKind).flatMap((kind) => [null, "a1b2c3d4e5f6"].flatMap((prSha) => [false, true].map((report) => ({ ...fixtureSpec, kind, pr: kind === "review" ? 12 : null, prSha: kind === "review" ? prSha : null, report, instruction: INSTRUCTIONS[kind] }))));
    specs.push({ ...fixtureSpec, kind: "verify", pr: 12, prSha: "a1b2c3d4e5f6", report: true, instruction: INSTRUCTIONS.verify });
    for (const spec of specs) {
      const commands = named(renderPrompt(spec));
      const allow = readOnlyRules(spec)!.allow;
      for (const c of commands) expect(allow.includes(`Bash(${c})`) || VETTED_READS.includes(c), `${spec.kind}: ${c}`).toBe(true);
      for (const rule of allow) expect(commands).toContain(rule.replace(/^Bash\((.*)\)$/, "$1"));
    }
    expect(renderPrompt({ ...fixtureSpec, kind: "review", pr: 12, prSha: null, instruction: INSTRUCTIONS.review })).toContain("then `git checkout --detach FETCH_HEAD`. If either fails, stop: say so and end with 'Verdict: blocking'. Never review or test `main` in its place.");
    expect(renderPrompt({ ...fixtureSpec, kind: "verify", pr: 12, prSha: "a1b2c3d4e5f6", instruction: INSTRUCTIONS.verify })).toContain("then `git checkout --detach a1b2c3d4e5f6`. If either fails, stop: say so and that you could not check the change.");
  });

  it("hands out a fresh copy each time, so changing one changes no other", () => {
    const a = readOnlyRules({ kind: "triage", base: "main", pr: null, prSha: null })!;
    a.deny.pop();
    expect(readOnlyRules({ kind: "triage", base: "main", pr: null, prSha: null })!.deny).toEqual(READ_ONLY_DENY);
  });
});
