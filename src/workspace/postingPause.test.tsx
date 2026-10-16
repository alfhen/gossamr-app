import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostingPause } from "./PostingPause";

const render = (anyway = "Post anyway") => renderToStaticMarkup(<PostingPause risks={["secret"]} quote={{ secret: ["hu…", "gh…"] }} anyway={anyway} onKeep={() => {}} onPost={() => {}} />);

describe("the posting pause (G26)", () => {
  it("keeps both choices in a group, Keep editing first and the only primary button, with the alert on the note alone (G14)", () => {
    const html = render();
    const alert = /<div role="group"[^>]*>([\s\S]*)<\/div>$/.exec(html)?.[1] ?? "";
    const id = /<p id="([^"]+)" role="alert"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${id}"`);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html.match(new RegExp(`aria-describedby="${id}"`, "g"))).toHaveLength(2);
    expect(alert).toContain("Keep editing");
    expect(alert).toContain("Post anyway");
    expect(alert.indexOf("Keep editing")).toBeLessThan(alert.indexOf("Post anyway"));
    const primary = [...html.matchAll(/<button[^>]*bg-ws-pip[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(primary).toEqual(["Keep editing"]);
    expect(html).toContain("data-post-pause-keep");
  });

  it("quotes every secret it found, masked, and names the choice a review posts with", () => {
    expect(render("Post it anyway")).toContain("like a password, key or token at “hu…” and “gh…”.");
    expect(render("Post it anyway")).toContain(">Post it anyway<");
  });
});
