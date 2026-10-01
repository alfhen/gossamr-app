import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { AgentsSwitch, switchView } from "./AgentsSwitch";
import { useAgentsFlag } from "./agentsFlag";
import { Rail } from "./Rail";

const initial = useAgentsFlag.getInitialState();

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useAgentsFlag.setState({ ...initial, enabled: true, pending: null, error: null, note: null, backend: null });
});

const view = (over: Partial<Parameters<typeof switchView>[0]> = {}) => switchView({ enabled: false, pending: null, error: null, ...over });

describe("the Agents switch", () => {
  it("is unchecked and quiet when off", () => {
    expect(view()).toEqual({ checked: false, busy: false, status: null, failed: false });
    const html = renderToStaticMarkup(<AgentsSwitch enabled={false} pending={null} error={null} note={null} onChange={vi.fn()} />);
    expect(html).not.toContain("checked");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain('role="alert"');
  });

  it("is checked when the backend says on", () => {
    expect(view({ enabled: true })).toMatchObject({ checked: true, busy: false, status: null });
    expect(renderToStaticMarkup(<AgentsSwitch enabled pending={null} error={null} note={null} onChange={vi.fn()} />)).toContain("checked");
  });

  it("shows what is being asked for, and locks, while the backend works", () => {
    expect(view({ pending: true })).toMatchObject({ checked: true, busy: true, status: "Turning on. Reading your shell environment…" });
    expect(view({ enabled: true, pending: false })).toMatchObject({ checked: false, busy: true, status: "Turning off…" });
    const html = renderToStaticMarkup(<AgentsSwitch enabled={false} pending error={null} note={null} onChange={vi.fn()} />);
    expect(html).toContain("disabled");
    expect(html).toContain("Reading your shell environment");
  });

  it("shows a failure inline with the reason and stays off", () => {
    expect(view({ error: "the shell printed nothing" })).toMatchObject({ checked: false, failed: true, status: "Couldn't turn Agents on: the shell printed nothing" });
    const html = renderToStaticMarkup(<AgentsSwitch enabled={false} pending={null} error="the shell printed nothing" note={null} onChange={vi.fn()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("the shell printed nothing");
    expect(html).not.toContain("checked");
  });

  it("says what turning off left alone", () => {
    const html = renderToStaticMarkup(<AgentsSwitch enabled={false} pending={null} error={null} note="1 agent is still running and was not stopped." onChange={vi.fn()} />);
    expect(html).toContain("1 agent is still running and was not stopped.");
  });
});

describe("the flag store", () => {
  it("takes the backend's answer, which the mock owns and defaults to on", async () => {
    const backend = new MockBackend();
    useAgentsFlag.setState({ enabled: false });
    useAgentsFlag.getState().init(backend);
    await vi.waitFor(() => expect(useAgentsFlag.getState().enabled).toBe(true));
  });

  it("turns off through the backend and reports the agents it left running", async () => {
    const backend = new MockBackend();
    useAgentsFlag.getState().init(backend);
    await useAgentsFlag.getState().set(false);
    const s = useAgentsFlag.getState();
    expect(s.enabled).toBe(false);
    expect(await backend.runsEnabled()).toBe(false);
    expect(s.pending).toBeNull();
    expect(s.note).toMatch(/agents are still running and were not stopped/);
  });

  it("keeps it off and keeps the reason when the backend refuses", async () => {
    const backend = new MockBackend();
    useAgentsFlag.getState().init(backend);
    await useAgentsFlag.getState().set(false);
    backend.enableFailure = "the shell printed nothing";
    await useAgentsFlag.getState().set(true);
    const s = useAgentsFlag.getState();
    expect([s.enabled, s.pending, s.error]).toEqual([false, null, "the shell printed nothing"]);
    expect(await backend.runsEnabled()).toBe(false);
    backend.enableFailure = null;
    await useAgentsFlag.getState().set(true);
    expect([useAgentsFlag.getState().enabled, useAgentsFlag.getState().error]).toEqual([true, null]);
  });

  it("ignores a second request while one is under way", async () => {
    const backend = new MockBackend();
    const set = vi.spyOn(backend, "runsSetEnabled");
    useAgentsFlag.getState().init(backend);
    const first = useAgentsFlag.getState().set(false);
    await useAgentsFlag.getState().set(true);
    await first;
    expect(set).toHaveBeenCalledTimes(1);
  });
});

describe("gating on the backend's flag", () => {
  const agentsButton = (html: string) => /<button[^>]*aria-label="Agents[^"]*"/.test(html);

  it("shows the rail entry only when the flag is on", () => {
    initial.enabled = true;
    expect(agentsButton(renderToStaticMarkup(<Rail />))).toBe(true);
    initial.enabled = false;
    expect(agentsButton(renderToStaticMarkup(<Rail />))).toBe(false);
    initial.enabled = true;
  });
});
