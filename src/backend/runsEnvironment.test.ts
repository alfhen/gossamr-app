import { describe, expect, it } from "vitest";
import { environmentFromPreflight, readEnvironment } from "./runsEnvironment";

const rows = (...r: [level: "ok" | "warn" | "error", text: string][]) => ({ rows: r.map(([level, text]) => ({ level, text })), blocking: r.some(([l]) => l === "error") });

describe("reading Claude's state from a pre-flight", () => {
  it("is fine when the Claude rows pass, and takes the version from them", () => {
    expect(environmentFromPreflight(rows(["ok", "Claude 2.1.286 is installed"], ["ok", "Signed in"]))).toEqual({ claude: "ok", version: "2.1.286" });
  });

  it("says missing when Claude was not found", () => {
    expect(environmentFromPreflight(rows(["error", "Claude was not found on this Mac"]))).toEqual({ claude: "missing", version: null });
    expect(environmentFromPreflight(rows(["error", "Claude isn't installed"]))).toEqual({ claude: "missing", version: null });
  });

  it("says signed out when the sign-in row fails", () => {
    expect(environmentFromPreflight(rows(["ok", "Claude 2.1.286 is installed"], ["error", "Not signed in to Claude"]))).toEqual({ claude: "signedOut", version: "2.1.286" });
  });

  it("does not take a warning or an unrelated failure for a problem with Claude", () => {
    expect(environmentFromPreflight(rows(["warn", "Not signed in yet, but a run may still start"]))).toMatchObject({ claude: "ok" });
    expect(environmentFromPreflight(rows(["error", "No clone of this repo found"]))).toMatchObject({ claude: "ok" });
  });

  it("reads a failed check as unknown instead of as a problem", async () => {
    expect(await readEnvironment(() => Promise.reject(new Error("runs_preflight is not available yet")))).toEqual({ claude: "unknown", version: null });
    expect(await readEnvironment(() => Promise.resolve(rows(["ok", "Claude 2.1.286 is installed"])))).toMatchObject({ claude: "ok" });
  });
});
