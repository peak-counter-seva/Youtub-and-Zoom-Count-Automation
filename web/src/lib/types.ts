import type { Timestamp } from "firebase/firestore";

export type StreamMode = "event" | "window";

export interface YoutubeSource {
  key: string; // used in the SMS template, e.g. yt1
  label: string;
  url: string;
  mode: StreamMode; // event = count from when it goes live; window = 24/7, count only in window
  windowStart?: string; // "HH:MM" (Asia/Kolkata), window mode only
  windowEnd?: string;
  pollSeconds?: number; // how often to check this stream; default = automation pollSeconds
}

/** A sum of several sources, e.g. all YouTube streams. Used in the SMS as {key}. */
export interface TotalGroup {
  key: string;
  label: string;
  sources: string[]; // source keys
}

/** A fixed moment to note peaks for, e.g. Aarti at 06:00 for 30 minutes. */
export interface Moment {
  key: string; // SMS prefix, e.g. aarti → {aarti.yt1}, {aarti.total}
  label: string;
  at: string; // "HH:MM" IST
  minutes: number;
}

export interface ZoomSource {
  enabled: boolean;
  key: string; // e.g. zoom
  label: string;
  link: string; // full invite link, may include ?pwd=
  passcode?: string;
  displayName: string; // name the counting guest joins with
  via?: "both" | "phone" | "github"; // who joins to count (default phone)
  passcodeDay?: number; // weekday the host changes the passcode, 0 = Sunday … 6 = Saturday
  passcodeChangedAt?: Timestamp; // when the passcode was last saved
}

export interface Automation {
  id: string;
  name: string;
  startTime: string; // "HH:MM" Asia/Kolkata
  endTime: string; // "HH:MM"; earlier than start means next day
  pollSeconds: number; // YouTube check interval
  saveStep?: number; // save only when a count moves by at least this much (default 5)
  youtube: YoutubeSource[];
  zoom: ZoomSource;
  totals?: TotalGroup[];
  moments?: Moment[];
  sms: {
    senderDeviceId: string;
    to: string;
    template: string;
  };
  createdBy: string;
  updatedAt?: Timestamp;
  linksUpdatedAt?: Timestamp; // last time the YouTube links were changed from the card
}

export type RunStatus = "queued" | "waiting" | "running" | "finished" | "failed" | "stopped";

export interface Peak {
  label: string;
  current: number | null;
  peak: number | null;
  peakAt: Timestamp | null;
  lastAt: Timestamp | null;
  note?: string;
  manualBy?: string; // email of the person who typed this peak in
}

/** A moment marked by hand from the Runs page while counting. */
export interface ExtraMoment {
  key: string;
  label: string;
  startAt: Timestamp;
  endAt: Timestamp;
  by?: string;
}

export interface MomentPeak {
  peak: number | null;
  peakAt: Timestamp | null;
}

export interface Run {
  id: string;
  automationId: string;
  automationName: string;
  config: Omit<Automation, "id">;
  status: RunStatus;
  requestedBy: string;
  createdAt: Timestamp;
  startAt: Timestamp;
  endAt: Timestamp;
  stopRequested?: boolean;
  engine?: string;
  heartbeatAt?: Timestamp;
  peaks?: Record<string, Peak>;
  extraMoments?: ExtraMoment[];
  momentPeaks?: Record<string, Record<string, MomentPeak>>; // moment key → source key → peak
  smsText?: string;
  smsStatus?: "pending" | "sent" | "failed";
  error?: string;
  log?: string[];
}

export interface Device {
  id: string;
  ownerEmail: string;
  label: string;
  lastSeen?: Timestamp;
}

/**
 * A stored time as a Date. Accepts a Firestore Timestamp and also a plain {seconds, nanoseconds}
 * map (what a copied Timestamp turns into), so old data saved that way can't break the page.
 */
export function asDate(x: unknown): Date | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
  if (typeof o.toDate === "function") return o.toDate();
  if (typeof o.seconds === "number") return new Date(o.seconds * 1000 + Math.floor((o.nanoseconds ?? 0) / 1e6));
  if (x instanceof Date) return x;
  return undefined;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Start (India time midnight) of the most recent passcode-change day, today included. */
export function lastPasscodeDay(day: number, now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_MS);
  const back = (ist.getUTCDay() - day + 7) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - back) - IST_MS);
}

/** True when the weekly passcode change day has come and the passcode wasn't updated since. */
export function passcodeDue(a: Pick<Automation, "zoom">, now = new Date()): boolean {
  const z = a.zoom;
  if (!z?.enabled || z.passcodeDay === undefined || z.passcodeDay === null) return false;
  const changed = asDate(z.passcodeChangedAt);
  return !changed || changed < lastPasscodeDay(z.passcodeDay, now);
}

export const DEFAULT_ZOOM_VIA = "phone" as const;

export interface Source { key: string; label: string }

/** Every counted source of an automation: YouTube streams, then Zoom. */
export function sourcesOf(cfg: Pick<Automation, "youtube" | "zoom">): Source[] {
  const out: Source[] = cfg.youtube.map((y) => ({ key: y.key, label: y.label || y.key }));
  if (cfg.zoom?.enabled) out.push({ key: cfg.zoom.key || "zoom", label: cfg.zoom.label || "Zoom" });
  return out;
}

export interface MomentWindow { key: string; label: string; start: Date; end: Date }

const IST_MS = 330 * 60000;

/** When a fixed moment happens in a run: on the run's start date (India time), or the next day if already over. */
export function momentWindow(runStart: Date, at: string, minutes: number): { start: Date; end: Date } {
  const ist = new Date(runStart.getTime() + IST_MS);
  const [hh, mm] = at.split(":").map(Number);
  let start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hh, mm) - IST_MS);
  let end = new Date(start.getTime() + Math.max(1, minutes || 30) * 60000);
  if (end <= runStart) {
    start = new Date(start.getTime() + 86400000);
    end = new Date(end.getTime() + 86400000);
  }
  return { start, end };
}

/** All moments of a run (fixed ones from the automation, then ones marked by hand), in time order. */
export function momentsOf(run: Pick<Run, "config" | "startAt" | "extraMoments">): MomentWindow[] {
  const out: MomentWindow[] = [];
  const runStart = run.startAt.toDate();
  for (const m of run.config.moments ?? []) {
    if (!m.key || !m.at) continue;
    out.push({ key: m.key, label: m.label || m.key, ...momentWindow(runStart, m.at, m.minutes) });
  }
  for (const m of run.extraMoments ?? []) out.push({ key: m.key, label: m.label || m.key, start: m.startAt.toDate(), end: m.endAt.toDate() });
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

function sum(vals: (number | null | undefined)[]): number | null {
  const nums = vals.filter((v): v is number => typeof v === "number");
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

/**
 * Every value the SMS can use. Keep in step with build_values in counter/main.py and
 * Values.kt in the phone app.
 *  {yt1} {zoom} … highest count of each source
 *  {total}         sum of all sources' highest counts
 *  {<group>}       sum of a custom total
 *  {<moment>.yt1}, {<moment>.total}, {<moment>.<group>}, {<moment>.time}  the same, within a moment
 *  {moments}       one line per moment with every source and the total
 */
export function buildValues(
  cfg: Pick<Automation, "youtube" | "zoom" | "totals">,
  base: { name: string; date: string },
  peaks: Record<string, { peak: number | null } | undefined>,
  moments: MomentWindow[] = [],
  momentPeaks: Record<string, Record<string, { peak: number | null } | undefined>> = {},
): Record<string, string | number> {
  const NA = "NA";
  const srcs = sourcesOf(cfg);
  const groups = (cfg.totals ?? []).filter((g) => g.key);
  const v: Record<string, string | number> = { name: base.name, date: base.date };
  const fill = (prefix: string, get: (k: string) => number | null | undefined) => {
    for (const s of srcs) v[prefix + s.key] = get(s.key) ?? NA;
    v[prefix + "total"] = sum(srcs.map((s) => get(s.key))) ?? NA;
    for (const g of groups) v[prefix + g.key] = sum(g.sources.map((k) => get(k))) ?? NA;
  };
  fill("", (k) => peaks[k]?.peak);
  const lines: string[] = [];
  for (const m of moments) {
    const mp = momentPeaks[m.key] ?? {};
    fill(m.key + ".", (k) => mp[k]?.peak);
    v[m.key + ".time"] = hhmm(m.start);
    const parts = srcs.map((s) => `${s.label} ${v[m.key + "." + s.key]}`);
    if (srcs.length > 1) parts.push(`Total ${v[m.key + ".total"]}`);
    lines.push(`${m.label} ${hhmm(m.start)}: ${parts.join(", ")}`);
  }
  v.moments = lines.join("\n");
  return v;
}

/** Values for a run, from what has been counted so far. */
export function runValues(run: Run): Record<string, string | number> {
  const date = run.startAt.toDate().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-");
  return buildValues(run.config, { name: run.automationName, date }, run.peaks ?? {}, momentsOf(run), run.momentPeaks ?? {});
}

export const TEMPLATE_HELP =
  "Fill-ins: {date}, {name}, and each source key such as {yt1}, {yt2}, {zoom}. Example: Satsang {date}: YT {yt1}, 24x7 {yt2}, Zoom {zoom}";

export function renderTemplate(
  template: string,
  values: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{([\w.]+)\}/g, (m, k: string) => {
    const v = values[k];
    return v === undefined || v === null ? m : String(v);
  });
}
