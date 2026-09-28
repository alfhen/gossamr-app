import { describe, expect, it } from "vitest";
import { activeQuery, autoLink, insertMention, liveMentions, rankPeople, segments } from "./mentions";

const sam = { accountId: "s", name: "Sam Holt" };
const mette = { accountId: "m", name: "Mette Lund" };
const soren = { accountId: "o", name: "Søren Ødegård" };
const sam2 = { accountId: "s2", name: "Sam Berg" };

describe("activeQuery", () => {
  it("finds the mention being typed at the caret", () => {
    expect(activeQuery("hi @me", 6)).toEqual({ start: 3, query: "me" });
    expect(activeQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeQuery("ping @Mette L", 13)).toEqual({ start: 5, query: "Mette L" });
    expect(activeQuery("(@sa", 4)).toEqual({ start: 1, query: "sa" });
  });

  it("ignores email addresses, finished mentions and text after the caret", () => {
    expect(activeQuery("mail me@x.com", 13)).toBeNull();
    expect(activeQuery("@Sam Holt thanks", 16)).toBeNull();
    expect(activeQuery("hi @me later", 3)).toBeNull();
  });
});

describe("rankPeople", () => {
  it("matches first, last or full name, ignoring case and accents, without duplicates", () => {
    expect(rankPeople([sam, mette, soren, sam], "l")).toEqual([mette]);
    expect(rankPeople([sam, mette, soren], "HO")).toEqual([sam]);
    expect(rankPeople([sam, mette, soren], "soren od")).toEqual([soren]);
    expect(rankPeople([sam, mette, sam], "")).toEqual([sam, mette]);
  });
});

describe("insertMention", () => {
  it("replaces the query with the full name and moves the caret after it", () => {
    const text = "thanks @me see above";
    const r = insertMention(text, { start: 7, query: "me" }, 10, mette);
    expect(r.text).toBe("thanks @Mette Lund see above");
    expect(r.text.slice(0, r.caret)).toBe("thanks @Mette Lund ");
  });
});

describe("segments and liveMentions", () => {
  it("highlights only whole names of known mentions", () => {
    const s = segments("@Sam Holt and @Sam Holtz, cc @Mette Lund.", [sam, mette]);
    expect(s.filter((x) => x.mention).map((x) => x.text)).toEqual(["@Sam Holt", "@Mette Lund"]);
    expect(s.map((x) => x.text).join("")).toBe("@Sam Holt and @Sam Holtz, cc @Mette Lund.");
  });

  it("drops mentions whose name was edited away", () => {
    expect(liveMentions("@Sam Holt hi", [sam, mette])).toEqual([sam]);
    expect(liveMentions("@Sam Hol hi", [sam])).toEqual([]);
    expect(liveMentions("@Sam Holt_2 hi", [sam])).toEqual([]);
  });

  it("ignores @ inside a word, like an email address", () => {
    expect(liveMentions("mail team@Sam Holt", [sam])).toEqual([]);
    expect(liveMentions("(@Sam Holt)", [sam])).toEqual([sam]);
  });
});

describe("autoLink", () => {
  it("links full names and unambiguous first names", () => {
    const r = autoLink("@Mette yes. @Sam Holt can you check?", [sam, mette]);
    expect(r.text).toBe("@Mette Lund yes. @Sam Holt can you check?");
    expect(r.mentions.map((m) => m.accountId).sort()).toEqual(["m", "s"]);
  });

  it("doesn't expand a first name that continues with _", () => {
    expect(autoLink("@Sam_2 is the test account", [sam])).toEqual({ text: "@Sam_2 is the test account", mentions: [] });
  });

  it("leaves ambiguous first names alone", () => {
    const r = autoLink("@Sam any news?", [sam, sam2]);
    expect(r).toEqual({ text: "@Sam any news?", mentions: [] });
  });

  it("leaves full names two people share alone", () => {
    const twin = { accountId: "s3", name: "Sam Holt" };
    expect(autoLink("@Sam Holt any news?", [sam, twin]).mentions).toEqual([]);
  });
});
