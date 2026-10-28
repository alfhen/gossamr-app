import { describe, expect, it } from "vitest";
import { ROUTE_NAME, routeHeading, routeTitle } from "./routeTitle";

describe("route titles (G29)", () => {
  it("names the browser tab after the screen, then the app", () => {
    expect(routeTitle("agents")).toBe("Work — Gossamr");
    expect(routeTitle("settings")).toBe("Settings — Gossamr");
  });

  it("has a name for every screen, and none repeated", () => {
    const names = Object.values(ROUTE_NAME);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("brings the keyboard to a heading on the screens that have one and nothing else puts it somewhere", () => {
    expect(routeHeading("activity")).toBe("main h1");
    expect(routeHeading("agents")).toBe("main h1");
    expect(routeHeading("workspace")).toBeNull();
  });
});
