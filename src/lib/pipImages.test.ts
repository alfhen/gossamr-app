import { describe, expect, it } from "vitest";
import { defaultQuestion, fitWithin, MAX_SIDE, refusal, sniffImageType, TARGET_BYTES } from "./pipImages";

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

describe("sniffImageType", () => {
  const bytes = (...b: (number | string)[]) => new Uint8Array(b.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

  it("reads the type from the first bytes", () => {
    expect(sniffImageType(bytes(0x89, "PNG\r\n", 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(bytes("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(bytes("RIFF", 1, 2, 3, 4, "WEBPVP8 "))).toBe("image/webp");
  });

  it("says nothing for anything else", () => {
    expect(sniffImageType(bytes("<svg xmlns"))).toBeNull();
    expect(sniffImageType(bytes("RIFF", 1, 2, 3, 4, "WAVEfmt "))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("TARGET_BYTES", () => {
  it("keeps four base64-encoded images inside the backend's 20 MiB", () => {
    expect(Math.ceil((TARGET_BYTES * 4) / 3) * 4).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});
