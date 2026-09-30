import { docFromText } from "../lib/docs";
import { itemRef, statusId } from "./mockConnector";
import type { MockProposals } from "./mockProposals";

/** Drafts the assistant might have left, on items across several projects. */
export function seedDrafts(proposals: MockProposals) {
  const ref = itemRef;
  proposals.draft(
    { type: "comment", item: ref("DEVOPS-471"), body: docFromText("Looks good from my side. Merging once CI is green.") },
    null,
    "sample-1",
  );
  proposals.draft({ type: "transition", item: ref("DEVOPS-471"), to: statusId("DEVOPS", "Done") }, "Done", "sample-1");
  proposals.draft({ type: "transition", item: ref("CA-409"), to: statusId("CA", "Design") }, "Design", "sample-2");
  proposals.draft(
    { type: "subtasks", parent: ref("WEB-108"), summaries: ["Design modal states", "Wire up size data", "Add analytics event"] },
    null,
    "sample-3",
  );
  proposals.draft(
    {
      type: "comment",
      item: ref("SUP-12"),
      body: docFromText("Thanks, we have the bank reference and are chasing the refund with the payment provider."),
    },
    null,
    "sample-4",
  );
}
