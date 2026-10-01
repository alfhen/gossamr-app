import { describe, expect, it } from "vitest";
import { defaultQuestion, fitWithin, MAX_SIDE, refusal } from "./pipImages";

describe("fitWithin", () => {
  it("leaves small pictures alone and scales large ones so the longest side is 1568", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(MAX_SIDE, 10)).toEqual({ width: MAX_SIDE, height: 10 });
    expect(fitWithin(3136, 1568)).toEqual({ width: 1568, height: 784 });
    expect(fitWithin(1000, 4000)).toEqual({ width: 392, height: 1568 });
  });

  it("never collapses a thin picture to nothing", () => {
    expect(fitWithin(100000, 1)).toEqual({ width: 1568, height: 1 });
  });
});

describe("refusal", () => {
  it("accepts PNG, JPEG, GIF and WebP", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(refusal({ type, size: 10 })).toBeNull();
  });

  it("names what can't be attached", () => {
    expect(refusal({ type: "application/pdf", size: 10, name: "a.pdf" })).toContain("“a.pdf” isn't an image");
    expect(refusal({ type: "image/svg+xml", size: 10 })).toContain("PNG, JPEG, GIF or WebP");
    expect(refusal({ type: "image/png", size: 0 })).toContain("empty");
    expect(refusal({ type: "image/png", size: 31 * 1024 * 1024 })).toContain("too large");
  });
});

describe("defaultQuestion", () => {
  it("asks about one screenshot or several", () => {
    expect(defaultQuestion(1)).toBe("What is in this screenshot?");
    expect(defaultQuestion(2)).toBe("What is in these screenshots?");
  });
});
