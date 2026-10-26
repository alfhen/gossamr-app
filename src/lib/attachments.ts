/** Files on a paste or drop. WebKit exposes a pasted screenshot through `items` only, so read both. */
export function filesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length) return files;
  return [...data.items].flatMap((i) => (i.kind === "file" ? [i.getAsFile()].filter((f): f is File => !!f) : []));
}
