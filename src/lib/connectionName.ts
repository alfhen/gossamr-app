export const NAME_LIMIT = 60;

/** Why `name` can't be a connection's display name, in words for the person, or null when it can. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the connection a name.";
  if ([...trimmed].length > NAME_LIMIT) return `Use ${NAME_LIMIT} characters or fewer.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return "A name can't hold line breaks or other control characters.";
  return null;
}
