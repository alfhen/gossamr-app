import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkstreamView } from "../types";
import { ClarityNotice, QuietClarity } from "./WorkstreamControls";

const view = (over: Partial<WorkstreamView> = {}): WorkstreamView =>
  ({ workstream: { id: "w1", connectionId: "c", itemKey: "CA-408", title: "CA-408 Thing", closedAt: null, createdAt: "2026-10-01T10:00:00Z" }, stage: "intake", runs: [], labels: [], budget: {}, clarity: { gaps: ["short", "done"] }, ...over }) as unknown as WorkstreamView;

describe("the clarity notice", () => {
  it("names the gaps, with Ask the reporter now and Looks fine", () => {
    const html = renderToStaticMarkup(<ClarityNotice view={view()} />);
    expect(html).toContain("CA-408 may be unclear: it has a very short description and doesn&#x27;t say what done looks like.");
    expect(html).toContain("Ask the reporter now");
    expect(html).toContain("Looks fine");
  });

  it("says the reporter replied, instead of the gaps again, once they have", () => {
    const html = renderToStaticMarkup(<ClarityNotice view={view({ reporterReplied: true, changedWhileWaiting: true })} />);
    expect(html).toContain("CA-408: the reporter replied; read it, then Looks fine or ask again.");
    expect(html).not.toContain("may be unclear");
    expect(html).toContain("Ask the reporter now");
  });

  it("quotes the reporter's reply once there is one (G15)", () => {
    const replied = view({ reporterReplied: true, changedWhileWaiting: true, reporterReply: { id: "c1", excerpt: "It should send three emails." } });
    expect(renderToStaticMarkup(<ClarityNotice view={replied} />)).toContain("They wrote: “It should send three emails.”");
    expect(renderToStaticMarkup(<ClarityNotice view={view({ reporterReplied: true, changedWhileWaiting: true })} />)).not.toContain("They wrote");
  });

  it("is a labelled group, not a live region that reads its buttons; a short status line says what appeared (G10)", () => {
    const html = renderToStaticMarkup(<ClarityNotice view={view()} />);
    expect(html).toContain('<span role="status" data-clarity-status="true" class="sr-only">CA-408 may be unclear</span>');
    expect(html).toMatch(/<div role="group" aria-label="Ticket wording check" data-clarity-notice="w1"/);
    for (const m of html.matchAll(/<(\w+)[^>]*role="status"[^>]*>(.*?)<\/\1>/g)) expect(m[2]).not.toContain("<button");
    expect(renderToStaticMarkup(<ClarityNotice view={view({ reporterReplied: true })} />)).toContain("CA-408: the reporter replied</span>");
  });

  it("has one live region for what it says, whichever way the ticket is flagged (G31)", () => {
    for (const html of [renderToStaticMarkup(<ClarityNotice view={view()} />), renderToStaticMarkup(<ClarityNotice view={view({ reporterReplied: true })} />)]) {
      expect(html.match(/role="status"/g)).toHaveLength(1);
      expect(html).not.toContain("aria-live");
    }
  });

  it("is not shown without a notice", () => {
    expect(renderToStaticMarkup(<ClarityNotice view={view({ clarity: null })} />)).toBe("");
  });
});

describe("the quiet note for what Looks fine taught away", () => {
  it("says what is not flagged and in which project, with a way to flag it again", () => {
    const html = renderToStaticMarkup(<QuietClarity view={view()} project="CA" gaps={["who", "scope"]} />);
    expect(html).toContain('data-clarity-quiet="w1"');
    expect(html).toContain('Not flagged: you said Looks fine to no &quot;who is waiting&quot; and no scope in CA tickets.');
    // It resets the gaps for every ticket of the project, so the link says the project, and the note is not the faintest grey.
    expect(html).toContain("Flag again in CA");
    expect(html).not.toContain("text-ws-ink3");
  });
});
