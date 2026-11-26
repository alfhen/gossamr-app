import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { HANDED_OVER_ASK, HANDED_OVER_CLEANUP, type Run } from "../types";
import { failureHelp } from "./failureHelp";
import { cleanable, cleanupReason, removerOf } from "./cleanupLogic";
import { RunCleanupView } from "./RunCleanup";
import { RunAnswer, forgetKeptAnswers } from "./RunAnswer";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { rowText } from "./AgentParts";
import { stoppedText } from "./agentsLogic";
import { answerSentText } from "./runSheetLogic";
import { NO_FILTERS } from "./agentsLogic";
import { needs } from "../lib/needs";
import { useRuns } from "./runsStore";
import { useToasts } from "./toasts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const harness = () => new MockBackend({ runs: { seed: "harness", epoch: NOW } });
const byKey = (backend: MockBackend, key: string) => backend.runs.list().find((r) => r.item?.key === key)!;
const settle = () => new Promise((r) => setTimeout(r, 0));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), askPip: vi.fn(), openChange: vi.fn() });
const sheet = (run: Run) => renderToStaticMarkup(<RunSheetView run={run} now={NOW} ticketTitle={null} place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} />);
const answerBox = (run: Run, answer = vi.fn()) => renderToStaticMarkup(<RunAnswer run={run} answering={false} on={{ answer, attach: vi.fn() }} />);

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useRuns.setState({ dismissed: new Set(), filters: NO_FILTERS, handedOverAsked: new Set() });
  useToasts.getState().clear();
  forgetKeptAnswers();
});

describe("a run whose commit the signing app refused", () => {
  it("says so, keeps no Retry, and offers asking Pip to start it again, though it had a session", () => {
    const run = byKey(harness(), "CA-405");
    const help = failureHelp(run)!;
    expect(run.harnessSession).toBeTruthy();
    expect(help).toMatchObject({ kind: "signingNeedsYou", retry: false, primary: { act: "pip", label: "Ask Pip to start it again" } });
    expect(help.summary).toBe("Git couldn't sign a commit, so the agent stopped.");
    expect(rowText(run, NOW)).toBe(help.summary);
  });

  it("shows the sheet's title as a run that stopped, with Ask Pip and no Retry", () => {
    const html = sheet(byKey(harness(), "CA-405"));
    expect(html).toContain("The run stopped without finishing");
    expect(html).toContain("Unlock it or check its settings");
    expect(buttons(html)).toContain("Ask Pip to start it again");
    expect(buttons(html)).not.toContain("Retry");
  });
});

describe("an agent the move to the harness interrupted", () => {
  it("offers Clean up first and asking Pip second, and only Pip once its worktree is gone", () => {
    const run = byKey(harness(), "WEB-106");
    expect(failureHelp(run)).toMatchObject({ kind: "interrupted", retry: false, primary: { act: "cleanup", label: "Clean up" }, secondary: { act: "pip" } });
    const removed = failureHelp({ ...run, worktreeRemovedAt: new Date(NOW).toISOString() })!;
    expect(removed.primary).toMatchObject({ act: "pip" });
    expect(removed.secondary).toBeUndefined();
    expect(removed.detail).toContain("Its worktree was removed");
  });

  it("wins over the help for a run set up outside the work folder, since Clean up is what it needs", () => {
    expect(failureHelp({ ...byKey(harness(), "WEB-106"), inWorkFolder: false })?.kind).toBe("interrupted");
  });

  it("is removed with git, and its sheet doesn't offer a second Clean up below the failure", () => {
    const run = byKey(harness(), "WEB-106");
    expect(removerOf(run, [], true).remover).toBe("git");
    expect(cleanupReason({ ...run, endedAt: new Date(NOW - 30 * 86_400_000).toISOString() }, NOW, { disk: null, change: null })).toBeNull();
    expect(buttons(sheet(run)).filter((b) => b === "Clean up")).toHaveLength(1);
  });

  it("refuses Clean up in the mock while it has unpushed work, in the words it gives", () => {
    const backend = harness();
    const run = byKey(backend, "WEB-106");
    backend.runs.unpushed.add(run.id);
    expect(backend.runs.cleanup(run.id)).toMatchObject({ type: "refused", message: expect.stringContaining("unpushed commits") });
  });
});

describe("a run on the harness that failed for another reason", () => {
  const signedOut = () => ({ ...byKey(harness(), "CA-407"), state: "failed" as const, asking: false, needs: null, error: "Claude isn't signed in", failure: { type: "notSignedIn" as const } });

  it("offers signing in and then Pip, never Retry, which would open a second session", () => {
    const help = failureHelp(signedOut())!;
    expect(help).toMatchObject({ kind: "notSignedIn", retry: false, primary: { act: "terminal", label: "Open Terminal to sign in" }, secondary: { act: "pip" } });
    expect(help.detail).toBe("Claude was signed out while the agent worked. Sign in again in Terminal, then ask Pip to start it again.");
    const html = sheet(signedOut());
    expect(buttons(html)).toEqual(expect.arrayContaining(["Open Terminal to sign in", "Ask Pip to start it again"]));
    expect(buttons(html).filter((b) => b.startsWith("Retry"))).toEqual([]);
  });

  it("shows what was recorded with no Retry launch in the sheet, and Open the run in Needs you", () => {
    const run = { ...signedOut(), error: "the agent stopped", failure: { type: "other" as const } };
    expect(failureHelp(run)).toBeNull();
    const html = sheet(run);
    expect(html).toContain("The run stopped without finishing");
    expect(html).toContain("the agent stopped");
    expect(buttons(html).filter((b) => b.startsWith("Retry"))).toEqual([]);
    const [need] = needs({ runs: [run], proposals: [], workstreams: [], dismissed: new Set(), connections: [] } as unknown as Parameters<typeof needs>[0]).filter((n) => n.kind === "failure");
    expect(need.primary).toMatchObject({ id: "open", label: "Open the run" });
  });
});

describe("cleaning up a run on the harness", () => {
  it("is offered while its worktree is there, though it has no Claude session, and not once the worktree is removed", () => {
    const run = { ...byKey(harness(), "CA-407"), state: "done" as const, endedAt: new Date(NOW - 30 * 86_400_000).toISOString() };
    expect(run.shortId).toBeNull();
    expect(cleanable(run)).toBe(true);
    expect(cleanupReason(run, NOW, { disk: null, change: null })).toMatch(/more than 14 days ago/);
    expect(cleanable({ ...run, worktreeRemovedAt: new Date(NOW).toISOString() })).toBe(false);
  });

  it("is offered for a run handed over to Terminal, and the mock refuses it in the words Rust gives", async () => {
    const backend = harness();
    const run = byKey(backend, "SUP-15");
    expect(run.handedOver && cleanable(run)).toBe(true);
    await expect(backend.runsCleanup(run.id)).rejects.toThrow(HANDED_OVER_CLEANUP);
    expect(byKey(backend, "SUP-15").worktreeRemovedAt ?? null).toBeNull();
  });

  it("shows a refusal in the words it was given, and removes nothing", async () => {
    const backend = harness();
    const run = byKey(backend, "DEVOPS-490");
    expect(cleanupReason(run, NOW, { disk: null, change: null })).toMatch(/more than 14 days ago/);
    expect(await backend.runsCleanup(run.id)).toMatchObject({ type: "refused", message: expect.stringContaining("unpushed commits") });
    expect(byKey(backend, "DEVOPS-490").worktreeRemovedAt ?? null).toBeNull();
    const html = renderToStaticMarkup(<RunCleanupView run={run} reason="It ended more than 14 days ago." login="Claude" asking={false} busy={false} refused="The worktree has unpushed commits." onAsk={vi.fn()} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toContain("Claude kept it: The worktree has unpushed commits.");
  });
});

describe("a run handed over to Terminal", () => {
  it("refuses an answer in the mock with the same words as the app, and takes it once you say you took it back", async () => {
    const backend = harness();
    const run = byKey(backend, "SUP-13");
    await expect(backend.runsAnswer(run.id, "Yes, apply it to packed orders.")).rejects.toThrow(HANDED_OVER_ASK);
    expect(byKey(backend, "SUP-13").state).toBe("needsAnswer");
    const answered = await backend.runsAnswer(run.id, "Yes, apply it to packed orders.", { tookBack: true });
    expect(answered).toMatchObject({ state: "working", handedOver: false });
  });

  it("refuses Pip's message too, to one that is stopped as the app ends a handed-over run", () => {
    const backend = harness();
    const run = byKey(backend, "SUP-15");
    expect(run).toMatchObject({ state: "stopped", handedOver: true });
    expect(run.asking).toBeFalsy();
    expect(() => backend.runs.messageAgent(run.id, "Carry on.")).toThrow(HANDED_OVER_ASK);
    expect(byKey(backend, "SUP-15").state).toBe("stopped");
  });

  it("says why in the answer box and offers I took it back instead of Send answer", () => {
    const html = answerBox(byKey(harness(), "SUP-13"));
    expect(html).toContain(HANDED_OVER_ASK);
    expect(buttons(html)).toContain("I took it back");
    expect(buttons(html)).not.toContain("Send answer");
  });

  it("asks the same of a run the page didn't know was handed over once its answer is refused", async () => {
    const backend = harness();
    useRuns.getState().init(backend);
    await settle();
    const run = byKey(backend, "SUP-13");
    expect(await useRuns.getState().answer(run.id, "Yes, apply it to packed orders.")).toBe(false);
    expect(useRuns.getState().handedOverAsked.has(run.id)).toBe(true);
    expect(useToasts.getState().toasts).toEqual([]);
    expect(await useRuns.getState().answer(run.id, "Yes, apply it to packed orders.", { tookBack: true })).toBe(true);
    expect(useRuns.getState().handedOverAsked.has(run.id)).toBe(false);
  });

  it("reads Handed over to Terminal once it stopped", () => {
    expect(stoppedText({ error: null, lastDetail: "Opened in Terminal", possibleContinuations: [], handedOver: true })).toBe("Handed over to Terminal");
  });
});

describe("an answer the harness holds until the turn ends", () => {
  it("shows in the run's detail and in Answer sent, then clears when the turn moves on", async () => {
    const backend = harness();
    const run = byKey(backend, "CA-407");
    const answered = await backend.runsAnswer(run.id, "Yes, keep 10% back.");
    expect(answered.state).toBe("working");
    expect(answered.answerWaits).toBe(true);
    expect(rowText(answered, NOW)).toBe("Your answer waits for the turn to end");
    expect(answerSentText(answered)).toBe("Answer sent. The agent gets it when its current turn ends.");
    backend.runs.advance(run.id);
    expect(byKey(backend, "CA-407").answerWaits).toBeFalsy();
  });

  it("is said before you send to a run on the harness, though it is asking, as the harness marks every question", () => {
    const run = byKey(harness(), "CA-407");
    expect(run.asking).toBe(true);
    const html = answerBox(run);
    expect(html).toContain("Your answer reaches the agent when its current turn ends.");
    expect(html).not.toContain("goes straight to the agent");
    expect(answerSentText({})).toBe("Answer sent. The agent is picking it back up.");
  });
});

describe("Pip's message while the harness holds your answer", () => {
  it("is refused in the mock with the app's words until the answer has arrived", async () => {
    const backend = harness();
    const run = byKey(backend, "CA-407");
    await backend.runsAnswer(run.id, "Yes, keep 10% back.");
    expect(() => backend.runs.messageAgent(run.id, "Also check the subject lines.")).toThrow("Your answer is on its way to the agent. Send more once it has arrived.");
    backend.runs.advance(run.id);
    const after = (() => {
      try {
        return backend.runs.messageAgent(run.id, "Also check the subject lines.");
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(after).not.toContain("on its way");
  });
});

describe("a run whose session the harness couldn't open", () => {
  it("shows the reason as the app wrote it and offers Retry launch, since it has no session to keep", () => {
    const run = byKey(harness(), "CA-406");
    expect(run).toMatchObject({ state: "failed", shortId: null, failure: { type: "other" } });
    expect(run.harnessSession).toBeUndefined();
    expect(failureHelp(run)).toBeNull();
    expect(rowText(run, NOW)).toBe("The harness couldn't start the agent: the session limit is reached");
    const html = sheet(run);
    expect(html).toContain("It didn&#x27;t start");
    expect(buttons(html)).toContain("Retry launch");
    const [need] = needs({ runs: [run], proposals: [], workstreams: [], dismissed: new Set(), connections: [] } as unknown as Parameters<typeof needs>[0]).filter((n) => n.kind === "failure");
    expect(need.primary).toMatchObject({ id: "retry", label: "Retry" });
  });

  it("is retried by the mock, which refuses a retry for a run that has a harness session, as the app does", async () => {
    const backend = harness();
    expect((await backend.runsRetryLaunch(byKey(backend, "CA-406").id)).state).toBe("queued");
    await expect(backend.runsRetryLaunch(byKey(backend, "CA-405").id)).rejects.toThrow("has nothing to retry");
  });
});

describe("an answer that waits for a stopped session to resume", () => {
  it("reads as the app writes it, and Answer sent says it waits for the session, not the turn", () => {
    const run = byKey(harness(), "SUP-10");
    expect(rowText(run, NOW)).toBe("Your answer waits for the session to resume");
    expect(answerSentText(run)).toBe("Answer sent. It waits for the session to resume.");
    expect(answerSentText({ ...run, state: "working" })).toBe("Answer sent. The agent gets it when its current turn ends.");
  });
});

describe("a run's permissions", () => {
  it("shows the mode Gossamr last asked its agent for, and nothing for a run that never had a session", () => {
    const run = byKey(harness(), "CA-407");
    expect(sheet({ ...run, agentPermissions: "auto" })).toMatch(/data-agent-permissions[^>]*>Permissions <b[^>]*>Auto<\/b>/);
    expect(sheet({ ...run, agentPermissions: "ask" })).toMatch(/data-agent-permissions[^>]*>Permissions <b[^>]*>Ask for each step<\/b>/);
    expect(sheet({ ...run, agentPermissions: undefined })).not.toContain("data-agent-permissions");
  });

  it("follows a change of Settings in the mock for every run whose agent may run, and leaves the others", async () => {
    const backend = harness();
    const before = backend.runs.list().filter((r) => r.harnessSession);
    await backend.runsSetSettings({ ...(await backend.runsSettings()), permissions: "ask" });
    const live = (state: string) => ["working", "needsAnswer", "needsPermission"].includes(state);
    expect(before.some((r) => live(r.state)) && before.some((r) => !live(r.state))).toBe(true);
    for (const run of before) expect(backend.runs.list().find((r) => r.id === run.id)!.agentPermissions).toBe(live(run.state) ? "ask" : "auto");
  });

  it("takes the setting of the moment with a message to a working run in the mock, as the backend sends it", () => {
    const backend = harness();
    // A run on the harness in the middle of its turn, as the seed has none.
    const working = (backend.runs as unknown as { update(id: string, patch: Partial<Run>): Run }).update(byKey(backend, "CA-407").id, { state: "working", needs: null });
    expect(working.agentPermissions).toBe("auto");
    // As a run whose mode was set before a change of Settings the backend could not send.
    (backend.runs as unknown as { limits: { permissions: string } }).limits.permissions = "ask";
    expect(backend.runs.messageAgent(working.id, "Use the blue one.")).toBe("queued");
    expect(backend.runs.list().find((r) => r.id === working.id)!.agentPermissions).toBe("ask");
  });

  it("takes the setting of the moment with an answer in the mock, as the backend sends it with each message", async () => {
    const backend = harness();
    const run = byKey(backend, "CA-407");
    expect(run.agentPermissions).toBe("auto");
    await backend.runsSetSettings({ ...(await backend.runsSettings()), permissions: "ask" });
    expect(backend.runs.answer(run.id, "Yes, keep 10% back.").agentPermissions).toBe("ask");
  });
});
