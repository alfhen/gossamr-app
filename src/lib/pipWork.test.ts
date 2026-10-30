import { describe, expect, it } from "vitest";
import { WORK_WORDS, elapsedText, shuffledWords } from "./pipWork";

describe("Pip's working words", () => {
  it("a shuffle holds every word once", () => {
    expect([...shuffledWords(null)].sort()).toEqual([...WORK_WORDS].sort());
  });

  it("a shuffle never opens with the word just shown", () => {
    for (const word of WORK_WORDS) {
      for (const r of [0, 0.5, 0.99]) expect(shuffledWords(word, () => r)[0]).not.toBe(word);
    }
  });

  it("the time shows after 5 seconds, in seconds and then minutes", () => {
    expect(elapsedText(4999)).toBe("");
    expect(elapsedText(5000)).toBe("5s");
    expect(elapsedText(59_900)).toBe("59s");
    expect(elapsedText(65_000)).toBe("1m 05s");
  });
});
