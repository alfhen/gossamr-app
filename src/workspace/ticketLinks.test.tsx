import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { Markdown } from "../components/Markdown";
import { TicketLinksContext } from "../components/ticketLinks";
import type { Run, WorkContainer, WorkItem } from "../types";
import { useWorkspace } from "../workspaceStore";
import { knownTicketTitle, workspaceTicketLinks } from "./jump";
import { useRuns } from "./runsStore";

const ref = (key: string) => ({ connectionId: "mock", externalId: key, key });
const container = (key: string) => ({ ref: { connectionId: "mock", externalId: key }, key, name: key, workflow: { statuses: [], transitions: { kind: "any" } } }) as unknown as WorkContainer;

describe("ticket keys in Pip's answers", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    useWorkspace.setState({ items: { "mock:CA-401": { item: ref("CA-401"), title: "Welcome flow" } as WorkItem }, containers: { "mock:CA": container("CA") } });
    useRuns.setState({ runs: [{ id: "r1", item: ref("DEVOPS-455") } as Run] });
  });
  afterEach(() => {
    useWorkspace.setState({ items: {}, containers: {} });
    useRuns.setState({ runs: [] });
    vi.unstubAllGlobals();
  });

  it("know a cached key by its title, a run's key and a key in a known project without one, and no other", () => {
    expect(knownTicketTitle("CA-401")).toBe("Welcome flow");
    expect(knownTicketTitle("DEVOPS-455")).toBe("");
    expect(knownTicketTitle("CA-411")).toBe("");
    expect(knownTicketTitle("ZZ-9")).toBeNull();
  });

  it("link every key Gossamr knows, cached or not, and leave an unknown project's key as text", () => {
    const html = renderToStaticMarkup(
      <TicketLinksContext.Provider value={workspaceTicketLinks}>
        <Markdown text="CA-401 is planned; DEVOPS-455 and CA-411 are done; ZZ-9 is elsewhere." />
      </TicketLinksContext.Provider>,
    );
    expect(html).toMatch(/<button[^>]*title="CA-401: Welcome flow"[^>]*>CA-401<\/button>/);
    expect(html).toMatch(/<button[^>]*title="Open DEVOPS-455"[^>]*>DEVOPS-455<\/button>/);
    expect(html).toMatch(/<button[^>]*title="Open CA-411"[^>]*>CA-411<\/button>/);
    expect(html).not.toContain(">ZZ-9</button>");
    expect(html).toContain("ZZ-9");
  });
});

describe("the sample backend's live peek", () => {
  it("opens the tickets only its sample runs name, as finished tickets in their project, and still not an unknown key", async () => {
    const b = new MockBackend();
    for (const key of ["CA-377", "DEVOPS-455", "SUP-9", "WEB-97"]) {
      const item = await b.peekItem(ref(key));
      expect(item?.item.key).toBe(key);
      expect(item?.status.category).toBe("done");
      expect(item?.title).not.toBe("");
    }
    expect(await b.peekItem(ref("CA-9999"))).toBeNull();
  });
});
