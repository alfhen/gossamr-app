import { useEffect, useState } from "react";

/** Re-renders now and then so ages and the quiet chip move without a refresh, and counts of quiet runs with them. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
