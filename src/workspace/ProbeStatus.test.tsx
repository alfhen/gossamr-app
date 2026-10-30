import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { githubSnapshot } from "../backend/mockProbes";
import { ProbeStatus, probeTone } from "./ProbeStatus";

const NOW = new Date("2026-10-30T12:00:00Z");
const checked = "2026-10-30T11:57:00Z";

describe("a connection's probe status", () => {
  it("says what was found and when, with a way to look again", () => {
    const out = renderToStaticMarkup(<ProbeStatus status={githubSnapshot("ready", "ada", checked)} now={NOW} />);
    expect(out).toContain("Signed in as ada on github.com");
    expect(out).toContain("Checked 3m ago");
    expect(out).toContain("Check again");
    expect(out).not.toContain("Run ");
  });

  it("names the command that fixes it", () => {
    const out = renderToStaticMarkup(<ProbeStatus status={githubSnapshot("notFound", "ada", checked)} now={NOW} />);
    expect(out).toContain("gh isn&#x27;t installed.");
    expect(out).toContain("brew install gh");
    expect(out).toContain('data-probe="notFound"');
  });

  it("speaks only when something is wrong", () => {
    const role = (state: Parameters<typeof githubSnapshot>[0]) => renderToStaticMarkup(<ProbeStatus status={githubSnapshot(state, "ada", checked)} now={NOW} />).includes('role="status"');
    expect([role("ready"), role("off"), role("notSignedIn"), role("error")]).toEqual([false, false, true, true]);
  });

  it("never raises an alarm for a tool the connection doesn't depend on yet", () => {
    const out = renderToStaticMarkup(<ProbeStatus status={githubSnapshot("notFound", "ada", checked)} now={NOW} advisory />);
    expect(out).not.toContain('role="status"');
    expect(out).toContain("brew install gh");
    expect(["ready", "off", "error", "notSignedIn", "notFound"].map((state) => probeTone({ state: state as never }, true))).toEqual(["ok", "ok", "unsure", "unsure", "unsure"]);
  });

  it("lets the command be selected, for pasting into a terminal", () => {
    expect(renderToStaticMarkup(<ProbeStatus status={githubSnapshot("notFound", "ada", checked)} now={NOW} />)).toContain('class="selectable ');
  });

  it("treats a probe that couldn't tell as less alarming than one that found no login", () => {
    expect(["ready", "off", "error", "notSignedIn", "notFound"].map((state) => probeTone({ state: state as never }))).toEqual(["ok", "ok", "unsure", "error", "error"]);
  });
});
