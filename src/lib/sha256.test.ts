import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it("matches the known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("agrees with Web Crypto for texts of every length around a block, and for non-ASCII", async () => {
    const texts = [...Array.from({ length: 140 }, (_, n) => "x".repeat(n)), "git commit -m \"æøå 日本語 🚀\"", "a\tb\n c"];
    for (const t of texts) {
      const real = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(sha256Hex(t), JSON.stringify(t)).toBe(real);
    }
  });
});
