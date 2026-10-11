import { describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunKind, RunState } from "../types";
import { COMPOSER_VERBS, VERB_HINT, parseVerb, resolveRun, runComposerVerb, runRef } from "./composerVerbs";

const base = new MockBackend().runs.list()[0];
const run = (id: string, state: RunState, workstream: string | null, queuedAt: string, kind: RunKind = "investigate", shortId: string | null = null): Run => ({ ...base, id, state, shortId, queuedAt, spec: { ...base.spec, kind, workstream } });

const runs = [
  run("aaaa1111-run", "done", "ws-1", "2026-09-30T10:00:00Z", "investigate", "s-aaaa"),
  run("bbbb2222-run", "working", "ws-1", "2026-09-30T11:00:00Z", "plan", "s-bbbb"),
  run("cccc3333-run", "working", "ws-2", "2026-09-30T09:00:00Z"),
  run("cccc4444-run", "needsAnswer", null, "2026-09-30T08:00:00Z"),
];

const backend = () => ({ runsStop: vi.fn(async (id: string) => ({ ...base, id })), runsRetryLaunch: vi.fn(async (id: string) => ({ ...base, id })), runsAnswer: vi.fn(async (id: string) => ({ ...base, id })) });

describe("parsing", () => {
  it("knows the three verbs, with the run and, for answer, the text", () => {
    expect(COMPOSER_VERBS).toEqual(["stop", "retry", "answer"]);
    expect(parseVerb("/stop R1")).toEqual({ type: "verb", verb: "stop", ref: "R1", text: "" });
    expect(parseVerb("  /retry r2 ")).toEqual({ type: "verb", verb: "retry", ref: "r2", text: "" });
    expect(parseVerb("/answer R1 use the staging\n  database")).toEqual({ type: "verb", verb: "answer", ref: "R1", text: "use the staging\n  database" });
    expect(parseVerb("/STOP R1")).toMatchObject({ type: "verb", verb: "stop" });
  });

  it("asks for the run, and for what to answer", () => {
    expect(parseVerb("/stop")).toEqual({ type: "problem", message: "Say which run to stop, such as /stop R1" });
    expect(parseVerb("/answer R1")).toMatchObject({ type: "problem", message: expect.stringMatching(/^Say what to answer/) });
    expect(parseVerb("/answer R1   ")).toMatchObject({ type: "problem", message: expect.stringMatching(/^Say what to answer/) });
    expect(parseVerb("/stop R1 now please")).toEqual({ type: "problem", message: "/stop takes only the run, such as /stop R1" });
  });

  it("answers an unknown /word with the list of verbs", () => {
    const got = parseVerb("/nudge R1");
    expect(got).toEqual({ type: "problem", message: `/nudge isn't a command. ${VERB_HINT}` });
    for (const verb of COMPOSER_VERBS) expect(VERB_HINT).toContain(`/${verb}`);
  });

  it("lets everything else through to Pip", () => {
    for (const text of ["stop R1", "please /stop R1", "investigate this", "/path/to/file is broken", "/", "// a comment", ""]) expect(parseVerb(text)).toBeNull();
  });
});

describe("which run", () => {
  it("resolves R<n> within the conversation's workstream, numbered by queue time", () => {
    expect(resolveRun("R1", runs, "ws-1")).toMatchObject({ run: { id: "aaaa1111-run" }, label: "R1" });
    expect(resolveRun("r2", runs, "ws-1")).toMatchObject({ run: { id: "bbbb2222-run" }, label: "R2" });
    expect(resolveRun("R1", runs, "ws-2")).toMatchObject({ run: { id: "cccc3333-run" }, label: "R1" });
  });

  it("says when the workstream has no such run, and that R<n> needs a workstream", () => {
    expect(resolveRun("R9", runs, "ws-1")).toEqual({ error: "No run R9 in this workstream" });
    // R1 is the first run of both ws-1 and ws-2: no one id to point at.
    expect(resolveRun("R1", runs, null)).toEqual({ error: "R1 names a run in a workstream; here, use the id shown on the run's card" });
  });

  it("in General, points R<n> at the id the run's card shows when only one run has that name, and that id works", () => {
    expect(resolveRun("R2", runs, null)).toEqual({ error: "R2 is a workstream's name for a run; here, use its id bbbb2222-run" });
    expect(runRef(runs[1])).toBe("bbbb2222-run");
    expect(resolveRun(runRef(runs[1]), runs, null)).toMatchObject({ run: { id: "bbbb2222-run" } });
    expect(runRef({ id: "run-seed-12" })).toBe("run-seed-12");
    expect(runRef({ id: "0123456789abcdef01234567" })).toBe("01234567");
  });

  it("resolves a short id, an id or an id prefix of four or more, in General too", () => {
    expect(resolveRun("s-bbbb", runs, null)).toMatchObject({ run: { id: "bbbb2222-run" }, label: "run bbbb2222-run" });
    expect(resolveRun("cccc4444-run", runs, null)).toMatchObject({ run: { id: "cccc4444-run" } });
    expect(resolveRun("aaaa", runs, null)).toMatchObject({ run: { id: "aaaa1111-run" } });
    // In its own workstream, a run named by id still reads by its short name.
    expect(resolveRun("aaaa", runs, "ws-1")).toMatchObject({ run: { id: "aaaa1111-run" }, label: "R1" });
  });

  it("refuses a prefix that is too short, ambiguous or unknown", () => {
    expect(resolveRun("aaa", runs, null)).toMatchObject({ error: expect.stringMatching(/at least 4 characters/) });
    expect(resolveRun("cccc", runs, null)).toEqual({ error: "cccc matches more than one run; give more of its id" });
    expect(resolveRun("zzzz", runs, null)).toEqual({ error: "No run zzzz" });
  });
});

describe("carrying it out", () => {
  it("stops, retries or answers the run through the user-only commands, and says so", async () => {
    const b = backend();
    expect(await runComposerVerb("/stop R2", { runs, workstream: "ws-1", backend: b })).toEqual({ ok: true, message: "Stopped R2" });
    expect(b.runsStop).toHaveBeenCalledWith("bbbb2222-run");
    expect(await runComposerVerb("/retry R1", { runs, workstream: "ws-1", backend: b })).toEqual({ ok: true, message: "Retrying R1" });
    expect(b.runsRetryLaunch).toHaveBeenCalledWith("aaaa1111-run");
    expect(await runComposerVerb("/answer cccc4444 use staging", { runs, workstream: null, backend: b })).toEqual({ ok: true, message: "Answered run cccc4444-run" });
    expect(b.runsAnswer).toHaveBeenCalledWith("cccc4444-run", "use staging");
  });

  it("calls nothing for a problem, an unknown run or an unknown verb", async () => {
    const b = backend();
    expect(await runComposerVerb("/stop R9", { runs, workstream: "ws-1", backend: b })).toEqual({ ok: false, message: "No run R9 in this workstream" });
    expect(await runComposerVerb("/answer R1", { runs, workstream: "ws-1", backend: b })).toMatchObject({ ok: false });
    expect(await runComposerVerb("/wave R1", { runs, workstream: "ws-1", backend: b })).toMatchObject({ ok: false, message: expect.stringContaining("isn't a command") });
    expect(b.runsStop).not.toHaveBeenCalled();
    expect(b.runsRetryLaunch).not.toHaveBeenCalled();
    expect(b.runsAnswer).not.toHaveBeenCalled();
  });

  it("passes a question through untouched", () => {
    expect(runComposerVerb("investigate this", { runs, workstream: "ws-1", backend: backend() })).toBeNull();
  });

  it("reports the backend's refusal, thrown or rejected", async () => {
    const b = { ...backend(), runsStop: vi.fn(() => Promise.reject(new Error("it can be stopped once it is working"))) };
    expect(await runComposerVerb("/stop R1", { runs, workstream: "ws-1", backend: b })).toEqual({ ok: false, message: "Couldn't stop R1. it can be stopped once it is working" });
    const sync = {
      ...backend(),
      runsStop: vi.fn(() => {
        throw new Error("gone");
      }),
    };
    expect(await runComposerVerb("/stop R1", { runs, workstream: "ws-1", backend: sync })).toEqual({ ok: false, message: "Couldn't stop R1. gone" });
  });

  it("tells a finished run's refusal in the backend's own words", async () => {
    const mock = new MockBackend();
    const done = mock.runs.list().find((r) => r.state === "done")!;
    const ref = runRef(done);
    expect(await runComposerVerb(`/stop ${ref}`, { runs: mock.runs.list(), workstream: null, backend: mock })).toEqual({ ok: false, message: `Couldn't stop run ${ref}. This run is done, so there is nothing to stop.` });
    expect(await runComposerVerb(`/retry ${ref}`, { runs: mock.runs.list(), workstream: null, backend: mock })).toEqual({ ok: false, message: `Couldn't retry run ${ref}. This run is done and has nothing to retry.` });
  });

  it("works against the sample backend, which records the stop", async () => {
    const mock = new MockBackend();
    const working = mock.runs.list().find((r) => r.state === "working")!;
    const out = await runComposerVerb(`/stop ${working.id}`, { runs: mock.runs.list(), workstream: null, backend: mock });
    expect(out?.ok).toBe(true);
    expect(mock.runs.get(working.id)?.state).toBe("stopped");
  });
});
