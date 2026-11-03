import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import type { ItemRef, Proposal } from "../types";
import { useWorkspace } from "../workspaceStore";
import { openLiveDraft } from "./DraftPreview";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";

vi.mock("./peekDrafts", async (orig) => ({ ...(await orig<typeof import("./peekDrafts")>()), focusPeekDraft: vi.fn() }));

const draftOn = (item: ItemRef) =>
  ({ id: "p1", intent: { type: "comment", item, body: "hi" }, state: { type: "pending" }, created: [] }) as unknown as Proposal;

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  useTabs.getState().select(null);
  await useWorkspace.getState().init(new MockBackend({ jira: 2, githubRepos: 6 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  useRuns.getState().closeSheet();
});

describe("opening a draft from its card", () => {
  for (const inline of [false, true]) {
    it(`a_draft_cards_action_closes_an_open_run_sheet_before_it_shows_the_ticket${inline ? "_inline" : ""}`, () => {
      const key = Object.keys(useWorkspace.getState().items)[0];
      const { item } = useWorkspace.getState().items[key];
      const ref: ItemRef = { connectionId: item.connectionId, externalId: item.externalId, key: item.key };
      useRuns.setState({ sheet: { type: "run", id: "run-1" } });
      openLiveDraft(draftOn(ref), { inline });
      expect(useRuns.getState().sheet).toBeNull();
      expect(useTabs.getState().selected).toBe(key);
    });
  }
});
