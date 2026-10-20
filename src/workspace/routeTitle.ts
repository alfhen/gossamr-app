import type { Route } from "./tabsStore";

/** What each screen is called: its tab's title, its main area's name and its heading's. */
export const ROUTE_NAME: Record<Route, string> = {
  workspace: "Tickets",
  activity: "Activity",
  agents: "Agents",
  settings: "Settings",
  sent: "What Jira saw from me",
};

/** The browser tab's title on `route`: "Agents — Gossamr". */
export const routeTitle = (route: Route) => `${ROUTE_NAME[route]} — Gossamr`;

/** The heading a screen change brings the keyboard to; the ticket screen has no one heading. */
export const routeHeading = (route: Route) => (route === "workspace" ? null : "main h1");
