import { afterEach, describe, expect, it } from "vitest";
import { escIsElsewhere } from "./escBack";
import { usePrefs } from "./prefs";

const esc = (over: Record<string, unknown> = {}) => ({ key: "Escape", defaultPrevented: false, target: null, ...over }) as Parameters<typeof escIsElsewhere>[0];

afterEach(() => usePrefs.setState({ paletteOpen: false }));

describe("Esc on a full page", () => {
  it("is for the page from <body>, and for something else in a field, a local control, or behind the palette", () => {
    expect(escIsElsewhere(esc())).toBe(false);
    expect(escIsElsewhere(esc({ key: "a" }))).toBe(true);
    expect(escIsElsewhere(esc({ defaultPrevented: true }))).toBe(true);
    expect(escIsElsewhere(esc({ target: { tagName: "INPUT" } }))).toBe(true);
    expect(escIsElsewhere(esc({ target: { closest: (s: string) => (s.includes("data-esc-local") ? {} : null) } }))).toBe(true);
    usePrefs.setState({ paletteOpen: true });
    expect(escIsElsewhere(esc())).toBe(true);
  });
});
