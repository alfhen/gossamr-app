import { row, type Project, type SiteData } from "./mockConnector";

/**
 * A second sample Jira site. It shares the project key CA and the ticket key CA-402 with the first, under other names and
 * workflows, so everything that looks a ticket up by its key alone meets a collision.
 */
const PROJECTS: Project[] = [
  { key: "CA", name: "Client campaigns", statuses: [["Open", "todo"], ["Working", "active"], ["Shipped", "done"]] },
  { key: "OPS", name: "Operations", statuses: [["To Do", "todo"], ["In Progress", "active"], ["Done", "done"]] },
];

export const BETA_SITE: Omit<SiteData, "connectionId"> = {
  projects: PROJECTS,
  rows: [
    row("CA-402", "task", "Quote template for the pilot", "Open", "me", 2, { priority: "high", body: "One page, three price tiers, in the client's language." }),
    row("CA-501", "story", "Onboarding emails for the pilot", "Working", "mette", 1, { labels: ["flow"] }),
    row("CA-502", "bug", "Pilot invoice shows the wrong VAT", "Open", undefined, 3, { labels: ["bug"] }),
    row("OPS-1", "task", "Renew the staging certificates", "In Progress", "me", 4, { labels: ["security"] }),
    row("OPS-2", "task", "Move the nightly export to the new bucket", "To Do", "sam", 6),
    row("OPS-3", "bug", "Export job stalls on large clients", "In Progress", "priya", 2, { priority: "high", labels: ["bug"] }),
    row("OPS-4", "task", "Archive last year's reports", "Done", "maya", 9),
  ],
  links: [["OPS-3", "OPS-2", "relates"]],
  replies: [],
  comments: [
    ["CA-402", "priya", 45, "@Alf Henderson can you send the quote template before Friday?"],
    ["OPS-3", "sam", 3 * 60, "Reproduced with the biggest client's data, the job stops at row 40 000."],
    ["CA-501", "mette", 60 * 24, "Copy for the first email is in the doc."],
  ],
  changes: [["OPS-4", "maya", 60 * 24 * 9, "In Progress", "Done"]],
  assignments: [["OPS-1", "sam", 5 * 60]],
};
