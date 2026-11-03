import { afterEach, describe, expect, it } from "vitest";
import { docFromText } from "../lib/docs";
import type { Intent, Proposal } from "../types";
import { openLiveDraft } from "./DraftPreview";
import { useRuns } from "./runsStore";

const comment = (key: string) =>
  ({
    id: "d1",
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
    origin: { type: "chat", requestId: "q", workstream: "ws-1" },
    createdBy: "pip",
    intent: { type: "comment", item: { connectionId: "jira:acme", externalId: key, key }, body: docFromText("Status") } as Intent,
    label: null,
    basis: null,
    state: { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
  }) as unknown as Proposal;

afterEach(() => useRuns.setState({ sheet: null, browseOrder: null }));

describe("openLiveDraft", () => {
  it("closes an open run sheet so the ticket it shows is not left behind the sheet", () => {
    useRuns.setState({ sheet: { type: "run", id: "r1" } });
    openLiveDraft(comment("CA-294"));
    expect(useRuns.getState().sheet).toBeNull();
  });

  it("closes it on Agents too, where the ticket opens in the peek over the list", () => {
    useRuns.setState({ sheet: { type: "run", id: "r1" } });
    openLiveDraft(comment("CA-294"), { inline: true });
    expect(useRuns.getState().sheet).toBeNull();
  });
});
