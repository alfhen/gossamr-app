import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { AgentSettings } from "../types";
import { AgentsSettingsView, withDigestMinutes } from "./AgentsSettings";

const SETTINGS: AgentSettings = { maxRuns: 3, wallClockMinutes: 60, tokenCap: 3_000_000, terminal: "terminal", draftOnFinish: true };
const view = (settings: AgentSettings | null, settingsSaving = false) =>
  renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={settings} settingsSaving={settingsSaving} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);

describe("Settings", () => {
  it("has no automatic steps and no Pip turns per day", () => {
    const html = view(SETTINGS);
    expect(html).not.toContain("Automatic steps");
    expect(html).not.toContain("Pip turns per day");
    expect(html).toContain("Limits");
    expect(html).not.toContain("Result tool");
  });
});

describe("the notifications setting in Settings", () => {
  const section = (html: string) => html.slice(html.indexOf("Notifications and environment"));

  it("offers each workstream, digest and off, with each workstream chosen for a backend that sent none", () => {
    const html = section(view(SETTINGS));
    expect(html).toMatch(/aria-label="Notifications"[^>]*>[\s\S]*?Each workstream[\s\S]*?Digest[\s\S]*?Off/);
    expect(html).toMatch(/<option value="workstream" selected="">Each workstream/);
    expect(html).not.toContain("Digest every");
    expect(section(view({ ...SETTINGS, notifications: "off" }))).toMatch(/<option value="off" selected="">Off/);
  });

  it("asks for the digest interval only in digest mode, showing the saved minutes", () => {
    expect(section(view({ ...SETTINGS, notifications: "digest", digestMinutes: 45 }))).toMatch(/aria-label="Digest every this many minutes"[^>]*value="45"/);
    expect(section(view({ ...SETTINGS, notifications: "digest" }))).toMatch(/aria-label="Digest every this many minutes"[^>]*value="30"/);
  });

  it("saves the digest interval as whole minutes between one and a day, and nothing when it says nothing new", () => {
    expect(withDigestMinutes(SETTINGS, "15")).toEqual({ ...SETTINGS, digestMinutes: 15 });
    expect(withDigestMinutes(SETTINGS, "0")?.digestMinutes).toBe(1);
    expect(withDigestMinutes(SETTINGS, "99999")?.digestMinutes).toBe(1_440);
    for (const text of ["30", "", "soon"]) expect(withDigestMinutes(SETTINGS, text)).toBeNull();
  });

  it("round-trips through the sample backend", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const start = await b.runsSettings();
    expect([start.notifications, start.digestMinutes]).toEqual(["workstream", 30]);
    const saved = await b.runsSetSettings({ ...start, notifications: "digest", digestMinutes: 0 });
    expect([saved.notifications, saved.digestMinutes]).toEqual(["digest", 1]);
    expect((await b.runsSettings()).notifications).toBe("digest");
  });
});
