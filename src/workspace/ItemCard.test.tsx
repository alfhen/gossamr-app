import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import type { ConnectionInfo, ItemRef, WorkItem } from "../types";
import { ItemCard, type ItemCardProps } from "./ItemCard";
import { ListRow } from "./ListView";
import { siteNamer } from "./keyLookup";

const ticket = (connectionId: string): WorkItem =>
  ({
    item: { ...itemRef("CA-402"), connectionId },
    title: "Subject line variants",
    status: { id: "1", name: "To do", category: "todo" },
    labels: [],
    updated: "2026-09-30T10:00:00Z",
    assignee: null,
    kind: "task",
    priority: null,
  }) as unknown as WorkItem;

const jira = (id: string, displayName: string, enabled = true) => ({ id, kind: "jira", enabled, displayName }) as ConnectionInfo;
const acme = jira("mock", "acme.atlassian.net");
const beta = jira("mock2", "beta.atlassian.net");

const siteOf = (connections: ConnectionInfo[], ref: ItemRef) => siteNamer(connections)(ref);

const card = (item: WorkItem, site: string | null): ItemCardProps => ({
  item,
  site,
  assignee: "Jonas Berg",
  now: new Date("2026-09-30T12:00:00Z"),
  wither: 0,
  blocked: false,
  needsMe: false,
  unread: false,
  draft: null,
  moreDrafts: 0,
  selected: false,
  marked: false,
  menuOpen: false,
  moveTargets: [],
  onSelect: vi.fn(),
  onMenu: vi.fn(),
  onMove: vi.fn(),
  onApprove: vi.fn(),
  onSkip: vi.fn(),
});

describe("the account chip on a card and a row", () => {
  it("shows no chip while one Jira account is on", () => {
    const item = ticket("mock");
    const site = siteOf([acme], item.item);
    expect(renderToStaticMarkup(<ItemCard {...card(item, site)} />)).not.toContain("data-site");
    expect(renderToStaticMarkup(<ListRow {...card(item, site)} />)).not.toContain("data-site");
  });

  it("shows no chip when the second account is off", () => {
    const item = ticket("mock");
    expect(renderToStaticMarkup(<ItemCard {...card(item, siteOf([acme, { ...beta, enabled: false }], item.item))} />)).not.toContain("data-site");
  });

  it("names the account of each ticket on a card once two are on", () => {
    const connections = [acme, beta];
    const first = renderToStaticMarkup(<ItemCard {...card(ticket("mock"), siteOf(connections, ticket("mock").item))} />);
    const second = renderToStaticMarkup(<ItemCard {...card(ticket("mock2"), siteOf(connections, ticket("mock2").item))} />);
    expect(first).toContain("data-site");
    expect(first).toContain("acme.atlassian.net");
    expect(second).toContain("beta.atlassian.net");
    expect(second).not.toContain("acme.atlassian.net");
  });

  it("names the account on a list row once two are on", () => {
    const item = ticket("mock2");
    const row = renderToStaticMarkup(<ListRow {...card(item, siteOf([acme, beta], item.item))} />);
    expect(row).toContain("data-site");
    expect(row).toContain("beta.atlassian.net");
  });
});
