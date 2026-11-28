export const ranges = [
  { id: "month", label: "This month" },
  { id: "30d", label: "Last 30 days" },
] as const;

export type Range = (typeof ranges)[number]["id"];

/** Start of the requested range. For `"month"`, prefers the server's `monthStart` so Costs matches Budget across time zones. */
export const rangeStart = (range: Range, now: number, monthStart?: number) => {
  if (range === "30d") return now - 30 * 86_400_000;
  if (monthStart !== undefined) return monthStart;
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), 1).getTime();
};

/** Returns a valid `{ from, to }` window (`from < to`) even if the browser clock trails the server at a month boundary. */
export function usageWindow(range: Range, now: number, monthStart?: number): { from: number; to: number } {
  const from = rangeStart(range, now, monthStart);
  return { from, to: Math.max(now, from + 1) };
}
