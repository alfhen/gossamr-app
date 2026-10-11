import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useClaude } from "../claudeStore";
import type { WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { isPipHomeKey } from "./commands";
import { footerHints, pipHomeHints } from "./footerHints";
import { pipHomeKey, wrapTab, type PipHomeKeyEvent, type PipHomeKeyState } from "./pipHomeKeys";
import { ShortcutHint } from "./ShortcutHint";
import { HomeConversation, NO_WORKSTREAMS, PipHome, StepsColumn, WorkstreamList, rowTitle, type WorkstreamListProps } from "./PipHome";
import { usePipHome } from "./pipHomeStore";
import { loadPrefs, usePrefs } from "./prefs";
import { loadTabs, useTabs } from "./tabsStore";
import { mainScreen, showsPipPane } from "./Workspace";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

let backend: MockBackend;
let open: WorkstreamView[];
let closed: WorkstreamView[];

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  backend = new MockBackend({ runs: { seed: "empty" } });
  await useWorkspace.getState().init(backend);
  const first = await backend.workstreamsOpen(itemRef("CA-401"));
  await backend.workstreamsOpen(itemRef("CA-402"));
  const gone = await backend.workstreamsOpen(itemRef("CA-403"));
  await backend.workstreamsClose(gone.id);
  open = await backend.workstreamsList();
  closed = (await backend.workstreamsList(true)).filter((v) => v.workstream.closedAt !== null);
  expect(open.map((v) => v.workstream.id)).toContain(first.id);
});

afterEach(() => {
  useWorkstreams.getState().dispose();
  usePipHome.getState().reset();
  useTabs.getState().setRoute("workspace");
  useClaude.setState({ byTicket: {} });
  vi.unstubAllGlobals();
});

const list = (over: Partial<WorkstreamListProps> = {}) =>
  renderToStaticMarkup(<WorkstreamList list={open} closed={closed} showClosed={false} selected={null} onSelect={vi.fn()} onShowClosed={vi.fn()} {...over} />);

const options = (html: string) => [...html.matchAll(/data-workstream-row="([^"]+)" role="option"/g)].map((m) => m[1]);

describe("the workstream list on Pip home", () => {
  it("pins General first, then a row per open workstream with its key, title and stage", () => {
    const html = list();
    expect(html).toContain('<nav aria-label="Workstreams"');
    expect(options(html)).toEqual(["general", ...open.map((v) => v.workstream.id)]);
    expect(html).toMatch(/data-workstream-row="general"[^>]*>.*General/);
    for (const v of open) {
      expect(html).toContain(`>${v.workstream.itemKey}</b>`);
      expect(html).toContain(`>${rowTitle(v.workstream)}</span>`);
    }
    expect(html.match(/data-stage[^>]*>Intake</g)).toHaveLength(open.length);
    expect(html).not.toContain("CA-403");
  });

  it("marks the selection: General when nothing is selected, the workstream once one is", () => {
    expect(list()).toContain('data-workstream-row="general" role="option" aria-selected="true" tabindex="0"');
    const id = open[1].workstream.id;
    const html = list({ selected: id });
    expect(html).toContain(`data-workstream-row="${id}" role="option" aria-selected="true" tabindex="0"`);
    expect(html).toContain('data-workstream-row="general" role="option" aria-selected="false" tabindex="-1"');
  });

  it("lists the closed workstreams behind the toggle, read-only", () => {
    expect(list()).not.toContain("Closed workstreams");
    expect(list()).toMatch(/aria-pressed="false"[^>]*>Show closed/);
    const html = list({ showClosed: true });
    expect(html).toMatch(/aria-pressed="true"[^>]*>Hide closed/);
    const shown = html.slice(html.indexOf('aria-label="Closed workstreams"'));
    expect(shown).toContain("CA-403");
    expect(shown).not.toContain('role="option"');
    expect(list({ showClosed: true, closed: [] })).toContain("No closed workstreams.");
  });

  it("offers to start a workstream, opening the palette already asking for one; with none open it says what one is", async () => {
    const { START_WORKSTREAM } = await import("./commands");
    expect(list()).toMatch(/<button type="button"[^>]*>Start a workstream…<\/button>/);
    expect(list()).not.toContain("No workstreams yet");
    expect(list({ list: [] })).toContain("No workstreams yet. A workstream follows one ticket from investigation to a reviewed pull request, with Pip keeping track.");
    expect(NO_WORKSTREAMS.match(/[.!?](\s|$)/g)).toHaveLength(2);
    usePrefs.getState().setPaletteOpen(true, START_WORKSTREAM);
    expect(usePrefs.getState()).toMatchObject({ paletteOpen: true, paletteSeed: "start a workstream on " });
    // Closed, and opened again with ⌘K, the palette starts empty.
    usePrefs.getState().setPaletteOpen(false);
    usePrefs.getState().setPaletteOpen(true);
    expect(usePrefs.getState().paletteSeed).toBe("");
    usePrefs.getState().setPaletteOpen(false);
  });

  it("drops the ticket's key from the title it starts", () => {
    expect(rowTitle({ ...open[0].workstream, itemKey: "CA-401", title: "CA-401 Retry the export" })).toBe("Retry the export");
    expect(rowTitle({ ...open[0].workstream, itemKey: null, title: "Tidy the docs" })).toBe("Tidy the docs");
  });
});

describe("Pip home", () => {
  it("opens on General: the list, the conversation in a Pip root with the one composer, and the steps", () => {
    const html = renderToStaticMarkup(<PipHome />);
    expect(html.indexOf('aria-label="Workstreams"')).toBeLessThan(html.indexOf('aria-label="Conversation"'));
    expect(html.indexOf('aria-label="Conversation"')).toBeLessThan(html.indexOf('aria-label="Steps"'));
    expect(html).toMatch(/<section aria-label="Conversation" data-pip-root=/);
    expect(html).toContain('data-pip-conversation="general"');
    expect(html.match(/id="pip-input"/g)).toHaveLength(1);
    expect(html).toContain("Show stale tickets");
    expect(html).toContain("Pick a workstream to see its steps.");
    expect(html).not.toContain("Manage this workstream");
    // The steps drop below the conversation on a narrow window, across both columns.
    expect(html).toMatch(/aria-label="Steps" class="col-span-2 [^"]*min-\[1100px\]:col-span-1/);
  });

  it("with no workstream, has nothing to Tab to after the composer, so Tab from its last control wraps round to the page's first", () => {
    const html = renderToStaticMarkup(<PipHome />);
    const steps = html.slice(html.indexOf('aria-label="Steps"'));
    // The Steps column of General is a word, not a stop: focusable only from code, with no control in it.
    expect(html).toMatch(/<aside aria-label="Steps" class="[^"]*" tabindex="-1">/);
    expect(steps.slice(0, steps.indexOf("</aside>"))).not.toMatch(/<(button|input|a |select|textarea)/);
    const stops = ["rail", "general", "pip-input", "commands"];
    expect(wrapTab({ key: "Tab", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, stops, "commands", true)).toBe("rail");
  });

  it("shows a workstream's own conversation, and beside it Pip's notes, its controls and its steps", async () => {
    const view = open.find((v) => v.workstream.itemKey === "CA-401")!;
    await backend.workstreamsSetNotes(view.workstream.id, "Plan first, then build.");
    const noted = (await backend.workstreamsList()).find((v) => v.workstream.id === view.workstream.id)!;
    const html = renderToStaticMarkup(<HomeConversation workstream={noted} />);
    expect(html).toMatch(/<section aria-label="Conversation" data-pip-root=/);
    expect(html).toContain(`data-pip-conversation="ws:${view.workstream.id}"`);
    expect(html).toMatch(/Workstream: CA-401 .*· Intake/);
    // The controls are the step rail's on Pip home, so there is one Manage switch on screen.
    expect(html).not.toContain("Manage this workstream");
    expect(html).toContain("data-empty-workstream");
    // Its first suggestion is the intro's one button, not a chip as well.
    expect(html).toMatch(/data-intro-action="true"[^>]*>Investigate CA-401<\/button>/);
    expect(html.match(/>Investigate CA-401</g)).toHaveLength(1);
    expect(html).not.toContain("/stop R1");
    const steps = renderToStaticMarkup(<StepsColumn workstream={noted} />);
    expect(steps).toContain("Pip&#x27;s notes");
    expect(steps).toContain("Plan first, then build.");
    expect(steps).toContain("Manage this workstream");
    expect(steps.indexOf("Plan first, then build.")).toBeLessThan(steps.indexOf("Manage this workstream"));
    for (const step of ["investigate", "triage", "plan", "build", "review", "verify"]) expect(steps).toContain(`data-step="${step}"`);
    expect(steps).toContain('data-step-next="investigate"');
    expect(steps.match(/data-step-quiet="true"/g)).toHaveLength(5);
    expect(renderToStaticMarkup(<StepsColumn workstream={view} />)).toContain("No notes yet.");
  });
});

describe("with Agents off", () => {
  it("never shows Pip home, and the pane is where the person left it", () => {
    expect(mainScreen("pip", false)).toBeNull();
    expect(mainScreen("agents", false)).toBeNull();
    expect(mainScreen("pip", true)).toBe("pip");
    for (const route of ["workspace", "activity", "settings"] as const) {
      expect(mainScreen(route, false)).toBe(route);
      expect(showsPipPane(route, false, true)).toBe(true);
    }
    expect(showsPipPane("pip", false, true)).toBe(true);
    // On Pip home its own conversation takes the pane's place, so there is one composer.
    expect(showsPipPane("pip", true, true)).toBe(false);
    expect(showsPipPane("workspace", true, false)).toBe(false);
  });

  it("has no ⌘0 hint in the footer, which has one while Agents are on", () => {
    for (const view of ["list", "board", "map", "age"] as const) expect(footerHints(view).some((h) => h.id === "pip-home")).toBe(false);
    expect(footerHints("list", true).find((h) => h.id === "pip-home")?.keys).toEqual(["⌘0"]);
  });

  it("takes ⌘0 only with Cmd or Ctrl alone, so the map keeps a plain 0", () => {
    const key = (over: Partial<KeyboardEvent>) => ({ key: "0", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });
    expect(isPipHomeKey(key({ metaKey: true }))).toBe(true);
    expect(isPipHomeKey(key({ ctrlKey: true }))).toBe(true);
    expect(isPipHomeKey(key({}))).toBe(false);
    expect(isPipHomeKey(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPipHomeKey(key({ metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("Start on Pip home", () => {
  it("is on until the person turns it off, and the choice is kept", () => {
    expect(loadPrefs().startOnPipHome).toBe(true);
    usePrefs.setState(loadPrefs());
    expect(usePrefs.getState().startOnPipHome).toBe(true);
    usePrefs.getState().setStartOnPipHome(false);
    expect(loadPrefs().startOnPipHome).toBe(false);
    usePrefs.getState().setStartOnPipHome(true);
    expect(loadPrefs().startOnPipHome).toBe(true);
  });

  it("is on for a person whose saved settings predate it", () => {
    localStorage.setItem("gossamr-prefs", JSON.stringify({ ui: "workspace", theme: "dark" }));
    expect(loadPrefs()).toMatchObject({ startOnPipHome: true, theme: "dark" });
  });
});

describe("Pip home's keys with no workstream, and its footer", () => {
  const key = (k: string, over: Partial<PipHomeKeyEvent> = {}): PipHomeKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over });
  const at = (over: Partial<PipHomeKeyState> = {}): PipHomeKeyState => ({ column: "list", overlay: false, count: 4, at: 1, kind: "row", ...over });

  it("passes the Steps column by while no workstream gives it steps, both ways and with ⌘] and ⌘[", () => {
    const none = (column: PipHomeKeyState["column"]) => at({ column, steps: false });
    expect(pipHomeKey(key("F6"), none("conversation"))).toEqual({ type: "column", to: "list" });
    expect(pipHomeKey(key("F6"), none("list"))).toEqual({ type: "column", to: "conversation" });
    expect(pipHomeKey(key("F6", { shiftKey: true }), none("list"))).toEqual({ type: "column", to: "conversation" });
    expect(pipHomeKey(key("]", { metaKey: true }), none("conversation"))).toEqual({ type: "column", to: "list" });
    expect(pipHomeKey(key("[", { ctrlKey: true }), none("list"))).toEqual({ type: "column", to: "conversation" });
    // Left in the Steps column somehow, the keys still leave it.
    expect(pipHomeKey(key("F6"), none("rail"))).toEqual({ type: "column", to: "list" });
    expect(pipHomeKey(key("F6", { shiftKey: true }), none("rail"))).toEqual({ type: "column", to: "conversation" });
    // With steps, the rail is a stop again.
    expect(pipHomeKey(key("F6"), at({ column: "conversation", steps: true }))).toEqual({ type: "column", to: "rail" });
  });

  it("takes Tab from the last stop on Pip home round to the first stop on the page, and leaves every other Tab to the browser", () => {
    const stops = ["rail-search", "general", "composer", "commands"];
    expect(wrapTab(key("Tab"), stops, "commands", true)).toBe("rail-search");
    expect(wrapTab(key("Tab"), stops, "composer", true)).toBeNull();
    expect(wrapTab(key("Tab", { shiftKey: true }), stops, "commands", true)).toBeNull();
    expect(wrapTab(key("Tab", { ctrlKey: true }), stops, "commands", true)).toBeNull();
    // Off Pip home, as in a sheet after it in the page, or with nothing focused.
    expect(wrapTab(key("Tab"), stops, "commands", false)).toBeNull();
    expect(wrapTab(key("Tab"), stops, null, true)).toBeNull();
    expect(wrapTab(key("F6"), stops, "commands", true)).toBeNull();
  });

  it("says a opens a run draft rather than approving it, as its card does", () => {
    const decide = pipHomeHints().find((h) => h.id === "decide")!;
    expect(decide.keys).toEqual(["a", "s"]);
    expect(decide.text).toBe("approve or skip a draft · a opens a run draft");
    expect(renderToStaticMarkup(<ShortcutHint view="list" hints={pipHomeHints()} />)).toContain("a opens a run draft");
  });
});
