import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Run } from "../types";
import { forgetKeptAnswers, keepAnswer, RunAnswer } from "./RunAnswer";

const asking = (needs: string): Run => ({ id: "r-ask", state: "needsAnswer", needs, suggestedReply: null, unsentAnswer: null, error: null, lastDetail: null }) as unknown as Run;
const card = (run: Run) => renderToStaticMarkup(<RunAnswer run={run} answering={false} on={{ answer: vi.fn(), attach: vi.fn() }} />);
const textarea = (html: string) => /<textarea[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1] ?? null;

afterEach(() => forgetKeptAnswers());

describe("a typed answer to an agent's question (G1)", () => {
  it("is still there when the card is drawn again, and a new question starts empty", () => {
    const run = asking("Keep the old rounding?");
    expect(textarea(card(run))).toBe("");
    keepAnswer(run, "Yes, keep it.");
    expect(textarea(card(run))).toBe("Yes, keep it.");
    expect(textarea(card(asking("Which currency?")))).toBe("");
    forgetKeptAnswers("r-ask");
    expect(textarea(card(run))).toBe("");
  });
});
