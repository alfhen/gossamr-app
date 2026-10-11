/**
 * A span of `minutes` as a person reads it: "under a minute", "40 min" below two hours, "3 h" below two days, then
 * "10 days". Each unit is rounded down, so a run quiet for 247 hours reads "10 days", never "247 h".
 */
export function humanDuration(minutes: number): string {
  const m = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} min`;
  const hours = Math.floor(m / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
