import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccountState } from "./accountState";
import { MockBackend } from "./backend/mock";
import { useClaude } from "./claudeStore";
import { loadPrefs } from "./workspace/prefs";
import { usePip } from "./workspace/pipStore";
import { syncLine } from "./workspace/Settings";
import { useTabs } from "./workspace/tabsStore";
import { useToasts } from "./workspace/toasts";
import { useWorkspace } from "./workspaceStore";

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("per-account state", () => {
  beforeEach(async () => {
    stubStorage();
    resetAccountState("jira:site:me");
    await useWorkspace.getState().init(new MockBackend());
    useClaude.setState({ byTicket: { "CA-1": { turns: [], sessionId: "s" } } });
    usePip.setState({ filtered: { tabId: "t", before: { type: "open" }, beforeTitle: null, filter: { type: "open" }, note: "" } });
    useTabs.getState().openTab({ title: "Mine" });
    useToasts.getState().push("old");
  });

  it("keeps tabs for the same account but drops conversations, filters and the loaded workspace", () => {
    resetAccountState("jira:site:me");
    expect(useClaude.getState().byTicket).toEqual({});
    expect(usePip.getState().filtered).toBeNull();
    expect(useWorkspace.getState().status).toBe("idle");
    expect(useToasts.getState().toasts).toEqual([]);
    expect(useTabs.getState().tabs.length).toBeGreaterThan(1);
  });

  it("releases the object URLs of sent images when conversations are dropped", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const turn = { requestId: "r", prompt: "p", steps: [], text: "", status: "done" as const, error: null };
    useClaude.setState({
      byTicket: { workspace: { sessionId: null, turns: [{ ...turn, images: [{ id: "a", url: "blob:a", width: 1, height: 1 }, { id: "b", url: "blob:b", width: 1, height: 1 }] }, turn] } },
    });
    resetAccountState("jira:site:me");
    expect(revoke.mock.calls.map(([u]) => u)).toEqual(["blob:a", "blob:b"]);
    revoke.mockRestore();
  });

  it("forgets everything about another account or a sign-out", () => {
    resetAccountState("jira:site:someone-else");
    expect(usePip.getState().filtered).toBeNull();
    expect(useTabs.getState().tabs).toHaveLength(1);
  });
});

describe("the saved board column order", () => {
  it("is read back per project and falls back to nothing when the stored value is corrupt", () => {
    stubStorage({ "gossamr-prefs": JSON.stringify({ columnOrder: { "mock:CA": ["a", "b"], "mock:WEB": "nope" } }) });
    expect(loadPrefs().columnOrder).toEqual({ "mock:CA": ["a", "b"] });
    stubStorage({ "gossamr-prefs": JSON.stringify({ columnOrder: 7 }) });
    expect(loadPrefs().columnOrder).toEqual({});
    stubStorage({ "gossamr-prefs": "{not json" });
    expect(loadPrefs().columnOrder).toEqual({});
  });
});

describe("the connection row", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("says what the sync is doing", () => {
    expect(syncLine({ syncing: true, lastSyncAt: null, error: null }, now)).toEqual({ text: "Syncing…", tone: "busy" });
    expect(syncLine({ syncing: false, lastSyncAt: null, error: null }, now).text).toBe("Not synced yet");
    expect(syncLine({ syncing: false, lastSyncAt: "2026-09-30T11:55:00Z", error: null }, now)).toEqual({ text: "Last synced 5m ago", tone: "ok" });
    const failed = syncLine({ syncing: false, lastSyncAt: "2026-09-30T11:55:00Z", error: "HTTP 503" }, now);
    expect(failed.tone).toBe("error");
    expect(failed.text).toContain("HTTP 503");
    const blip = syncLine({ syncing: false, lastSyncAt: "2026-09-30T11:55:00Z", error: "timed out", transient: true }, now);
    expect(blip.tone).toBe("busy");
    expect(blip.text).toContain("trying again");
  });
});
