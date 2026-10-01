import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { failureHelp, retryEnabled, shellQuote } from "./failureHelp";

const runs = () => new MockBackend({ runs: { seed: "failures" } }).runs.list();
const of = (type: string) => runs().find((r) => r.failure?.type === type)!;

describe("failure help", () => {
  it("has a kind, a line and a next step for each failure the person can fix, and nothing for the rest", () => {
    const kinds = ["untrustedFolder", "notSignedIn", "claudeMissing", "noClone", "capReached"];
    expect(kinds.map((k) => failureHelp(of(k))?.kind)).toEqual(kinds);
    expect(failureHelp(of("other"))).toBeNull();
    expect(failureHelp({ ...of("other"), failure: null })).toBeNull();
  });

  it("applies only to a failed run with no session", () => {
    const run: Run = of("untrustedFolder");
    expect(failureHelp({ ...run, state: "working" })).toBeNull();
    expect(failureHelp({ ...run, shortId: "1000a000" })).toBeNull();
  });

  it("makes Retry wait for Terminal where there is a step to take there, and never elsewhere", () => {
    const waits = (type: string) => !retryEnabled(failureHelp(of(type))!, false);
    expect(["untrustedFolder", "notSignedIn"].map(waits)).toEqual([true, true]);
    expect(["claudeMissing", "noClone", "capReached"].map(waits)).toEqual([false, false, false]);
    expect(retryEnabled(failureHelp(of("untrustedFolder"))!, true)).toBe(true);
  });

  it("gives the exact command to run in your own terminal, quoted for the shell", () => {
    expect(failureHelp(of("untrustedFolder"))?.command?.text).toBe("cd '/Users/sample/Code/storefront' && claude");
    expect(failureHelp(of("notSignedIn"))?.command).toEqual({ text: "claude", note: "Then type /login." });
    expect(failureHelp(of("claudeMissing"))?.command?.text).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(shellQuote("/Users/me/My Code/it's")).toBe("'/Users/me/My Code/it'\\''s'");
  });
});
