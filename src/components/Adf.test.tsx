import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdfNode } from "../types";
import { Adf, dateOf, MediaContext } from "./Adf";

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

  it("keeps merged table cells", () => {
    const cell = (type: string, attrs = {}): AdfNode => ({ type, attrs, content: [p(text("x"))] });
    const out = html(doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", { colspan: 2 }), cell("tableCell", { rowspan: 1 })] }] }));
    expect(out).toMatch(/<th colspan="2"/i);
    expect(out).not.toMatch(/rowspan/i);
  });

  it("reads date timestamps in seconds or milliseconds", () => {
    expect(dateOf("1582152559")?.toISOString()).toBe("2020-02-19T22:49:19.000Z");
    expect(dateOf("1582070400000")?.toISOString()).toBe("2020-02-19T00:00:00.000Z");
    expect(dateOf("nope")).toBeNull();
  });

  it("renders headings as headings below the page's own", () => {
    expect(html(doc({ type: "heading", attrs: { level: 1 }, content: [text("Plan")] }))).toMatch(/<h4[^>]*>Plan<\/h4>/);
    expect(html(doc({ type: "heading", attrs: { level: 6 }, content: [text("Fine print")] }))).toMatch(/<h6/);
  });

  it("shows link cards from their url or their data", () => {
    expect(html(doc(p({ type: "inlineCard", attrs: { url: "https://example.com/a" } })))).toContain('href="https://example.com/a"');
    const fromData = html(doc(p({ type: "inlineCard", attrs: { data: { url: "https://example.com/b", name: "Spec" } } })));
    expect(fromData).toMatch(/href="https:\/\/example.com\/b"[^>]*>Spec</);
    expect(html(doc(p({ type: "inlineCard", attrs: {} })))).toContain("[Link]");
  });

  it("keeps a list that starts at zero", () => {
    const list = (order: unknown): AdfNode => ({ type: "orderedList", attrs: { order }, content: [{ type: "listItem", content: [p(text("x"))] }] });
    expect(html(doc(list(0)))).toContain('start="0"');
    expect(html(doc(list("nope")))).toContain('start="1"');
  });

  it("colours status lozenges, defaulting to neutral", () => {
    expect(html(doc(p({ type: "status", attrs: { text: "Live", color: "green" } })))).toContain("bg-done-bg");
    expect(html(doc(p({ type: "status", attrs: { text: "?", color: "chartreuse" } })))).toContain("bg-todo-bg");
  });
});
