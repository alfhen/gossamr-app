import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { useClaude } from "../claudeStore";
import type { WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { isPipHomeKey } from "./commands";
import { footerHints } from "./footerHints";
import { HomeConversation, PipHome, StepsColumn, WorkstreamList, rowTitle, type WorkstreamListProps } from "./PipHome";
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

  it("offers to start a workstream, opening the palette already asking for one; with none open it says how", async () => {
    const { START_WORKSTREAM } = await import("./PipHome");
    expect(list()).toMatch(/<button type="button"[^>]*>Start a workstream…<\/button>/);
    expect(list()).not.toContain("No workstreams yet");
    expect(list({ list: [] })).toContain("No workstreams yet. Start one on a ticket below, or from its peek.");
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
    const steps = renderToStaticMarkup(<StepsColumn workstream={noted} />);
    expect(steps).toContain("Pip&#x27;s notes");
    expect(steps).toContain("Plan first, then build.");
    expect(steps).toContain("Manage this workstream");
    expect(steps.indexOf("Plan first, then build.")).toBeLessThan(steps.indexOf("Manage this workstream"));
    for (const step of ["investigate", "triage", "plan", "build", "review", "verify"]) expect(steps).toContain(`data-step="${step}"`);
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
