import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdfNode } from "../types";
import { Adf, MediaContext } from "./Adf";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", content });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const text = (t: string, ...marks: string[]): AdfNode => ({ type: "text", text: t, marks: marks.map((type) => ({ type })) });
const html = (d: AdfNode) => renderToStaticMarkup(<Adf doc={d} />);

describe("Adf", () => {
  it("keeps code blocks as preformatted code", () => {
    const out = html(doc({ type: "codeBlock", content: [text("User::firstOrCreate(\n  ['email' => $email],\n);")] }));
    expect(out).toContain("<pre");
    expect(out).toContain("User::firstOrCreate(\n  [&#x27;email&#x27; =&gt; $email],\n);");
  });

  it("renders inline marks", () => {
    const out = html(doc(p(text("bold", "strong"), text("code", "code"), text("gone", "strike"))));
    expect(out).toMatch(/<b[^>]*>bold<\/b>/);
    expect(out).toMatch(/<code[^>]*>code<\/code>/);
    expect(out).toContain("<s>gone</s>");
  });

  it("links only web and mail addresses", () => {
    const link = (href: string): AdfNode => ({ type: "text", text: "here", marks: [{ type: "link", attrs: { href } }] });
    expect(html(doc(p(link("https://example.com"))))).toContain('href="https://example.com"');
    expect(html(doc(p(link("javascript:alert(1)"))))).not.toContain("href");
  });

  it("shows mentions and falls back to the text of unknown nodes", () => {
    const out = html(doc(p({ type: "mention", attrs: { id: "1", text: "@Sam Holt" } }), { type: "somethingNew", content: [p(text("still here"))] }));
    expect(out).toContain("@Sam Holt");
    expect(out).toContain("still here");
  });

  it("shows embedded images it can find, and names the ones it can't", () => {
    const shot: AdfNode = { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", alt: "shot.png" } }] };
    const found = renderToStaticMarkup(
      <MediaContext.Provider value={() => ({ url: "attachment://localhost/10001", name: "shot.png", image: true })}>
        <Adf doc={doc(shot)} />
      </MediaContext.Provider>,
    );
    expect(found).toContain('src="attachment://localhost/10001"');
    expect(html(doc(shot))).toContain("📎 shot.png");
  });
});
