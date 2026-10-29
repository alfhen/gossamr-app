import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { AgentSettings } from "../types";
import { AgentsSettingsView } from "./AgentsSettings";

const SETTINGS: AgentSettings = { maxRuns: 3, terminal: "terminal" };
const view = (settings: AgentSettings | null, settingsSaving = false) =>
  renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={settings} settingsSaving={settingsSaving} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);

describe("Settings", () => {
  it("has no automatic steps and no Pip turns per day", () => {
    const html = view(SETTINGS);
    expect(html).not.toContain("Automatic steps");
    expect(html).not.toContain("Pip turns per day");
    expect(html).toContain("Agents running at once");
    expect(html).not.toContain("Stop a run after");
    expect(html).not.toContain("Limits");
    expect(html).not.toContain("read-only");
    expect(html).not.toContain("Claude Code settings");
    expect(html).not.toContain("Result tool");
  });
});

describe("the notifications setting in Settings", () => {
  it("offers one on or off choice for new needs", () => {
    expect(view(SETTINGS)).toMatch(/aria-label="Notifications"[^>]*checked/);
    expect(view({ ...SETTINGS, notifications: "off" })).not.toMatch(/aria-label="Notifications"[^>]*checked/);
    expect(view(SETTINGS)).not.toContain("Digest");
  });

  it("round-trips through the sample backend", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const start = await b.runsSettings();
    expect(start.notifications).toBe("workstream");
    const saved = await b.runsSetSettings({ ...start, notifications: "off" });
    expect(saved.notifications).toBe("off");
    expect((await b.runsSettings()).notifications).toBe("off");
  });
});
