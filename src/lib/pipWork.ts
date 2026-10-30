/** The words Pip works under, a few about silk. They carry mood only; the line under them says what Pip is doing. */
export const WORK_WORDS = ["Spinning", "Weaving", "Untangling", "Following a thread", "Tying a knot", "Mending the web", "Gathering dew", "Testing the silk", "Casting a line", "Reeling in"] as const;

export const WORD_EVERY_MS = 2600;

/** All the words in a random order that does not open with `previous`, so a word never repeats back to back. */
export function shuffledWords(previous: string | null, random: () => number = Math.random): string[] {
  const deck: string[] = [...WORK_WORDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  if (deck[0] === previous) deck.push(deck.shift()!);
  return deck;
}

/** The time so far: nothing before 5 s, then "12s" and "1m 05s". */
export function elapsedText(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
