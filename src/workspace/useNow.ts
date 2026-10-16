import { useEffect, useState } from "react";
import { dayKey } from "./activityLogic";

/** Re-renders now and then so ages and the quiet chip move without a refresh, and counts of quiet runs with them. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** How long from `now` until the next local midnight, in milliseconds. */
export const untilNextDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();

/** Today as a local day key ("2026-10-15"), moving on at the next local midnight, so day headings don't keep yesterday's "Today". */
export function useToday() {
  const [today, setToday] = useState(() => dayKey(new Date()));
  useEffect(() => {
    const id = setTimeout(() => setToday(dayKey(new Date())), untilNextDay(new Date()) + 50);
    return () => clearTimeout(id);
  }, [today]);
  return today;
}
