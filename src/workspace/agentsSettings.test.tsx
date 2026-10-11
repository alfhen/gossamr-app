import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { ruleText } from "../lib/workstreamHold";
import { AUTOSTART_DEFAULTS, WORKSTREAM_RULES, type AgentSettings } from "../types";
import { AgentsSettingsView, withAutostart, withTurnsPerDay } from "./AgentsSettings";

const SETTINGS: AgentSettings = { maxRuns: 3, wallClockMinutes: 60, tokenCap: 3_000_000, terminal: "terminal", draftOnFinish: true, reportResult: false, autostart: AUTOSTART_DEFAULTS, managerTurnsPerDay: 40 };
const view = (settings: AgentSettings | null, settingsSaving = false) =>
  renderToStaticMarkup(<AgentsSettingsView runs={[]} stopping={false} keepRunning={0} settings={settings} settingsSaving={settingsSaving} cleanup={null} onSettings={vi.fn()} onCleanup={vi.fn()} onStopAll={vi.fn()} onClose={vi.fn()} />);

/** The automatic-steps switches in the markup, in order, with whether each is on. */
const switches = (html: string) => {
  const section = html.slice(html.indexOf("Automatic steps"), html.indexOf("Result tool"));
  return [...section.matchAll(/<span id="[^"]+-label" class="font-semibold">([^<]+)<\/span>[\s\S]*?role="switch" aria-checked="(true|false)"/g)].map(([, label, on]) => [label, on === "true"]);
};

describe("the automatic steps in Settings", () => {
  it("has the six rules, Verify off by default, and Pip turns per day", () => {
    const html = view(SETTINGS);
    expect(switches(html)).toEqual(WORKSTREAM_RULES.map((r) => [ruleText(r).replace("'", "&#x27;"), r !== "review_verify"]));
    expect(html).toContain("A fix round sends the reviewer&#x27;s blocking findings to the build, which can push to its draft PR.");
    expect(html).toMatch(/aria-label="Pip turns per day"[^>]*value="40"/);
    expect(html).toContain("0 means no daily limit");
  });

  it("shows a backend's switches as it sent them, and the defaults for one that sent none", () => {
    expect(switches(view({ ...SETTINGS, autostart: { ...AUTOSTART_DEFAULTS, investigateTriage: false, reviewVerify: true } })).map(([, on]) => on)).toEqual([false, true, true, true, true, true]);
    const old = { ...SETTINGS } as Partial<AgentSettings>;
    delete old.autostart;
    expect(switches(view(old as AgentSettings)).map(([, on]) => on)).toEqual([true, true, true, true, true, false]);
  });

  it("waits while a save is under way, and while the settings load", () => {
    const html = view(SETTINGS, true);
    const section = html.slice(html.indexOf("Automatic steps"), html.indexOf("Result tool"));
    expect(section.match(/role="switch"[^>]*disabled=""/g)).toHaveLength(6);
    expect(section).toMatch(/disabled=""[^>]*aria-label="Pip turns per day"/);
    expect(view(null)).toMatch(/Automatic steps[\s\S]*Loading…/);
  });

  it("saves one switch at a time, keeping the rest", () => {
    expect(withAutostart(SETTINGS, "investigate_triage", false).autostart).toEqual({ ...AUTOSTART_DEFAULTS, investigateTriage: false });
    expect(withAutostart(SETTINGS, "review_verify", true).autostart).toEqual({ ...AUTOSTART_DEFAULTS, reviewVerify: true });
    expect(withAutostart(SETTINGS, "fix_round", false)).toMatchObject({ maxRuns: 3, managerTurnsPerDay: 40, autostart: { fixRound: false, planBuild: true } });
  });

  it("saves Pip turns per day as a whole number, zero for no daily limit, and nothing when it says nothing new", () => {
    expect(withTurnsPerDay(SETTINGS, "12")).toEqual({ ...SETTINGS, managerTurnsPerDay: 12 });
    expect(withTurnsPerDay(SETTINGS, " 0 ")).toEqual({ ...SETTINGS, managerTurnsPerDay: 0 });
    expect(withTurnsPerDay(SETTINGS, "7.6")?.managerTurnsPerDay).toBe(8);
    expect(withTurnsPerDay(SETTINGS, "-3")?.managerTurnsPerDay).toBe(0);
    for (const text of ["40", "", "  ", "lots"]) expect(withTurnsPerDay(SETTINGS, text)).toBeNull();
  });

  it("round-trips through the sample backend's runsSetSettings, clamped as Rust clamps it", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const start = await b.runsSettings();
    expect(start.autostart).toEqual(AUTOSTART_DEFAULTS);
    const saved = await b.runsSetSettings(withAutostart(start, "investigate_triage", false));
    expect(saved.autostart.investigateTriage).toBe(false);
    expect((await b.runsSettings()).autostart.investigateTriage).toBe(false);
    const turns = await b.runsSetSettings(withTurnsPerDay(saved, "9999")!);
    expect(turns.managerTurnsPerDay).toBe(500);
    expect((await b.runsSetSettings(withTurnsPerDay(turns, "0")!)).managerTurnsPerDay).toBe(0);
  });
});
