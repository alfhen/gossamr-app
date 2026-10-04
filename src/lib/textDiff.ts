export type DiffLine = { kind: "same" | "add" | "del"; text: string };
export type DiffRow = DiffLine | { kind: "gap"; count: number };

/** Longest-common-subsequence diff by line, so a changed paragraph shows as the old lines removed and the new ones added. */
export function diffLines(from: string, to: string): DiffLine[] {
  const a = from === "" ? [] : from.split("\n");
  const b = to === "" ? [] : to.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const width = y.length + 1;
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ kind: "same", text: x[i] });
      i++;
      j++;
    } else if (i < x.length && (j === y.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      out.push({ kind: "del", text: x[i++] });
    } else {
      out.push({ kind: "add", text: y[j++] });
    }
  }
  return out.concat(a.slice(a.length - tail).map((text) => ({ kind: "same" as const, text })));
}

/** Keeps `context` unchanged lines beside each change and folds a longer stretch of the rest into one gap row. */
export function withGaps(lines: DiffLine[], context = 2): DiffRow[] {
  const near = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = true;
  });
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (near[i]) {
      rows.push(lines[i++]);
      continue;
    }
    let end = i;
    while (end < lines.length && !near[end]) end++;
    if (end - i > 2) rows.push({ kind: "gap", count: end - i });
    else rows.push(...lines.slice(i, end));
    i = end;
  }
  return rows;
}

export const changedLines = (lines: DiffLine[]) => lines.filter((l) => l.kind !== "same").length;
