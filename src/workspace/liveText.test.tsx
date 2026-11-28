import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { RunEvent } from "../types";
import { NO_FILTERS, streamedLine } from "./agentsLogic";
import { RunTimeline } from "./RunTimeline";
import { useRuns } from "./runsStore";

const s = () => useRuns.getState();
const settle = () => new Promise((r) => setTimeout(r, 0));
let backend: MockBackend;

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

async function working() {
  await settle();
  const id = s().runs.find((r) => r.state === "working")?.id ?? s().runs.find((r) => r.state === "needsPermission")!.id;
  if (backend.runs.get(id)?.state !== "working") backend.runs.advance(id);
  expect(backend.runs.get(id)?.state).toBe("working");
  await settle();
  return id;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useRuns.setState({ dismissed: new Set(), filters: NO_FILTERS, stopping: false });
  backend = new MockBackend();
  s().init(backend);
});

describe("live text on the page", () => {
  it("holds a working run's block as it streams, and once it ended drops it with the next read of the runs", async () => {
    const id = await working();
    backend.runs.stream(id, "Reading the ");
    backend.runs.stream(id, "code");
    expect(s().live[id]).toEqual({ text: "Reading the code", ended: false });
    backend.runs.say(id, "Reading the code.");
    expect(s().live[id]).toEqual({ text: "Reading the code", ended: true });
    await settle();
    expect(s().live[id], "no sheet holds it, so the read of the runs drops it").toBeUndefined();
  });

  it("keeps an ended block for the open sheet until its timeline is read again", async () => {
    const id = await working();
    s().openRun(id);
    backend.runs.stream(id, "Checking");
    backend.runs.say(id, "Checked.");
    await settle();
    expect(s().live[id]).toEqual({ text: "Checking", ended: true });
    s().settleLive(id);
    expect(s().live[id]).toBeUndefined();
  });

  it("settles nothing that still streams, and an end with nothing streamed adds nothing", async () => {
    const id = await working();
    s().hearLive({ runId: "elsewhere", text: "" });
    expect(s().live.elsewhere).toBeUndefined();
    backend.runs.stream(id, "Still writing");
    s().settleLive(id);
    expect(s().live[id]).toEqual({ text: "Still writing", ended: false });
  });

  it("drops a block its turn never finished when the run stops working", async () => {
    const id = await working();
    backend.runs.stream(id, "Writing it up");
    backend.runs.advance(id);
    await settle();
    expect(s().live[id]).toBeUndefined();
  });

  it("a card shows the last line of the block, the one being written", () => {
    expect(streamedLine("First line\n\nNow the second  \n ")).toBe("Now the second");
    expect(streamedLine("  \n")).toBeNull();
  });

  it("the timeline shows the streamed block after its rows in place of the line that says it works", () => {
    const events: RunEvent[] = [{ runId: "r", seq: 1, at: "2026-11-28T10:00:00Z", kind: "update", text: "Read the ticket.", detail: null }];
    const streaming = renderToStaticMarkup(<RunTimeline events={events} live="Read the ticket." streamed={"Now the\ncode"} />);
    expect(streaming).toContain("data-streamed");
    expect(streaming).not.toContain("data-progress");
    expect(streaming.indexOf("Read the ticket.")).toBeLessThan(streaming.indexOf("Now the\ncode"));
    const quiet = renderToStaticMarkup(<RunTimeline events={events} live="Read the ticket." />);
    expect(quiet).toContain("data-progress");
    expect(quiet).not.toContain("data-streamed");
    expect(renderToStaticMarkup(<RunTimeline events={[]} live={null} streamed="Starting" />)).toContain("Starting");
  });
});
