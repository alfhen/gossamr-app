import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { TicketLinksContext } from "./ticketLinks";

describe("ticket keys in a reply, inside the workspace", () => {
  it("link the keys the workspace has cached and leave the rest as text", () => {
    const links = { titleOf: (k: string) => (k === "CA-1" ? "Fix the thing" : null), open: vi.fn() };
    const html = renderToStaticMarkup(
      <TicketLinksContext.Provider value={links}>
        <Markdown text="See CA-1 and ZZ-9." />
      </TicketLinksContext.Provider>,
    );
    expect(html).toMatch(/<button[^>]*title="CA-1: Fix the thing"[^>]*>CA-1<\/button>/);
    expect(html).not.toContain(">ZZ-9</button>");
    expect(html).toContain("ZZ-9");
  });
});
