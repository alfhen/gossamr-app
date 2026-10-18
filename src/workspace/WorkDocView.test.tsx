import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { docFromText } from "../lib/docs";
import { WorkDocView } from "./WorkDocView";

describe("WorkDocView", () => {
  it("shows an expand as a collapsed details with its title as the summary", () => {
    const html = renderToStaticMarkup(
      <WorkDocView doc={{ blocks: [{ type: "expand", title: "Gossamr Plan", content: docFromText("Step one").blocks }] }} />,
    );
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toMatch(/<summary[^>]*>Gossamr Plan<\/summary>/);
    expect(html).toContain("Step one");
  });
});
