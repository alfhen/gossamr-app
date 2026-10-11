import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "../types";
import { DraftCard } from "./DraftCard";
import { DraftPreview } from "./DraftPreview";
import { RetiredDraft } from "./RetiredDraft";

const ref = { connectionId: "mock", externalId: "CA-401", key: "CA-401" };

const move = (id: string, state: Proposal["state"], over: Partial<Proposal> = {}): Proposal => ({
  id,
  createdAt: "2026-09-30T11:00:00Z",
  updatedAt: "2026-09-30T11:05:00Z",
  origin: { type: "chat", requestId: "q1", workstream: "ws-1" },
  createdBy: "pip",
  intent: { type: "transition", item: ref, to: "ca-qa" },
  label: "QA",
  basis: null,
  state,
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const superseded = move("old", { type: "retired", reason: "Replaced by a newer draft" }, { supersededBy: "new" });
const retired = move("mine", { type: "retired", reason: "Another move of CA-401 was approved" }, { origin: { type: "board" }, createdBy: "user" });

const preview = (p: Proposal) => renderToStaticMarkup(<DraftPreview proposal={p} statusName="QA" targetTitle="Welcome flow refresh" onOpen={vi.fn()} />);
const card = (p: Proposal) => renderToStaticMarkup(<DraftCard proposal={p} statusName="QA" people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);

/** What shows before the disclosure is opened: everything up to the hidden body. */
const line = (html: string) => html.slice(0, html.indexOf(' hidden=""'));

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("retired drafts", () => {
  it("show a superseded draft collapsed to one line with its reason and a way to the newer draft, in the conversation and the peek", () => {
    for (const html of [preview(superseded), card(superseded)]) {
      expect(line(html)).toContain('data-retired-draft="old"');
      expect(line(html)).toContain('data-superseded-by="new"');
      expect(line(html)).toContain('aria-expanded="false"');
      expect(line(html)).toMatch(/Move CA-401<\/span>.*Out of date · Replaced by a newer draft/);
      expect(line(html)).toContain("Show the newer draft");
      // The whole card is there behind the disclosure, closed.
      expect(html).toMatch(/<div id="retired-draft-old" hidden="">/);
      expect(html.slice(html.indexOf(' hidden=""'))).toContain('data-draft="old"');
      expect(line(html)).not.toContain('data-draft="old"');
    }
  });

  it("show a draft retired for another reason collapsed with that reason, and no newer draft to show", () => {
    for (const html of [preview(retired), card(retired)]) {
      expect(line(html)).toContain("Out of date · Another move of CA-401 was approved");
      expect(html).not.toContain("Show the newer draft");
      expect(html).not.toContain("data-superseded-by");
    }
  });

  it("expand to the whole card", () => {
    const html = renderToStaticMarkup(
      <RetiredDraft proposal={superseded} title="Move CA-401" state="Out of date" initialOpen>
        <p>the whole card</p>
      </RetiredDraft>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain(' hidden=""');
    expect(html).toContain("<p>the whole card</p>");
  });

  it("leave open and decided drafts as they were", () => {
    for (const state of [{ type: "pending" }, { type: "applied" }, { type: "skipped" }] as Proposal["state"][]) {
      expect(preview(move("p", state))).not.toContain("data-retired-draft");
      expect(card(move("p", state))).not.toContain("data-retired-draft");
    }
  });
});
