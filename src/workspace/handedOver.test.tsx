import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { HANDED_OVER_ASK, NOT_HANDED_OVER, RESUMED_HERE } from "../types";
import { HANDED_OVER_TEXT, HandedOverBox } from "./HandedOver";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const seeded = () => new MockBackend({ runs: { seed: "harness", epoch: NOW } });
const byKey = (backend: MockBackend, key: string) => backend.runs.list().find((r) => r.item?.key === key && r.harnessSession)!;
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

describe("a run handed over to Terminal", () => {
  it("says Terminal has it and offers Resume here before Open in Terminal", () => {
    const backend = seeded();
    const html = renderToStaticMarkup(<HandedOverBox run={byKey(backend, "SUP-15")} onAttach={() => {}} />);
    expect(html).toContain(HANDED_OVER_TEXT);
    expect(buttons(html)).toEqual(["Resume here", "Open in Terminal"]);
  });

  it("in the mock, as on the harness: Open in Terminal hands a finished run over, a message waits, the resume command is the provider's own, and Resume here takes it back at rest", async () => {
    const backend = seeded();
    const done = byKey(backend, "DEVOPS-490");
    await expect(backend.runsResumeCommand(done.id)).rejects.toThrow(NOT_HANDED_OVER);
    await backend.runsAttach(done.id);
    expect(backend.runs.get(done.id)!.handedOver).toBe(true);
    expect(() => backend.runs.messageAgent(done.id, "Go on.")).toThrow(HANDED_OVER_ASK);
    const line = await backend.runsResumeCommand(done.id);
    expect(line).toMatch(/^cd '.+' && '.+claude' --resume '.+'$/);
    const back = await backend.runsTakeBack(done.id);
    expect([back.handedOver, back.state, back.lastDetail]).toEqual([false, "done", RESUMED_HERE]);
    await expect(backend.runsTakeBack(done.id)).rejects.toThrow(NOT_HANDED_OVER);
  });

  it("in the mock, Open in Terminal refuses a run waiting on you, as the harness does", async () => {
    const backend = seeded();
    const asking = byKey(backend, "CA-407");
    await expect(backend.runsAttach(asking.id)).rejects.toThrow("It is waiting on you; answer or stop it first.");
    expect(backend.runs.get(asking.id)!.handedOver).toBeFalsy();
  });
});
