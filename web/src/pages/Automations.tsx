import { useState } from "react";
import { deleteAutomation, saveAutomation, startRun } from "../lib/api";
import { useCollection } from "../lib/hooks";
import { computeWindow, fmtIST } from "../lib/time";
import {
  renderTemplate, TEMPLATE_HELP,
  type Automation, type Device, type YoutubeSource,
} from "../lib/types";

const blank = (email: string): Automation => ({
  id: "",
  name: "",
  startTime: "19:00",
  endTime: "21:00",
  pollSeconds: 20,
  youtube: [{ key: "yt1", label: "YouTube 1", url: "", mode: "event" }],
  zoom: { enabled: true, key: "zoom", label: "Zoom", link: "", passcode: "", displayName: "Count" },
  sms: { senderDeviceId: "", to: "", template: "{name} {date}: YT {yt1}, Zoom {zoom}" },
  createdBy: email,
});

export default function Automations({ email, onStarted }: { email: string; onStarted: () => void }) {
  const { items, error } = useCollection<Automation>("automations");
  const [editing, setEditing] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (editing)
    return <Editor value={editing} email={email} onDone={() => setEditing(null)} />;

  async function start(a: Automation) {
    const { start, end } = computeWindow(a.startTime, a.endTime);
    if (!confirm(`Start "${a.name}"?\nCounts from ${fmtIST(start)} to ${fmtIST(end)}, then sends the SMS.`)) return;
    setBusy(a.id);
    setMsg(null);
    try {
      await startRun(a, email);
      onStarted();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="row between">
        <h2>Automations</h2>
        <button className="primary" onClick={() => setEditing(blank(email))}>+ New</button>
      </div>
      {error && <p className="error">{error}</p>}
      {msg && <p className="error">{msg}</p>}
      {items.length === 0 && <p className="muted">No automations yet. Tap “+ New” to make one.</p>}
      {items.map((a) => (
        <div className="card" key={a.id}>
          <div className="row between">
            <div>
              <h3>{a.name || "Untitled"}</h3>
              <div className="muted small">
                {a.startTime}–{a.endTime} IST · {a.youtube.length} YouTube
                {a.zoom.enabled ? " · Zoom" : ""} · SMS to {a.sms.to || "?"}
              </div>
            </div>
          </div>
          <div className="row">
            <button className="primary" disabled={busy === a.id} onClick={() => start(a)}>
              {busy === a.id ? "Starting…" : "▶ Start"}
            </button>
            <button onClick={() => setEditing(a)}>Edit</button>
            <button onClick={() => setEditing({ ...a, id: "", name: a.name + " (copy)" })}>Copy</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Editor({ value, email, onDone }: { value: Automation; email: string; onDone: () => void }) {
  const [a, setA] = useState<Automation>(structuredClone(value));
  const { items: devices } = useCollection<Device>("devices");
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<Automation>) => setA({ ...a, ...patch });
  const setYt = (i: number, patch: Partial<YoutubeSource>) =>
    set({ youtube: a.youtube.map((y, j) => (j === i ? { ...y, ...patch } : y)) });

  const sample: Record<string, string | number> = { name: a.name, date: new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) };
  a.youtube.forEach((y, i) => (sample[y.key] = 1000 + i * 111));
  if (a.zoom.enabled) sample[a.zoom.key] = 250;

  async function save() {
    const keys = [...a.youtube.map((y) => y.key), ...(a.zoom.enabled ? [a.zoom.key] : [])];
    if (!a.name.trim()) return setErr("Give the automation a name.");
    if (new Set(keys).size !== keys.length) return setErr("Each source needs a different key.");
    if (keys.some((k) => !/^\w+$/.test(k))) return setErr("Keys can use only letters, numbers and _.");
    if (a.youtube.some((y) => !y.url.trim())) return setErr("Every YouTube row needs a link.");
    if (a.youtube.some((y) => y.mode === "window" && (!y.windowStart || !y.windowEnd)))
      return setErr("24/7 streams need a from and to time.");
    if (a.zoom.enabled && !a.zoom.link.trim()) return setErr("Add the Zoom link or turn Zoom off.");
    if (!a.sms.to.trim()) return setErr("Add the destination phone number.");
    try {
      await saveAutomation(a, email);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function remove() {
    if (a.id && confirm(`Delete "${a.name}"?`)) {
      await deleteAutomation(a.id);
      onDone();
    }
  }

  return (
    <div>
      <div className="row between">
        <h2>{a.id ? "Edit automation" : "New automation"}</h2>
        <button className="link" onClick={onDone}>Cancel</button>
      </div>

      <div className="card">
        <label>Name<input value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="Satsang daily" /></label>
        <div className="row">
          <label>Start (IST)<input type="time" value={a.startTime} onChange={(e) => set({ startTime: e.target.value })} /></label>
          <label>End (IST)<input type="time" value={a.endTime} onChange={(e) => set({ endTime: e.target.value })} /></label>
          <label>Check every (sec)<input type="number" min={10} max={120} value={a.pollSeconds} onChange={(e) => set({ pollSeconds: Number(e.target.value) || 20 })} /></label>
        </div>
        <p className="muted small">If the end time is earlier than the start, it ends the next day.</p>
      </div>

      <h3>YouTube streams</h3>
      {a.youtube.map((y, i) => (
        <div className="card" key={i}>
          <div className="row">
            <label className="narrow">Key<input value={y.key} onChange={(e) => setYt(i, { key: e.target.value })} /></label>
            <label>Label<input value={y.label} onChange={(e) => setYt(i, { label: e.target.value })} /></label>
          </div>
          <label>Link<input value={y.url} onChange={(e) => setYt(i, { url: e.target.value })} placeholder="https://www.youtube.com/watch?v=… or /live/…" /></label>
          <div className="row">
            <label>Type
              <select value={y.mode} onChange={(e) => setYt(i, { mode: e.target.value as YoutubeSource["mode"] })}>
                <option value="event">Live event (count from when it starts)</option>
                <option value="window">24/7 stream (count only in a time window)</option>
              </select>
            </label>
            {y.mode === "window" && (
              <>
                <label className="narrow">From<input type="time" value={y.windowStart ?? ""} onChange={(e) => setYt(i, { windowStart: e.target.value })} /></label>
                <label className="narrow">To<input type="time" value={y.windowEnd ?? ""} onChange={(e) => setYt(i, { windowEnd: e.target.value })} /></label>
              </>
            )}
          </div>
          <button className="link danger" onClick={() => set({ youtube: a.youtube.filter((_, j) => j !== i) })}>Remove stream</button>
        </div>
      ))}
      <button onClick={() => set({ youtube: [...a.youtube, { key: `yt${a.youtube.length + 1}`, label: `YouTube ${a.youtube.length + 1}`, url: "", mode: "event" }] })}>
        + Add YouTube stream
      </button>

      <h3>Zoom meeting</h3>
      <div className="card">
        <label className="check"><input type="checkbox" checked={a.zoom.enabled} onChange={(e) => set({ zoom: { ...a.zoom, enabled: e.target.checked } })} /> Count this Zoom meeting</label>
        {a.zoom.enabled && (
          <>
            <div className="row">
              <label className="narrow">Key<input value={a.zoom.key} onChange={(e) => set({ zoom: { ...a.zoom, key: e.target.value } })} /></label>
              <label>Join as name<input value={a.zoom.displayName} onChange={(e) => set({ zoom: { ...a.zoom, displayName: e.target.value } })} /></label>
            </div>
            <label>Invite link<input value={a.zoom.link} onChange={(e) => set({ zoom: { ...a.zoom, link: e.target.value } })} placeholder="https://us06web.zoom.us/j/123…?pwd=…" /></label>
            <label>Passcode (if not in link)<input value={a.zoom.passcode ?? ""} onChange={(e) => set({ zoom: { ...a.zoom, passcode: e.target.value } })} /></label>
            <p className="muted small">The counter joins as this name, muted with camera off, and does not count itself.</p>
          </>
        )}
      </div>

      <h3>SMS</h3>
      <div className="card">
        <label>Send from phone
          <select value={a.sms.senderDeviceId} onChange={(e) => set({ sms: { ...a.sms, senderDeviceId: e.target.value } })}>
            <option value="">Choose a phone…</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.label} ({d.ownerEmail})</option>)}
          </select>
        </label>
        {devices.length === 0 && <p className="muted small">No phones yet. Install the Peak Counter phone app and sign in; it will appear here.</p>}
        <label>Send to number<input type="tel" value={a.sms.to} onChange={(e) => set({ sms: { ...a.sms, to: e.target.value } })} placeholder="+91…" /></label>
        <label>Message format<textarea rows={3} value={a.sms.template} onChange={(e) => set({ sms: { ...a.sms, template: e.target.value } })} /></label>
        <p className="muted small">{TEMPLATE_HELP}</p>
        <p className="preview">Preview: {renderTemplate(a.sms.template, sample)}</p>
      </div>

      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="primary" onClick={save}>Save</button>
        <button onClick={onDone}>Cancel</button>
        {a.id && <button className="danger" onClick={remove}>Delete</button>}
      </div>
    </div>
  );
}
