import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { HANDED_OVER_ASK, answerWaits, type ConnectionInfo, type Run } from "../types";
import { failureHelp } from "./failureHelp";
import { cleanupReason, refuserOf, removerOf } from "./cleanupLogic";
import { RunCleanupView } from "./RunCleanup";
import { RunAnswer, forgetKeptAnswers } from "./RunAnswer";
import { RunSheetView, type RunSheetActions } from "./RunSheet";
import { rowText } from "./AgentParts";
import { stoppedText } from "./agentsLogic";
import { answerSentText } from "./runSheetLogic";
import { NO_FILTERS } from "./agentsLogic";
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

describe("a run whose commit the signing agent refused", () => {
  it("says so, keeps no Retry, and offers asking Pip to start it again, though it had a session", () => {
    const run = byKey(harness(), "CA-430");
    const help = failureHelp(run)!;
    expect(run.harnessSession).toBeTruthy();
    expect(help).toMatchObject({ kind: "signingNeedsYou", retry: false, primary: { act: "pip", label: "Ask Pip to start it again" } });
    expect(help.summary).toBe("Your signing agent refused a commit, so the agent stopped.");
    expect(rowText(run, NOW)).toBe(help.summary);
  });

  it("shows the sheet's title as a run that stopped, with Ask Pip and no Retry", () => {
    const html = sheet(byKey(harness(), "CA-430"));
    expect(html).toContain("The run stopped without finishing");
    expect(html).toContain("Unlock it or check its settings");
    expect(buttons(html)).toContain("Ask Pip to start it again");
    expect(buttons(html)).not.toContain("Retry");
  });
});

describe("an agent the move to the harness interrupted", () => {
  it("offers Clean up first and asking Pip second, and only Pip once its worktree is gone", () => {
    const run = byKey(harness(), "WEB-131");
    expect(failureHelp(run)).toMatchObject({ kind: "interrupted", retry: false, primary: { act: "cleanup", label: "Clean up" }, secondary: { act: "pip" } });
    const removed = failureHelp({ ...run, worktreeRemovedAt: new Date(NOW).toISOString() })!;
    expect(removed.primary).toMatchObject({ act: "pip" });
    expect(removed.secondary).toBeUndefined();
    expect(removed.detail).toContain("Its worktree was removed");
  });

  it("wins over the help for a run set up outside the work folder, since Clean up is what it needs", () => {
    expect(failureHelp({ ...byKey(harness(), "WEB-131"), inWorkFolder: false })?.kind).toBe("interrupted");
  });

  it("is removed with git, and its sheet doesn't offer a second Clean up below the failure", () => {
    const run = byKey(harness(), "WEB-131");
    expect(removerOf(run, [], true).remover).toBe("git");
    expect(cleanupReason({ ...run, endedAt: new Date(NOW - 30 * 86_400_000).toISOString() }, NOW, { disk: null, change: null })).toBeNull();
    expect(buttons(sheet(run)).filter((b) => b === "Clean up")).toHaveLength(1);
  });

  it("refuses Clean up in the mock while it has unpushed work, in the words it gives", () => {
    const backend = harness();
    const run = byKey(backend, "WEB-131");
    backend.runs.unpushed.add(run.id);
    expect(backend.runs.cleanup(run.id)).toMatchObject({ type: "refused", message: expect.stringContaining("unpushed commits") });
  });
});

describe("cleaning up a run on the harness", () => {
  const provider = { kind: "provider", instanceId: "claude", displayName: "Work Claude", driver: "claude" } as unknown as ConnectionInfo;

  it("is done by Gossamr, which names itself when it refuses", () => {
    const run = byKey(harness(), "DEVOPS-490");
    expect(removerOf({ ...run, runsOn: { instanceId: "claude", model: "default" } as Run["runsOn"] }, [provider], true)).toEqual({ remover: "gossamr", login: "Work Claude" });
    expect(refuserOf("gossamr", "Claude")).toBe("Gossamr");
  });

  it("is offered for an old run though it has only a harness session, and shows a refusal as it was given", () => {
    const run = { ...byKey(harness(), "DEVOPS-490"), shortId: null };
    expect(cleanupReason(run, NOW, { disk: null, change: null })).toMatch(/more than 14 days ago/);
    const html = renderToStaticMarkup(<RunCleanupView run={run} reason="It ended more than 14 days ago." login="Claude" remover="gossamr" asking={false} busy={false} refused="The worktree has unpushed commits." onAsk={vi.fn()} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toContain("Gossamr refuses while work in it");
    expect(html).toContain("Gossamr kept it: The worktree has unpushed commits.");
    expect(html).not.toContain("claude rm");
  });

  it("is refused by the mock for the seeded run with unpushed work", async () => {
    const backend = harness();
    expect(await backend.runsCleanup(byKey(backend, "DEVOPS-490").id)).toMatchObject({ type: "refused" });
  });
});

describe("a run handed over to Terminal", () => {
  it("refuses an answer in the mock with the same words as the app, and takes it once you say you took it back", async () => {
    const backend = harness();
    const run = byKey(backend, "SUP-21");
    await expect(backend.runsAnswer(run.id, "Yes, weekends too.")).rejects.toThrow(HANDED_OVER_ASK);
    expect(byKey(backend, "SUP-21").state).toBe("needsAnswer");
    const answered = await backend.runsAnswer(run.id, "Yes, weekends too.", { tookBack: true });
    expect(answered).toMatchObject({ state: "working", handedOver: false });
  });

  it("refuses Pip's message too", () => {
    const backend = harness();
    expect(() => backend.runs.messageAgent(byKey(backend, "SUP-21").id, "Carry on.")).toThrow(HANDED_OVER_ASK);
  });

  it("says why in the answer box and offers I took it back instead of Send answer", () => {
    const html = answerBox(byKey(harness(), "SUP-21"));
    expect(html).toContain(HANDED_OVER_ASK);
    expect(buttons(html)).toContain("I took it back");
    expect(buttons(html)).not.toContain("Send answer");
  });

  it("asks the same of a run the page didn't know was handed over once its answer is refused", async () => {
    const backend = harness();
    useRuns.getState().init(backend);
    await settle();
    const run = byKey(backend, "SUP-21");
    expect(await useRuns.getState().answer(run.id, "Yes, weekends too.")).toBe(false);
    expect(useRuns.getState().handedOverAsked.has(run.id)).toBe(true);
    expect(useToasts.getState().toasts).toEqual([]);
    expect(await useRuns.getState().answer(run.id, "Yes, weekends too.", { tookBack: true })).toBe(true);
    expect(useRuns.getState().handedOverAsked.has(run.id)).toBe(false);
  });

  it("reads Handed over to Terminal once it stopped", () => {
    expect(stoppedText({ error: null, lastDetail: "Opened in Terminal", possibleContinuations: [], handedOver: true })).toBe("Handed over to Terminal");
  });
});

describe("an answer the harness holds until the turn ends", () => {
  it("shows in the run's detail and in Answer sent, then clears when the turn moves on", async () => {
    const backend = harness();
    const run = byKey(backend, "CA-432");
    const answered = await backend.runsAnswer(run.id, "They vanish.");
    expect(answered.state).toBe("working");
    expect(answerWaits(answered)).toBe(true);
    expect(rowText(answered, NOW)).toBe("Your answer waits for the turn to end.");
    expect(answerSentText(answered)).toBe("Answer sent. The agent gets it when its current turn ends.");
    backend.runs.advance(run.id);
    expect(answerWaits(byKey(backend, "CA-432"))).toBe(false);
  });

  it("is said before you send, for a run on the harness that isn't waiting in its ask call", () => {
    expect(answerBox(byKey(harness(), "CA-432"))).toContain("Your answer reaches the agent when its current turn ends.");
    expect(answerSentText({ lastDetail: null })).toBe("Answer sent. The agent is picking it back up.");
  });
});
