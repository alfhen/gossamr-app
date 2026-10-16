import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { useWorkspace } from "../workspaceStore";
import { PipHome } from "./PipHome";
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

describe("Pip home's orientation card", () => {
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
    expect(ORIENTATION_SAFETY).toBe("Gossamr posts only what you approve; a Build runs with your Claude settings and could reach Jira or GitHub on its own. On GitHub, a Build runs as you: when Pushing is ticked its prompt asks it to push only its own branch to a draft pull request. That is a request, not a lock; see Agent safety.");
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

  it("keeps to its one line while Plan my week is open, even when More was opened", () => {
    expect(renderToStaticMarkup(<PipOrientation open />)).toContain("Worktree");
    const compact = renderToStaticMarkup(<PipOrientation open compact />);
    expect(compact).not.toContain("<dl");
    expect(compact).toMatch(/aria-expanded="false"[^>]*>What the words mean</);
  });

  it("takes no focus on load: nothing in it asks for it", () => {
    expect(renderToStaticMarkup(<PipOrientation />)).not.toMatch(/autofocus|tabindex/i);
  });

  it("shows on Pip home until dismissed, and Got it keeps it dismissed across a reload", () => {
    expect(usePrefs.getState().pipOrientationSeen).toBe(false);
    expect(renderToStaticMarkup(<PipHome />)).toContain("data-pip-orientation");

    // The button's own handler: it asks the stored preference, as the Agents intro's does.
    dismissOrientation();

    expect(usePrefs.getState().pipOrientationSeen).toBe(true);
    expect(loadPrefs().pipOrientationSeen).toBe(true);
    // A static render reads the store's initial state, so a reload is shown by loading the stored prefs into it.
    Object.assign(usePrefs.getInitialState(), loadPrefs());
    const html = renderToStaticMarkup(<PipHome />);
    expect(html).not.toContain("data-pip-orientation");
    // The rest of Pip home and its footer hints are as they were.
    expect(html).toContain('aria-label="Workstreams"');
    expect(html).toContain("data-pip-home-hints");
  });

  it("starts unseen for a profile with nothing stored, and stays seen when stored so", () => {
    expect(loadPrefs().pipOrientationSeen).toBe(false);
    localStorage.setItem("gossamr-prefs", JSON.stringify({ pipOrientationSeen: true }));
    expect(loadPrefs().pipOrientationSeen).toBe(true);
    localStorage.setItem("gossamr-prefs", JSON.stringify({ pipOrientationSeen: "yes" }));
    expect(loadPrefs().pipOrientationSeen).toBe(false);
  });
});
