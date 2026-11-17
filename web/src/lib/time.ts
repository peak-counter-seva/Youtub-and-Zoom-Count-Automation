// All automation times are in India time (Asia/Kolkata, UTC+05:30, no DST).
const IST_OFFSET_MIN = 330;

function istParts(d: Date) {
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth(), day: ist.getUTCDate() };
}

function istDate(y: number, m: number, day: number, hhmm: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m, day, hh, mm) - IST_OFFSET_MIN * 60000);
}

/** Today's run window. If the end time has already passed today, use tomorrow's window. */
export function computeWindow(startTime: string, endTime: string, now = new Date()) {
  const { y, m, day } = istParts(now);
  let start = istDate(y, m, day, startTime);
  let end = istDate(y, m, day, endTime);
  if (end <= start) end = new Date(end.getTime() + 86400000);
  if (end <= now) {
    start = new Date(start.getTime() + 86400000);
    end = new Date(end.getTime() + 86400000);
  }
  return { start, end };
}

export function fmtIST(d: Date | null | undefined): string {
  if (!d) return "-";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "19:05" in India time. */
export function fmtTimeIST(d: Date | null | undefined): string {
  if (!d) return "–";
  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}

/** "Today", "Tomorrow", "Yesterday" or "17 Nov" in India time. */
export function fmtDayIST(d: Date | null | undefined, now = new Date()): string {
  if (!d) return "–";
  const key = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const diff = Math.round((Date.parse(key(d)) - Date.parse(key(now))) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
}
