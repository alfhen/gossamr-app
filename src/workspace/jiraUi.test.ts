import { describe, expect, it } from "vitest";
import { useJiraUi } from "./jiraUi";

describe("the Connect Jira sheet", () => {
  it("remembers the row it was opened from until it closes", () => {
    useJiraUi.getState().openConnect("jira_2");
    expect(useJiraUi.getState()).toMatchObject({ connectOpen: true, connectInstanceId: "jira_2" });
    useJiraUi.getState().closeConnect();
    expect(useJiraUi.getState()).toMatchObject({ connectOpen: false, connectInstanceId: undefined });
    useJiraUi.getState().openConnect();
    expect(useJiraUi.getState().connectInstanceId).toBeUndefined();
    useJiraUi.getState().closeConnect();
  });
});
