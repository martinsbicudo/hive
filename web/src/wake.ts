const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatWake(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const clock = CLOCK.format(date);
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (days <= 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  return `${WEEKDAY.format(date)} ${clock}`;
}

export function describeSchedule(kind: "daily" | "weekdays" | "interval", at: string | null, everyMinutes: number | null): string {
  if (kind === "interval") return everyMinutes !== null && everyMinutes % 60 === 0 ? `Every ${everyMinutes / 60} h` : `Every ${everyMinutes ?? "?"} min`;
  return `${kind === "daily" ? "Every day" : "Weekdays"} at ${at ?? "?"}`;
}
