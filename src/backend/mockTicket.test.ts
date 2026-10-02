import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { TICKET_BLOCK_LIMIT, ticketBlockText } from "./mockTicket";
import { docFromText } from "../lib/docs";
import type { WorkComment } from "../types";

describe("the sample ticket block", () => {
  it("carries metadata, the description and the discussion, oldest comment first", async () => {
    const backend = new MockBackend();
    const run = await backend.runs.ticketText(itemRef("CA-402"));
    expect(run).toMatch(/^CA-402: .+\nKind: .+ \| Status: .+ \| Priority: .+ \| Assignee: .+ \| Reporter: /);
    expect(run).toContain("Description:");
    expect(run!.indexOf("Description:")).toBeLessThan(run!.indexOf("Comments"));
  });

  it("keeps the newest ten comments inside the budget and counts the rest", async () => {
    const backend = new MockBackend();
    const item = backend.connector.item(itemRef("CA-402"))!;
    const author = item.reporter ?? backend.connector.identity().accounts[0];
    const comments: WorkComment[] = Array.from({ length: 30 }, (_, n) => ({ id: String(n), author, body: docFromText(`comment ${n} ${"x".repeat(900)}`), created: "2026-09-28T08:00:00Z", mentions: [] }));
    const text = ticketBlockText({ item: { ...item, body: docFromText("d".repeat(9_000)) }, comments, people: backend.connector.people, titleOf: () => null, code: [] });
    expect(text.length).toBeLessThanOrEqual(TICKET_BLOCK_LIMIT);
    expect(text).toContain("[description cut at 3500 characters]");
    expect(text).toMatch(/older comments omitted: 2\d/);
    expect(text).toContain("comment 29");
    expect(text).not.toContain("comment 5 ");
  });
});
