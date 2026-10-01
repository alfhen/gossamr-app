export const MAX_ANSWER = 4000;

/** Why `text` can't be sent as an answer, by the backend's own rule: after trimming, 1 to 4,000 characters and no NUL. */
export function answerProblem(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "Write an answer first.";
  if (trimmed.includes("\0") || [...trimmed].length > MAX_ANSWER) return `An answer can be up to ${MAX_ANSWER} characters of plain text.`;
  return null;
}
