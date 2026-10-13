import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPLAINER_ALLOW, EXPLAINER_DENY, PermissionExplainer } from "./PermissionAsk";
import { loadPrefs, usePrefs } from "./prefs";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  usePrefs.setState(loadPrefs());
});

afterEach(() => {
  usePrefs.setState({ permissionExplainerSeen: false });
  vi.unstubAllGlobals();
});

describe("the one-time explainer on a permission prompt", () => {
  it("says what Allow once in Terminal does and what Deny does, with a Got it button", () => {
    const html = renderToStaticMarkup(<PermissionExplainer allow />);
    expect(EXPLAINER_ALLOW).toBe("Allow once in Terminal records your choice, opens this run in Terminal with the exact command copied, and you confirm there. Nothing runs until you do.");
    expect(EXPLAINER_DENY).toBe("Deny tells the agent no, and it carries on without it.");
    expect(html).toContain(EXPLAINER_DENY);
    expect(html).toContain("records your choice");
    expect(html).toMatch(/<button[^>]*>Got it<\/button>/);
  });

  it("leaves Allow once out where the run can't be allowed", () => {
    const html = renderToStaticMarkup(<PermissionExplainer allow={false} />);
    expect(html).toContain(EXPLAINER_DENY);
    expect(html).not.toContain("records your choice");
  });

  it("is dismissed for good: the choice is kept and read back on the next start", () => {
    expect(loadPrefs().permissionExplainerSeen).toBe(false);
    usePrefs.getState().setPermissionExplainerSeen(true);
    expect(JSON.parse(localStorage.getItem("gossamr-prefs") ?? "{}").permissionExplainerSeen).toBe(true);
    expect(loadPrefs().permissionExplainerSeen).toBe(true);
    // Anything but a stored true is unseen.
    localStorage.setItem("gossamr-prefs", JSON.stringify({ permissionExplainerSeen: "yes" }));
    expect(loadPrefs().permissionExplainerSeen).toBe(false);
  });
});
