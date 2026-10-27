import { describe, expect, it } from "vitest";
import type { ReadOnly, RunKind } from "../types";
import fixtures from "./permission.fixtures.json";
import { DENIED_MESSAGE, parsePermission, permissionOffer, readAs, READ_ONLY_REFUSES, UNCHECKED } from "./permission";

interface Case {
  case: string;
  kind: string;
  name: string;
  readOnly: boolean;
  needs: string;
  padTo?: number;
  tool: string | null;
  command?: string;
  allow: string;
  reason?: string;
  /** The run's checkout, for a file tool's absolute path. */
  worktree?: string;
}

const RESTRICTED: ReadOnly = { mode: "dontAsk", allow: ["Bash(git fetch origin main)"], deny: ["Edit"], guard: "read-only" };

/** The run as the Rust test builds it from a case, asking permission. */
function runOf(c: Case) {
  let needs = c.needs;
  while ([...needs].length < (c.padTo ?? 0)) needs += "x";
  return { needs, readOnly: c.readOnly ? RESTRICTED : null, spec: { kind: c.kind as RunKind, name: c.name }, expectedWorktree: c.worktree };
}

describe("a permission prompt, on the fixtures the Rust side also runs", () => {
  it.each(fixtures as Case[])("$case", (c) => {
    const offer = permissionOffer(runOf(c));
    expect(offer.allow).toBe(c.allow);
    expect(offer.ask?.tool ?? null).toBe(c.tool);
    if (c.command !== undefined) expect(offer.ask?.command).toBe(c.command);
    if (c.allow === "forbidden") expect(offer.reason).toBe(c.reason);
    else expect(c.reason).toBeUndefined();
    if (c.allow === "offered") expect(offer.reason).toBeNull();
    if (c.allow === "readOnly") expect(offer.reason).toBe(READ_ONLY_REFUSES);
    if (c.allow === "unchecked") expect(offer.reason).toBe(UNCHECKED);
  });

  it("covers every answer", () => {
    expect([...new Set((fixtures as Case[]).map((c) => c.allow))].sort()).toEqual(["forbidden", "notExact", "offered", "readOnly", "unchecked"]);
  });
});

describe("reading a request", () => {
  it("is the tool and the exact command, or nothing for any other text", () => {
    expect(parsePermission("approve Bash: git push -u origin x")).toEqual({ tool: "Bash", command: "git push -u origin x" });
    expect(parsePermission("  Approve   WebFetch:https://example.test \n")).toEqual({ tool: "WebFetch", command: "https://example.test" });
    for (const odd of ["", "approve", "approveBash: ls", "approve : ls", "approve Bash ls", "please approve Bash: ls", "approve two words: ls"]) expect(parsePermission(odd)).toBeNull();
    expect(parsePermission(null)).toBeNull();
    expect(readAs("Claude wants to do something  ")).toBe("Claude wants to do something");
    expect(readAs("approve Bash: ls -la")).toBe("ls -la");
  });

  it("a denial tells the agent to carry on without it and quotes nothing of the request", () => {
    expect(DENIED_MESSAGE).toBe("The person did not allow the request you just asked permission for. Don't run it or anything that does the same. Carry on without it; if the work can't be finished without it, say so in your answer.");
  });
});
