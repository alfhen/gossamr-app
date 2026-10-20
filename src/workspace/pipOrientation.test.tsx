import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace } from "../workspaceStore";
import { WordsButton } from "./AgentsHome";
import { ORIENTATION_PURPOSE, ORIENTATION_SAFETY, ORIENTATION_WORDS, ORIENTATION_TERMS, PipOrientation, dismissOrientation } from "./PipOrientation";
import { loadPrefs, usePrefs } from "./prefs";
import { loadTabs, useTabs } from "./tabsStore";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  usePrefs.setState(loadPrefs());
  await useWorkspace.getState().init(new MockBackend({ runs: { seed: "empty" } }));
});

afterEach(() => {
  useWorkstreams.getState().dispose();
  usePrefs.setState({ pipOrientationSeen: false });
  Object.assign(usePrefs.getInitialState(), { pipOrientationSeen: false });
  vi.unstubAllGlobals();
});

describe("the orientation card", () => {
  it("explains Pip, a workstream, a run and a worktree, and says nothing is posted without a click", () => {
    const html = renderToStaticMarkup(<PipOrientation open />);
    expect(ORIENTATION_TERMS.map((t) => t.term)).toEqual(["Pip", "Workstream", "Run", "Cobweb", "Status", "Intake", "Triage", "Plan", "Build", "Review", "Pushing", "Held", "Quiet", "Idle", "Advise", "Manage", "Hold", "Allow once", "Decide", "Unblock", "Worktree"]);
    expect(html).toContain("One ticket&#x27;s work from start to pull request");
    expect(html).toContain("One Claude Code agent session doing a step: investigate, plan, build or review");
    expect(html).toContain("own checkout of your repository");
    expect(html).toContain("Work has happened but Jira has not heard for days. Post an update to clear it.");
    expect(html).toContain("Each workstream&#x27;s one word: Needs you, Held, Waiting on reporter, Running, Quiet, Done or Idle.");
    // The status words are not tab stops: the line says what the keyboard and a screen reader get, not "hover" alone (G14).
    expect(html).toContain("Each status word has a short explanation: hover it, or select its row and a screen reader reads it with the row.");
    expect(html).not.toContain("Hover a word");
    expect(html).toContain(ORIENTATION_SAFETY);
    expect(html).toContain(ORIENTATION_PURPOSE);
    expect(ORIENTATION_PURPOSE).toBe("Pip works through your Jira tickets with coding agents and drafts every Jira and GitHub write for you to read and approve; nothing posts until you do.");
    expect(ORIENTATION_SAFETY).toBe("Gossamr posts only what you approve; a Build runs with your Claude settings and could reach Jira or GitHub on its own. On GitHub, a Build runs as you. In a workstream or with Pushing ticked, it is asked to push only its branch to a draft pull request: a request, not a lock; see Agent safety.");
    expect(html).toMatch(/<button type="button"[^>]*>Got it<\/button>/);
  });

  it("is one line with a More button, and keeps the words behind it until it is opened", () => {
    const html = renderToStaticMarkup(<PipOrientation />);
    expect(html).toContain(ORIENTATION_SAFETY);
    expect(html).toMatch(/<button type="button"[^>]*aria-expanded="false"[^>]*>What the words mean<\/button>/);
    expect(ORIENTATION_WORDS).toBe("What the words mean");
    expect(html).toMatch(/<button type="button"[^>]*>Got it<\/button>/);
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("Worktree");
  });

  it("scrolls the words inside a named, focusable list, not the whole card (G8)", () => {
    const html = renderToStaticMarkup(<PipOrientation open />);
    const dl = html.match(/<dl[^>]*>/)![0];
    expect(dl).toContain('aria-label="What the words mean"');
    expect(dl).toContain('tabindex="0"');
    expect(dl).toMatch(/class="[^"]*max-h-\[18vh\][^"]*overflow-y-auto/);
    expect(html.match(/<section[^>]*>/)![0]).not.toMatch(/max-h|overflow/);
  });

  it("takes no focus on load: nothing in it asks for it", () => {
    expect(renderToStaticMarkup(<PipOrientation />)).not.toMatch(/autofocus|tabindex/i);
  });

  it("is on until dismissed, and Got it keeps it dismissed across a reload", () => {
    expect(usePrefs.getState().pipOrientationSeen).toBe(false);
    expect(renderToStaticMarkup(<WordsButton />)).toBe("");

    // The button's own handler: it asks the stored preference, as the Agents intro's does.
    dismissOrientation();

    expect(usePrefs.getState().pipOrientationSeen).toBe(true);
    expect(loadPrefs().pipOrientationSeen).toBe(true);
    // A static render reads the store's initial state, so a reload is shown by loading the stored prefs into it.
    Object.assign(usePrefs.getInitialState(), loadPrefs());
    // Dismissed, the words stay one button away on the Agents view.
    const html = renderToStaticMarkup(<WordsButton />);
    expect(html).toContain("data-orientation-link");
    expect(html).toContain("What the words mean");
  });

  it("starts unseen for a profile with nothing stored, and stays seen when stored so", () => {
    expect(loadPrefs().pipOrientationSeen).toBe(false);
    localStorage.setItem("gossamr-prefs", JSON.stringify({ pipOrientationSeen: true }));
    expect(loadPrefs().pipOrientationSeen).toBe(true);
    localStorage.setItem("gossamr-prefs", JSON.stringify({ pipOrientationSeen: "yes" }));
    expect(loadPrefs().pipOrientationSeen).toBe(false);
  });
});
