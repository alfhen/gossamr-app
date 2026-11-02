import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { AgentSettings, Run, WorkFolderGit } from "../types";
import { commitsAsText } from "./CommitsAs";
import { AgentsSettingsView, INCLUDE_IF_WARNING } from "./AgentsSettings";

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
  const git = (over: Partial<WorkFolderGit> = {}): AgentSettings => ({ ...SETTINGS, workFolder: { commitEmail: "alf@acme.example", includeIf: false, ...over } });

  it("says where agents work, who git commits as there, and offers Reveal in Finder", () => {
    const html = view(git());
    expect(html).toContain("Where agents work");
    expect(html).toContain("Agents work in Gossamr&#x27;s own clones in ~/Gossamr/agents, one per repository");
    expect(html).toContain("Your clones in ~/Code and other folders aren&#x27;t used or changed");
    expect(html).toContain("Git commits there as alf@acme.example.");
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Reveal in Finder<\/button>/);
    expect(html).not.toContain("data-include-if");
  });

  it("warns when the person's git settings choose an address by folder", () => {
    expect(INCLUDE_IF_WARNING).toBe("Your git settings choose an address by folder. Add a rule for ~/Gossamr/agents/<owner>/ to use it in Gossamr's clones too.");
    const html = view(git({ includeIf: true }));
    expect(html).toContain("data-include-if");
    expect(html).toContain("Add a rule for ~/Gossamr/agents/&lt;owner&gt;/ to use it in Gossamr&#x27;s clones too.");
  });

  it("says so when git has no address, and shows no address line before the backend has answered", () => {
    expect(view(git({ commitEmail: null }))).toContain("Git has no email address set for commits there.");
    expect(view(SETTINGS)).not.toContain("data-commit-address");
    expect(view(SETTINGS)).toContain("Reveal in Finder");
  });

  it("is told about the work folder by the sample backend and counts a reveal", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    expect((await b.runsSettings()).workFolder).toEqual({ commitEmail: "alf@acme.example", includeIf: false });
    expect((await new MockBackend({ runs: { seed: "empty", gitRules: true } }).runsSettings()).workFolder?.includeIf).toBe(true);
    const saved = await b.runsSetSettings({ ...(await b.runsSettings()), maxRuns: 2 });
    expect([saved.maxRuns, saved.workFolder?.commitEmail]).toEqual([2, "alf@acme.example"]);
    await b.runsRevealWorkFolder();
    expect(b.runs.workFolderReveals).toBe(1);
  });
});

describe("Commits as on a run", () => {
  const withEmail = (commitEmail?: string | null): Pick<Run, "commitEmail"> => ({ commitEmail });

  it("names the address and who pushes, and says nothing before the address is read", () => {
    expect(commitsAsText(withEmail("alf@acme.example"), "alfhen")).toBe("Commits as alf@acme.example · pushes as alfhen");
    expect(commitsAsText(withEmail("alf@acme.example"), null)).toBe("Commits as alf@acme.example");
    expect(commitsAsText(withEmail(undefined), "alfhen")).toBeNull();
    expect(commitsAsText(withEmail("  "), "alfhen")).toBeNull();
  });

  it("is carried by runs the sample backend starts in the work folder, and not by one set up in the person's own clone", () => {
    const runs = new MockBackend({ runs: { seed: "clones" } }).runs.list();
    expect(runs.find((r) => r.inWorkFolder !== false)?.commitEmail).toBe("alf@acme.example");
    expect(runs.find((r) => r.inWorkFolder === false)?.commitEmail).toBeUndefined();
  });
});
