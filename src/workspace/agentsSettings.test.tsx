import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { AgentSettings } from "../types";
import { AgentsSettingsView } from "./AgentsSettings";
import { INCLUDE_IF_WARNING } from "./WorkFolderSection";

const SETTINGS: AgentSettings = { maxRuns: 3, terminal: "terminal" };
const view = (settings: AgentSettings | null, settingsSaving = false) =>
  renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={settings} settingsSaving={settingsSaving} cleanup={null} onSettings={vi.fn()} onRevealWorkFolder={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);

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

describe("Where agents work in Settings", () => {
  const settings = (workFolder: AgentSettings["workFolder"]): AgentSettings => ({ ...SETTINGS, workFolder });

  it("says where agents work, who commits there and offers Reveal in Finder", () => {
    const html = view(settings({ commitEmail: "alf@acme.example", includeIf: false }));
    expect(html).toContain("Where agents work");
    expect(html).toContain("Agents work in Gossamr&#x27;s own clones in ~/Gossamr/agents");
    expect(html).toContain("Commits in Gossamr&#x27;s clones are by alf@acme.example.");
    expect(html).toContain("Reveal in Finder");
    expect(html).not.toContain("choose an address by folder");
  });

  it("warns when git settings choose an address by folder", () => {
    const html = view(settings({ commitEmail: "alf@acme.example", includeIf: true }));
    expect(html).toContain(INCLUDE_IF_WARNING.replace(/'/g, "&#x27;").replace("<owner>", "&lt;owner&gt;"));
  });

  it("says so when git has no address, and keeps the section before the settings load", () => {
    expect(view(settings({ commitEmail: null, includeIf: false }))).toContain("Git has no email address set");
    const early = view(null);
    expect(early).toContain("Where agents work");
    expect(early).not.toContain("Commits in Gossamr");
  });

  it("is read from the sample backend, and revealing counts there", async () => {
    const b = new MockBackend({ runs: { seed: "empty", gitRules: true } });
    expect((await b.runsSettings()).workFolder).toEqual({ commitEmail: "alf@acme.example", includeIf: true });
    expect((await b.runsSetSettings({ ...(await b.runsSettings()), maxRuns: 2 })).workFolder?.includeIf).toBe(true);
    await b.runsRevealWorkFolder();
    expect(b.runs.revealedWorkFolder).toBe(1);
  });
});
