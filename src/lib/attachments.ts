/** Files on a paste or drop. WebKit exposes a pasted screenshot through `items` only, so read both. */
export function filesIn(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length) return files;
  return [...data.items].flatMap((i) => (i.kind === "file" ? [i.getAsFile()].filter((f): f is File => !!f) : []));
}

/**
 * Pasted images arrive as "image.png"; give them a dated name so several in one ticket stay distinguishable.
 * Named files keep their name.
 */
export function nameFor(file: File, now = new Date()): File {
  if (file.name && !/^image\.\w+$/.test(file.name)) return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return new File([file], `Pasted image ${stamp}.${ext}`, { type: file.type });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
