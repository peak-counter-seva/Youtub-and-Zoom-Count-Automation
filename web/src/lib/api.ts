import {
  addDoc, collection, deleteDoc, doc, getDoc, serverTimestamp, setDoc,
  Timestamp, updateDoc, arrayUnion,
} from "firebase/firestore";
import { db } from "./firebase";
import { renderTemplate, runValues, type Automation, type Run } from "./types";
import { computeWindow } from "./time";

export async function saveAutomation(a: Automation, email: string, before?: Automation) {
  const { id, ...data } = a;
  // Remember when the Zoom passcode was set, for the weekly reminder.
  const z = before?.zoom;
  if (!z || z.passcode !== a.zoom.passcode || z.passcodeDay !== a.zoom.passcodeDay || !a.zoom.passcodeChangedAt)
    data.zoom = { ...data.zoom, passcodeChangedAt: Timestamp.now() };
  if (data.zoom.passcodeDay === undefined) delete data.zoom.passcodeDay;
  const payload = { ...data, createdBy: data.createdBy || email, updatedAt: serverTimestamp() };
  if (id) {
    await setDoc(doc(db, "automations", id), payload);
    return id;
  }
  const ref = await addDoc(collection(db, "automations"), payload);
  return ref.id;
}

export async function deleteAutomation(id: string) {
  await deleteDoc(doc(db, "automations", id));
}

interface GithubConfig { token: string; owner: string; repo: string; workflow: string; ref?: string }

async function dispatchGithub(runId: string) {
  const snap = await getDoc(doc(db, "config", "github"));
  if (!snap.exists()) throw new Error("GitHub settings are missing. An admin must fill them in Settings.");
  const g = snap.data() as GithubConfig;
  const res = await fetch(
    `https://api.github.com/repos/${g.owner}/${g.repo}/actions/workflows/${g.workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${g.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: g.ref || "main", inputs: { run_id: runId } }),
    },
  );
  if (!res.ok) throw new Error(`GitHub refused to start the counter (${res.status}): ${await res.text()}`);
}

export async function startRun(a: Automation, email: string): Promise<string> {
  const { start, end } = computeWindow(a.startTime, a.endTime);
  const { id, ...config } = a;
  const ref = await addDoc(collection(db, "runs"), {
    automationId: id,
    automationName: a.name,
    config,
    status: "queued",
    requestedBy: email,
    createdAt: serverTimestamp(),
    startAt: Timestamp.fromDate(start),
    endAt: Timestamp.fromDate(end),
    peaks: {},
    log: [],
  } satisfies Omit<Run, "id" | "createdAt"> & { createdAt: unknown });
  try {
    await dispatchGithub(ref.id);
  } catch (e) {
    await updateDoc(ref, { log: [`Could not start GitHub counter: ${(e as Error).message}. Phone backup will count YouTube.`] });
    throw e;
  }
  return ref.id;
}

export async function stopRun(runId: string) {
  await updateDoc(doc(db, "runs", runId), { stopRequested: true });
}

export async function resendSms(run: Run) {
  if (!run.smsText) return;
  await addDoc(collection(db, "smsJobs"), {
    runId: run.id,
    deviceId: run.config.sms.senderDeviceId,
    to: run.config.sms.to,
    text: run.smsText,
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

const clock = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });

/** Type in a peak by hand (e.g. Zoom blocked the counter). Re-writes the SMS text if the run already finished. */
export async function setManualPeak(run: Run, key: string, value: number, email: string) {
  const label = run.peaks?.[key]?.label ?? key;
  const upd: Record<string, unknown> = {
    [`peaks.${key}.peak`]: value,
    [`peaks.${key}.peakAt`]: serverTimestamp(),
    [`peaks.${key}.manualBy`]: email,
    [`peaks.${key}.label`]: label,
    log: arrayUnion(`${clock()} ${email} set ${key} = ${value} by hand`),
  };
  if (run.smsText) {
    const peaks = { ...run.peaks, [key]: { ...(run.peaks?.[key] ?? { label, current: null, peakAt: null, lastAt: null }), peak: value } };
    upd.smsText = renderTemplate(run.config.sms.template, runValues({ ...run, peaks }));
  }
  await updateDoc(doc(db, "runs", run.id), upd);
}

/** Note the highest counts from now for the next `minutes` (e.g. Aarti). Shown on the run and in {moments}. */
export async function markMoment(run: Run, label: string, minutes: number, email: string) {
  const n = (run.extraMoments?.length ?? 0) + 1;
  const start = new Date();
  await updateDoc(doc(db, "runs", run.id), {
    extraMoments: arrayUnion({
      key: `mark${n}`,
      label: label.trim() || `Moment ${n}`,
      startAt: Timestamp.fromDate(start),
      endAt: Timestamp.fromDate(new Date(start.getTime() + minutes * 60000)),
      by: email,
    }),
    log: arrayUnion(`${clock()} ${email} marked “${label.trim() || `Moment ${n}`}” for ${minutes} min`),
  });
}

/** Send an SMS now from the run's sender phone, while counting goes on. */
export async function sendNow(run: Run, text: string, email: string) {
  await addDoc(collection(db, "smsJobs"), {
    deviceId: run.config.sms.senderDeviceId,
    to: run.config.sms.to,
    text,
    status: "pending",
    requestedBy: email,
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "runs", run.id), { log: arrayUnion(`${clock()} ${email} sent an SMS now: ${text}`) });
}
