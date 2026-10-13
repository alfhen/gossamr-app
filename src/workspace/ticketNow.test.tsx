import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TicketNow } from "./NeedsPane";

describe("The ticket now says", () => {
  it("shows a short description whole, labelled, with nothing to fold away", () => {
    const html = renderToStaticMarkup(<TicketNow text="Win back lapsed customers with three emails." />);
    expect(html).toContain("data-ticket-now");
    expect(html).toContain("The ticket now says");
    expect(html).toContain("Win back lapsed customers with three emails.");
    expect(html).not.toContain("<details");
  });

  it("shows the start of a long one, with the whole of it in a collapsed disclosure", () => {
    const text = `${"Win back lapsed customers. ".repeat(30)}THE END`;
    const html = renderToStaticMarkup(<TicketNow text={text} />);
    expect(html).toContain("The ticket now says");
    expect(html).toContain("…");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Show the whole description");
    expect(html.match(/THE END/g)).toHaveLength(1);
  });

  it("says nothing for an empty description", () => {
    expect(renderToStaticMarkup(<TicketNow text="" />)).toBe("");
  });
});
