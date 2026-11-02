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
  const folder = (over: Partial<WorkFolderGit> = {}): WorkFolderGit => ({ globalEmail: "alf@personal.example", owners: [{ owner: "acme", commitEmail: "alf@acme.example" }], includeIf: false, ...over });
  const withGit = (git: WorkFolderGit | null | undefined) =>
    renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={SETTINGS} workFolder={git} cleanup={null} onSettings={vi.fn()} onRevealWorkFolder={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);

  it("says where agents work, who git commits as in each owner's clones, and offers Reveal in Finder", () => {
    const html = withGit(folder());
    expect(html).toContain("Where agents work");
    expect(html).toContain("Agents work in Gossamr&#x27;s own clones in ~/Gossamr/agents, one per repository");
    expect(html).toContain("Your clones in ~/Code and other folders aren&#x27;t used or changed");
    expect(html).toContain("In ~/Gossamr/agents/acme/ git commits as alf@acme.example.");
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Reveal in Finder<\/button>/);
    expect(html).not.toContain("data-include-if");
  });

  it("names the global address as the global one while there is no clone to read it in", () => {
    const html = withGit(folder({ owners: [] }));
    expect(html).toContain("Git commits there as alf@personal.example, your global address.");
    expect(html).not.toContain("In ~/Gossamr/agents/");
  });

  it("warns when the person's git settings choose an address by folder", () => {
    expect(INCLUDE_IF_WARNING).toBe("Your git settings have rules that pick settings by folder. If one of them sets user.email, add a rule for ~/Gossamr/agents/<owner>/ to use that address in Gossamr's clones too.");
    const html = withGit(folder({ includeIf: true }));
    expect(html).toContain("data-include-if");
    expect(html).toContain("add a rule for ~/Gossamr/agents/&lt;owner&gt;/ to use that address in Gossamr&#x27;s clones too.");
    expect(html).not.toMatch(/data-include-if[^>]*text-ws-warn/);
  });

  it("tells an owner without an address from a git that could not be asked, and shows nothing before it answers", () => {
    expect(withGit(folder({ owners: [{ owner: "acme", commitEmail: null }] }))).toContain("In ~/Gossamr/agents/acme/ git has no email address set for commits.");
    expect(withGit(folder({ owners: [], globalEmail: null }))).toContain("Git has no email address set for commits there.");
    const unknown = withGit(null);
    expect(unknown).toContain("Gossamr couldn&#x27;t ask git who commits there.");
    expect(unknown).not.toContain("data-commit-address");
    expect(withGit(undefined)).not.toContain("couldn&#x27;t ask git");
    expect(withGit(undefined)).not.toContain("data-commit-address");
    expect(withGit(undefined)).toContain("Reveal in Finder");
  });

  it("is told about the work folder by the sample backend, apart from the settings, and counts a reveal", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    expect(await b.runsWorkFolderGit()).toEqual({ globalEmail: "alf@acme.example", owners: [{ owner: "acme", commitEmail: "alf@acme.example" }], includeIf: false });
    expect((await new MockBackend({ runs: { seed: "empty", gitRules: true } }).runsWorkFolderGit())?.includeIf).toBe(true);
    expect(Object.keys(await b.runsSettings())).not.toContain("workFolder");
    await b.runsRevealWorkFolder();
    expect(b.runs.workFolderReveals).toBe(1);
  });
});

describe("Commits as on a run", () => {
  const withEmail = (commitEmail?: string | null): Pick<Run, "commitEmail"> => ({ commitEmail });

  it("names the address and who pushes, and says nothing before the address is read", () => {
    expect(commitsAsText(withEmail("alf@acme.example"), "alfhen")).toBe("Commits as alf@acme.example · gh is signed in as alfhen");
    expect(commitsAsText(withEmail("alf@acme.example"), null)).toBe("Commits as alf@acme.example");
    expect(commitsAsText(withEmail(undefined), "alfhen")).toBeNull();
    expect(commitsAsText(withEmail("  "), "alfhen")).toBeNull();
  });

  it("is carried by a run the sample backend has started in the work folder, and not by a queued one or one set up in the person's own clone", () => {
    const runs = new MockBackend({ runs: { seed: "clones" } }).runs.list();
    expect(runs.find((r) => r.inWorkFolder !== false && r.state !== "queued")?.commitEmail).toBe("alf@acme.example");
    expect(runs.filter((r) => r.state === "queued").map((r) => r.commitEmail)).not.toContain("alf@acme.example");
    expect(runs.find((r) => r.inWorkFolder === false)?.commitEmail).toBeUndefined();
  });
});
