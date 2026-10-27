import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState } from "../types";
import { RunSheetView, type RunSheetActions, type RunSheetViewProps } from "./RunSheet";
import { CodeBox } from "./AgentSheet";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const seeded = () => new MockBackend().runs.list();

const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...seeded()[0], id: `r-${state}`, state, needs: null, lastDetail: null, tokens: 2_772, result: null, error: null, shortId: "2afa0a22", lastProgressAt: iso(1), queuedAt: iso(150), endedAt: iso(90), suggestedReply: null, unsentAnswer: null, ...over });

const actions = (): RunSheetActions => ({ close: vi.fn(), attach: vi.fn(), askStop: vi.fn(), cancelStop: vi.fn(), stop: vi.fn(), startNow: vi.fn(), answer: vi.fn(), adoptSession: vi.fn(() => Promise.resolve()), retry: vi.fn(), fix: vi.fn(), copied: vi.fn(), openTicket: vi.fn(), reveal: vi.fn(), askPip: vi.fn(), openChange: vi.fn() });

const sheet = (r: Run, over: Partial<RunSheetViewProps> = {}) =>
  renderToStaticMarkup(<RunSheetView run={r} now={NOW} ticketTitle="Hobbii MCP gateway" place={null} wide={false} onWide={vi.fn()} events={[]} disk={null} confirmStop={false} outcome={null} tickets={[]} pickBlocker={false} drafting={false} answering={false} opened={false} on={actions()} {...over} />);

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("a stopped run", () => {
  it("says Stopped and offers nothing to resume or answer", () => {
    const html = sheet(run("stopped"));
    expect(html).toContain("Stopped");
    expect(html).not.toContain("limit");
    expect(html).not.toContain("<textarea");
    expect(buttons(html)).not.toContain("Resume");
  });

  it("with an answer that didn't get through shows that answer to send again", () => {
    const html = sheet(run("stopped", { unsentAnswer: "Use staging.", error: "Couldn't wake the agent: boom." }));
    expect(html).toContain("Your answer didn&#x27;t get through");
    expect(buttons(html)).toContain("Start it again with your answer");
    expect(buttons(html)).not.toContain("Resume");
  });
});

describe("a run that may have continued in another session", () => {
  const offered = (ids: string[], state: RunState = "stopped") => run(state, { possibleContinuations: ids.map((shortId) => ({ shortId, sessionId: null, startedAt: null })) });

  it("offers one click to adopt each session and never adopts on its own", () => {
    const html = sheet(offered(["bbb748a7"]));
    expect(html).toContain("This run may have continued in another session");
    expect(buttons(html)).toContain("Adopt session bbb748a7");
    expect(html).toContain("couldn&#x27;t be sure it is the same conversation");
  });

  it("lists every candidate when there is more than one", () => {
    const html = sheet(offered(["c0de0001", "c0de0002"]));
    expect(buttons(html).filter((b) => b.startsWith("Adopt session"))).toEqual(["Adopt session c0de0001", "Adopt session c0de0002"]);
    expect(html).toContain("couldn&#x27;t be sure which is the same conversation");
  });

  it("is not offered while the run holds an answer to send: that goes to its own session first", () => {
    const html = sheet(run("stopped", { unsentAnswer: "Use staging.", error: "Couldn't wake the agent: boom.", possibleContinuations: [{ shortId: "bbb748a7", sessionId: null, startedAt: null }] }));
    expect(buttons(html).some((b) => b.startsWith("Adopt session"))).toBe(false);
    expect(buttons(html)).toContain("Start it again with your answer");
  });

  it("is shown for a finished run too, and not for one that is working or has nothing to offer", () => {
    expect(buttons(sheet(offered(["bbb748a7"], "done")))).toContain("Adopt session bbb748a7");
    expect(buttons(sheet(offered(["bbb748a7"], "working"))).some((b) => b.startsWith("Adopt session"))).toBe(false);
    expect(buttons(sheet(run("stopped"))).some((b) => b.startsWith("Adopt session"))).toBe(false);
  });
});

describe("answering from the sheet", () => {
  const asking = (over: Partial<Run> = {}) => run("needsAnswer", { needs: "Keep the old rounding?", endedAt: null, ...over });
  const sendOff = (html: string) => /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Send answer/.test(html);

  it("starts with an empty box and Send off, Claude's suggestion beside it with Use this, and what Gossamr adds folded away", () => {
    const html = sheet(asking({ suggestedReply: "Yes, keep it." }));
    expect(/<textarea[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1]).toBe("");
    expect(sendOff(html)).toBe(true);
    expect(html).toContain("Claude suggests:</b> “Yes, keep it.”");
    expect(buttons(html)).toContain("Use this");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>[\s\S]*?What Gossamr adds<\/summary>/);
    expect(html).not.toContain("Added in front of your answer");
  });

  it("still starts with the person's own answer that didn't get through, and offers no suggestion over it", () => {
    const html = sheet(run("stopped", { unsentAnswer: "Use staging.", suggestedReply: "Yes, keep it." }));
    expect(/<textarea[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1]).toBe("Use staging.");
    expect(html).not.toContain("Claude suggests");
    expect(sendOff(html)).toBe(false);
  });

  it("says the answer was sent until the run reports progress", () => {
    const working = run("working", { endedAt: null });
    expect(sheet(working, { answerSent: true })).toMatch(/role="status" data-answer-sent[^>]*>[\s\S]*Answer sent. Claude is picking it back up./);
    expect(sheet(working)).not.toContain("data-answer-sent");
  });
});

describe("a failed launch's own-terminal command", () => {
  const trust = () => run("failed", { shortId: null, error: "Claude hasn't been opened in this folder", failure: { type: "untrustedFolder", path: "/Users/sample/Code/storefront" } as Run["failure"] });

  it("enables Retry once the command was copied, as the Terminal button does", () => {
    const before = sheet(trust());
    const after = sheet(trust(), { opened: true });
    const retryOff = (html: string) => /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Retry<\/button>/.test(html);
    expect(before).toContain("Or run this in your own terminal");
    expect(retryOff(before)).toBe(true);
    expect(retryOff(after)).toBe(false);
  });

  it("counts copying the command by hand, selected, as copying it with the button", () => {
    const copied = vi.fn();
    const box = CodeBox({ text: "cd /x && claude", what: "the command", onCopied: copied });
    const code = (box.props.children as React.ReactElement[]).find((c) => c?.type === "code") as React.ReactElement<{ onCopy?(): void }>;
    code.props.onCopy?.();
    expect(copied).toHaveBeenCalledTimes(1);
  });
});
