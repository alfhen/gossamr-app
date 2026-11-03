import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run } from "../types";
import { STILL_UNTRUSTED, failureHelp, retryEnabled, shellQuote } from "./failureHelp";

const runs = () => new MockBackend({ runs: { seed: "failures" } }).runs.list();
const of = (type: string) => runs().find((r) => r.failure?.type === type)!;

describe("failure help", () => {
  it("has a kind, a line and a next step for each failure the person can fix, and nothing for the rest", () => {
    const kinds = ["untrustedFolder", "notSignedIn", "modeRefused", "claudeMissing", "noClone", "capReached"];
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
    expect(["untrustedFolder", "notSignedIn", "modeRefused"].map(waits)).toEqual([true, true, true]);
    expect(["claudeMissing", "noClone", "capReached"].map(waits)).toEqual([false, false, false]);
    expect(retryEnabled(failureHelp(of("untrustedFolder"))!, true)).toBe(true);
  });

  it("gives the exact command to run in your own terminal, quoted for the shell", () => {
    expect(failureHelp(of("untrustedFolder"))?.command?.text).toBe("cd '/Users/sample/Gossamr/agents/acme/storefront' && claude");
    expect(failureHelp(of("notSignedIn"))?.command).toEqual({ text: "claude", note: "Then type /login." });
    expect(failureHelp(of("modeRefused"))?.command?.text).toBe("claude --permission-mode auto");
    expect(failureHelp(of("claudeMissing"))?.command?.text).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(shellQuote("/Users/me/My Code/it's")).toBe("'/Users/me/My Code/it'\\''s'");
  });

  it("names the login a run was on and gives the sign-in command for its folder", () => {
    const help = failureHelp(of("notSignedIn"), null, { name: "Claude work", signIn: "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login" })!;
    expect(help.summary).toBe("Claude work isn't signed in.");
    expect(help.detail).toContain("Terminal opens with Claude work");
    expect(help.command).toEqual({ text: "CLAUDE_CONFIG_DIR=~/.claude-work claude auth login", note: null });
  });

  it("keeps the plain Claude command for the usual login", () => {
    const help = failureHelp(of("notSignedIn"), null, { name: "Claude", signIn: null })!;
    expect([help.summary, help.command]).toEqual(["Claude isn't signed in.", { text: "claude", note: "Then type /login." }]);
  });

  it("sends every failed run set up outside the work folder to Pip, whatever it failed on", () => {
    for (const type of ["noClone", "capReached", "notSignedIn", "untrustedFolder"]) {
      const help = failureHelp({ ...of(type), inWorkFolder: false });
      expect([type, help?.kind, help?.retry, help?.primary]).toEqual([type, "outsideWorkFolder", false, null]);
    }
  });

  it("names the login in the trust offer and the missing-command line", () => {
    const work = { name: "Claude work", signIn: null };
    const trust = failureHelp(of("untrustedFolder"), null, work)!;
    expect(trust.summary).toBe("Claude work hasn't trusted Gossamr's clone of acme/storefront yet.");
    expect(trust.primary).toEqual({ label: "Trust this clone for Claude work", act: "trust" });
    expect(trust.detail).toContain("for Claude work only");
    expect(failureHelp(of("claudeMissing"), null, work)!.summary).toContain("Claude work");
  });

  it("says a folder in the way is never removed without repeating that it should be moved", () => {
    const occupied = { ...of("noClone"), failure: { type: "cloneOccupied", path: "/x" } } as Run;
    const said = (error: string | null) => failureHelp({ ...occupied, error })?.detail ?? "";
    expect(said("~/Gossamr/agents/acme/payments already exists and isn't a clone of acme/payments. Move it away, then retry.").match(/move it away/gi)).toHaveLength(1);
    expect(said(null)).toContain("Gossamr never removes it. Move it away, then retry.");
  });

  it("offers to trust the clone first and Terminal second, only for a run whose clone is in the work folder", () => {
    const help = failureHelp(of("untrustedFolder"))!;
    expect(help.summary).toBe("Claude hasn't trusted Gossamr's clone of acme/storefront yet.");
    expect([help.primary, help.secondary]).toEqual([
      { label: "Trust this clone for Claude", act: "trust" },
      { label: "Trust in Terminal instead", act: "terminal" },
    ]);
    expect(help.detail).toContain("hooks, MCP servers and permission rules in its .claude folder and .mcp.json");
    const unknown = failureHelp({ ...of("untrustedFolder"), inWorkFolder: undefined })!;
    expect([unknown.primary?.act, unknown.secondary ?? null]).toEqual(["terminal", null]);
  });

  it("puts Terminal first after a refusal, and drops the one-click button once Claude refused a saved trust", () => {
    const run = of("untrustedFolder");
    const why = "Gossamr trusts only its own clones in ~/Gossamr/agents.";
    const refused = failureHelp(run, why)!;
    expect([refused.refusal, refused.primary?.act, refused.secondary?.act]).toEqual([why, "terminal", "trust"]);
    const still = failureHelp(run, STILL_UNTRUSTED)!;
    expect([still.primary?.act, still.secondary]).toEqual(["terminal", null]);
    expect(retryEnabled(still, false)).toBe(false);
  });
});
