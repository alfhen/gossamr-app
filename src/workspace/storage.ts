export function readStored(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full quotas make persistence best effort.
  }
}
