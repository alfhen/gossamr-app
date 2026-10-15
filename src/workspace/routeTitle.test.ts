import { describe, expect, it } from "vitest";
import { ROUTE_NAME, routeHeading, routeTitle } from "./routeTitle";

describe("route titles (G29)", () => {
  it("names the browser tab after the screen, then the app", () => {
    expect(routeTitle("pip")).toBe("Pip home — Gossamr");
    expect(routeTitle("sent")).toBe("What Jira saw from me — Gossamr");
    expect(routeTitle("settings")).toBe("Settings — Gossamr");
  });

  it("has a name for every screen, and none repeated", () => {
    const names = Object.values(ROUTE_NAME);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("brings the keyboard to a heading on the screens that have one and nothing else puts it somewhere", () => {
    expect(routeHeading("sent")).toBe("main h1");
    expect(routeHeading("activity")).toBe("main h1");
    expect(routeHeading("pip")).toBeNull();
    expect(routeHeading("workspace")).toBeNull();
  });
});
