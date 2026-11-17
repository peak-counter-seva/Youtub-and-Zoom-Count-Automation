import type { Timestamp } from "firebase/firestore";

export type StreamMode = "event" | "window";

export interface YoutubeSource {
  key: string; // used in the SMS template, e.g. yt1
  label: string;
  url: string;
  mode: StreamMode; // event = count from when it goes live; window = 24/7, count only in window
  windowStart?: string; // "HH:MM" (Asia/Kolkata), window mode only
  windowEnd?: string;
}

export interface ZoomSource {
  enabled: boolean;
  key: string; // e.g. zoom
  label: string;
  link: string; // full invite link, may include ?pwd=
  passcode?: string;
  displayName: string; // name the counting guest joins with
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
  sms: {
    senderDeviceId: string;
    to: string;
    template: string;
  };
  createdBy: string;
  updatedAt?: Timestamp;
}

export type RunStatus = "queued" | "waiting" | "running" | "finished" | "failed" | "stopped";

export interface Peak {
  label: string;
  current: number | null;
  peak: number | null;
  peakAt: Timestamp | null;
  lastAt: Timestamp | null;
  note?: string;
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

export const TEMPLATE_HELP =
  "Fill-ins: {date}, {name}, and each source key such as {yt1}, {yt2}, {zoom}. Example: Satsang {date}: YT {yt1}, 24x7 {yt2}, Zoom {zoom}";

export function renderTemplate(
  template: string,
  values: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = values[k];
    return v === undefined || v === null ? m : String(v);
  });
}
