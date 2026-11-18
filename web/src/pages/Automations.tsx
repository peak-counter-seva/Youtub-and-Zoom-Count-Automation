import { useRef, useState } from "react";
import { deleteAutomation, saveAutomation, startRun } from "../lib/api";
import { useCollection } from "../lib/hooks";
import { computeWindow, fmtDayIST, fmtTimeIST } from "../lib/time";
import {
  buildValues, DEFAULT_ZOOM_VIA, momentWindow, passcodeDue, WEEKDAYS, renderTemplate, sourcesOf,
  type Automation, type Device, type Moment, type TotalGroup, type YoutubeSource,
} from "../lib/types";
import { Empty, Field, Icon, Notice, Segmented, Switch, useUi } from "../components/ui";

const blank = (email: string): Automation => ({
  id: "",
  name: "",
  startTime: "19:00",
  endTime: "21:00",
  pollSeconds: 20,
  saveStep: 5,
  youtube: [{ key: "yt1", label: "YouTube 1", url: "", mode: "event" }],
  zoom: { enabled: true, key: "zoom", label: "Zoom", link: "", passcode: "", displayName: "Count", via: "phone" },
  totals: [],
  moments: [],
  sms: { senderDeviceId: "", to: "", template: "{name} {date}: YT {yt1}, Zoom {zoom}" },
  createdBy: email,
});

const POLL_CHOICES = [10, 15, 20, 30, 45, 60, 120, 300];
const fmtSecs = (s: number) => (s >= 60 && s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);

export default function Automations({ email, onStarted }: { email: string; onStarted: () => void }) {
  const { items, error } = useCollection<Automation>("automations");
  const { items: devices } = useCollection<Device>("devices");
  const { confirm, toast } = useUi();
  const [editing, setEditing] = useState<Automation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (editing)
    return <Editor value={editing} email={email} onDone={() => { setEditing(null); window.scrollTo(0, 0); }} />;

  async function startAutomation(a: Automation) {
    const { start, end } = computeWindow(a.startTime, a.endTime);
    const ok = await confirm({
      title: `Start “${a.name}”?`,
      body: `Counting runs ${fmtDayIST(start).toLowerCase()} from ${fmtTimeIST(start)} to ${fmtTimeIST(end)} IST. The SMS is sent when it ends.`,
      confirm: "Start",
    });
    if (!ok) return;
    setBusy(a.id);
    setMsg(null);
    try {
      await startRun(a, email);
      toast("Started. The counter will begin at the start time.");
      onStarted();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.label;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Automations</h1>
          <p>Saved setups you can start with one tap.</p>
        </div>
        {items.length > 0 && (
          <button className="btn btn-primary" onClick={() => setEditing(blank(email))}>
            <Icon name="plus" size={16} /> New
          </button>
        )}
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {msg && <Notice tone="error">{msg}</Notice>}
      {items.filter((a) => passcodeDue(a)).map((a) => (
        <div className="reminder" key={"pc" + a.id}>
          <Icon name="key" size={18} />
          <div>
            <b>New Zoom passcode for “{a.name}”?</b>
            <p>The host changes it every {WEEKDAYS[a.zoom.passcodeDay ?? 0]}. Update it before the next run.</p>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => setEditing(a)}>Update</button>
        </div>
      ))}

      {items.length === 0 && !error && (
        <Empty icon="timer" title="No automations yet"
          text="Create one with your YouTube links, the Zoom meeting and the SMS format. You can reuse it every day."
          action={<button className="btn btn-primary" onClick={() => setEditing(blank(email))}><Icon name="plus" size={16} /> New automation</button>} />
      )}

      <div className="grid-cards">
        {items.map((a) => {
          const { start } = computeWindow(a.startTime, a.endTime);
          const sender = deviceName(a.sms.senderDeviceId);
          return (
            <div className="card card-pad" key={a.id}>
              <div className="card-title">{a.name || "Untitled"}</div>
              <div className="auto-time">{a.startTime} – {a.endTime}<small>IST</small></div>
              <div className="auto-next">Next run {fmtDayIST(start).toLowerCase()}</div>
              <div className="chips" style={{ marginTop: 14 }}>
                {a.youtube.length > 0 && <span className="chip"><Icon name="video" size={14} /><span>{a.youtube.length} YouTube</span></span>}
                {a.zoom.enabled && <span className="chip"><Icon name="users" size={14} /><span>Zoom</span></span>}
                <span className="chip"><Icon name="message" size={14} /><span>{a.sms.to || "No number"}{sender ? ` · via ${sender}` : ""}</span></span>
              </div>
              <div className="auto-actions">
                <button className="btn btn-accent" disabled={busy === a.id} onClick={() => startAutomation(a)}>
                  <Icon name="play" size={14} /> {busy === a.id ? "Starting…" : "Start"}
                </button>
                <button className="btn" onClick={() => setEditing(a)}><Icon name="pencil" size={15} /> Edit</button>
                <button className="btn btn-icon" aria-label="Duplicate" title="Duplicate"
                  onClick={() => setEditing({ ...structuredClone(a), id: "", name: a.name + " (copy)" })}>
                  <Icon name="copy" size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Editor({ value, email, onDone }: { value: Automation; email: string; onDone: () => void }) {
  const [a, setA] = useState<Automation>(structuredClone(value));
  const { items: devices } = useCollection<Device>("devices");
  const { confirm, toast } = useUi();
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tplRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<Automation>) => setA({ ...a, ...patch });
  const setYt = (i: number, patch: Partial<YoutubeSource>) =>
    set({ youtube: a.youtube.map((y, j) => (j === i ? { ...y, ...patch } : y)) });
  const setZoom = (patch: Partial<Automation["zoom"]>) => set({ zoom: { ...a.zoom, ...patch } });
  const setSms = (patch: Partial<Automation["sms"]>) => set({ sms: { ...a.sms, ...patch } });
  const totals = a.totals ?? [];
  const moments = a.moments ?? [];
  const setTotal = (i: number, patch: Partial<TotalGroup>) => set({ totals: totals.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  const setMoment = (i: number, patch: Partial<Moment>) => set({ moments: moments.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const sources = sourcesOf(a);

  // Preview with made-up numbers.
  const samplePeaks: Record<string, { peak: number }> = {};
  const sampleMoment: Record<string, { peak: number }> = {};
  sources.forEach((src, i) => {
    const n = src.key === a.zoom.key ? 286 : 1240 + i * 315;
    samplePeaks[src.key] = { peak: n };
    sampleMoment[src.key] = { peak: Math.round(n * 0.9) };
  });
  const now = new Date();
  const sample = buildValues(
    a,
    { name: a.name || "Satsang", date: now.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-") },
    samplePeaks,
    moments.filter((m) => m.key && m.at).map((m) => ({ key: m.key, label: m.label || m.key, ...momentWindow(now, m.at, m.minutes) })),
    Object.fromEntries(moments.map((m) => [m.key, sampleMoment])),
  );
  const tokens = [
    "name", "date", ...sources.map((x) => x.key),
    ...(sources.length > 1 ? ["total"] : []), ...totals.filter((g) => g.key).map((g) => g.key),
    ...moments.filter((m) => m.key).flatMap((m) => [`${m.key}.total`, ...sources.map((x) => `${m.key}.${x.key}`), `${m.key}.time`]),
    "moments",
  ];

  function insertToken(t: string) {
    const el = tplRef.current;
    const text = `{${t}}`;
    const s = el?.selectionStart ?? a.sms.template.length;
    const e = el?.selectionEnd ?? s;
    const next = a.sms.template.slice(0, s) + text + a.sms.template.slice(e);
    setSms({ template: next });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + text.length, s + text.length); });
  }

  async function save() {
    const keys = sources.map((x) => x.key);
    const extra = [...totals.map((g) => g.key), ...moments.map((m) => m.key)];
    const all = [...keys, ...extra, "name", "date", "total", "moments"];
    setErr(null);
    if (!a.name.trim()) return setErr("Give the automation a name.");
    if (new Set(all).size !== all.length) return setErr("Each source, total and moment needs a different SMS tag (and not name, date, total or moments).");
    if ([...keys, ...extra].some((k) => !/^\w+$/.test(k))) return setErr("SMS tags can use only letters, numbers and _.");
    if (totals.some((g) => g.sources.filter((k) => keys.includes(k)).length === 0)) return setErr("Each total needs at least one source ticked.");
    if (moments.some((m) => !m.at)) return setErr("Each moment needs a time.");
    if (a.youtube.some((y) => !y.url.trim())) return setErr("Every YouTube stream needs a link.");
    if (a.youtube.some((y) => y.mode === "window" && (!y.windowStart || !y.windowEnd)))
      return setErr("24×7 streams need a from and to time.");
    if (a.zoom.enabled && !a.zoom.link.trim()) return setErr("Add the Zoom invite link, or turn Zoom off.");
    if (!a.sms.to.trim()) return setErr("Add the phone number the SMS goes to.");
    setSaving(true);
    try {
      await saveAutomation(a, email, a.id ? value : undefined);
      toast("Automation saved");
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!a.id) return;
    const ok = await confirm({ title: `Delete “${a.name}”?`, body: "Past runs stay in the Runs history.", confirm: "Delete", danger: true });
    if (ok) {
      await deleteAutomation(a.id);
      toast("Automation deleted");
      onDone();
    }
  }

  return (
    <div>
      <button className="back" onClick={onDone}><Icon name="back" size={16} /> Automations</button>
      <div className="page-head">
        <div>
          <h1>{a.id ? "Edit automation" : "New automation"}</h1>
          <p>All times are India time (IST).</p>
        </div>
      </div>

      <section className="card card-pad">
        <div className="form-section-head">
          <div><h2>Basics</h2><p>Name and the time to count.</p></div>
        </div>
        <Field label="Name">
          <input className="input" value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="Satsang daily" />
        </Field>
        <div className="field-grid" style={{ ["--cols" as string]: 2 }}>
          <Field label="Start"><input className="input" type="time" value={a.startTime} onChange={(e) => set({ startTime: e.target.value })} /></Field>
          <Field label="End"><input className="input" type="time" value={a.endTime} onChange={(e) => set({ endTime: e.target.value })} /></Field>
        </div>
        <div className="field-grid stack-sm" style={{ ["--cols" as string]: 2 }}>
          <Field label="Check YouTube every" hint="Each stream can change this.">
            <select className="input" value={a.pollSeconds} onChange={(e) => set({ pollSeconds: Number(e.target.value) })}>
              {POLL_CHOICES.map((s) => <option key={s} value={s}>{fmtSecs(s)}</option>)}
              {!POLL_CHOICES.includes(a.pollSeconds) && <option value={a.pollSeconds}>{fmtSecs(a.pollSeconds)}</option>}
            </select>
          </Field>
          <Field label="Save when a count changes by">
            <select className="input" value={a.saveStep ?? 5} onChange={(e) => set({ saveStep: Number(e.target.value) })}>
              {[1, 2, 3, 5, 10, 20, 50].map((s) => <option key={s} value={s}>± {s}</option>)}
            </select>
          </Field>
        </div>
        <p className="hint" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
          Zoom is checked every 3 seconds. The exact highest number is always kept, even between saves. If the end is earlier than the start, it ends the next day.
        </p>
      </section>

      <section className="card card-pad form-section">
        <div className="form-section-head">
          <div><h2>YouTube streams</h2><p>Highest live viewers for each stream.</p></div>
        </div>
        {a.youtube.length === 0 && <p className="muted small">No streams. Add one below.</p>}
        {a.youtube.map((y, i) => (
          <div className="source" key={i}>
            <div className="source-head">
              <div className="label"><Icon name="video" size={16} /> Stream {i + 1}</div>
              <button className="btn btn-ghost btn-sm btn-icon" aria-label="Remove stream"
                onClick={() => set({ youtube: a.youtube.filter((_, j) => j !== i) })}>
                <Icon name="trash" size={15} />
              </button>
            </div>
            <Field label="Link">
              <input className="input" inputMode="url" value={y.url} onChange={(e) => setYt(i, { url: e.target.value })} placeholder="youtube.com/live/…" />
            </Field>
            <div className="field-grid" style={{ ["--cols" as string]: 2, gridTemplateColumns: "minmax(0,1fr) 110px" }}>
              <Field label="Label"><input className="input" value={y.label} onChange={(e) => setYt(i, { label: e.target.value })} /></Field>
              <Field label="SMS tag"><input className="input" value={y.key} onChange={(e) => setYt(i, { key: e.target.value })} /></Field>
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <span>Stream type</span>
              <Segmented value={y.mode} onChange={(m) => setYt(i, { mode: m })}
                options={[{ value: "event", label: "Live event" }, { value: "window", label: "24×7 stream" }]} />
              <span className="hint">{y.mode === "event" ? "Counted whenever it is live during the run." : "Counted only between the times below."}</span>
            </div>
            {y.mode === "window" && (
              <div className="field-grid" style={{ ["--cols" as string]: 2 }}>
                <Field label="From"><input className="input" type="time" value={y.windowStart ?? ""} onChange={(e) => setYt(i, { windowStart: e.target.value })} /></Field>
                <Field label="To"><input className="input" type="time" value={y.windowEnd ?? ""} onChange={(e) => setYt(i, { windowEnd: e.target.value })} /></Field>
              </div>
            )}
            <Field label="Check this stream every" hint="Busy streams that jump around need frequent checks. Steady ones can be checked less often.">
              <select className="input" value={y.pollSeconds ?? 0} onChange={(e) => setYt(i, { pollSeconds: Number(e.target.value) || undefined })}>
                <option value={0}>Same as above ({fmtSecs(a.pollSeconds)})</option>
                {POLL_CHOICES.map((s) => <option key={s} value={s}>{fmtSecs(s)}</option>)}
              </select>
            </Field>
          </div>
        ))}
        <button className="btn add-source" onClick={() => set({ youtube: [...a.youtube, { key: `yt${a.youtube.length + 1}`, label: `YouTube ${a.youtube.length + 1}`, url: "", mode: "event" }] })}>
          <Icon name="plus" size={16} /> Add stream
        </button>
      </section>

      <section className="card card-pad form-section">
        <div className="form-section-head" style={{ marginBottom: a.zoom.enabled ? 16 : 0 }}>
          <div><h2>Zoom meeting</h2><p>Highest number of participants.</p></div>
          <Switch on={a.zoom.enabled} onChange={(v) => setZoom({ enabled: v })} label="Count Zoom" />
        </div>
        {a.zoom.enabled && (
          <>
            <div className="field" style={{ marginBottom: 16 }}>
              <span>Count from</span>
              <Segmented value={a.zoom.via ?? DEFAULT_ZOOM_VIA} onChange={(v) => setZoom({ via: v })}
                options={[{ value: "phone", label: "Sender phone" }, { value: "both", label: "Phone + cloud" }, { value: "github", label: "Cloud" }]} />
              <span className="hint">
                {{
                  phone: "Recommended. Only the sender phone joins, once, in the background on its own internet. Keep it on and online during the meeting.",
                  both: "The phone and the cloud both join, so the meeting shows this name twice. Use only if the phone is unreliable.",
                  github: "Joins from GitHub's servers. Zoom sometimes asks these for a robot check.",
                }[a.zoom.via ?? DEFAULT_ZOOM_VIA]}
              </span>
            </div>
            <Field label="Invite link">
              <input className="input" inputMode="url" value={a.zoom.link} onChange={(e) => setZoom({ link: e.target.value })} placeholder="zoom.us/j/123…?pwd=…" />
            </Field>
            <div className="field-grid stack-sm" style={{ ["--cols" as string]: 2 }}>
              <Field label="Passcode" hint="Used instead of any passcode in the link."><input className="input" value={a.zoom.passcode ?? ""} onChange={(e) => setZoom({ passcode: e.target.value })} /></Field>
              <Field label="Join as"><input className="input" value={a.zoom.displayName} onChange={(e) => setZoom({ displayName: e.target.value })} /></Field>
            </div>
            <Field label="Passcode changes every" hint="You get a reminder here and on the sender phone that day until you save the new passcode.">
              <select className="input" value={a.zoom.passcodeDay ?? -1} onChange={(e) => { const d = Number(e.target.value); setZoom({ passcodeDay: d < 0 ? undefined : d }); }}>
                <option value={-1}>Doesn’t change</option>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
            <Field label="SMS tag" hint="The counter joins muted with camera off and doesn’t count itself.">
              <input className="input" value={a.zoom.key} onChange={(e) => setZoom({ key: e.target.value })} style={{ maxWidth: 160 }} />
            </Field>
          </>
        )}
      </section>

      <section className="card card-pad form-section">
        <div className="form-section-head">
          <div><h2>Totals</h2><p>Add counts together for the SMS. {"{total}"} already adds up everything.</p></div>
        </div>
        {totals.map((g, i) => (
          <div className="source" key={i}>
            <div className="source-head">
              <div className="label"><Icon name="plus" size={16} /> Total {i + 1}</div>
              <button className="btn btn-ghost btn-sm btn-icon" aria-label="Remove total" onClick={() => set({ totals: totals.filter((_, j) => j !== i) })}>
                <Icon name="trash" size={15} />
              </button>
            </div>
            <div className="field-grid" style={{ ["--cols" as string]: 2, gridTemplateColumns: "minmax(0,1fr) 110px" }}>
              <Field label="Name"><input className="input" value={g.label} onChange={(e) => setTotal(i, { label: e.target.value })} placeholder="All YouTube" /></Field>
              <Field label="SMS tag"><input className="input" value={g.key} onChange={(e) => setTotal(i, { key: e.target.value })} /></Field>
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <span>Adds up</span>
              <div className="picks">
                {sources.map((src) => {
                  const on = g.sources.includes(src.key);
                  return (
                    <button type="button" key={src.key} className={`pick ${on ? "on" : ""}`} aria-pressed={on}
                      onClick={() => setTotal(i, { sources: on ? g.sources.filter((k) => k !== src.key) : [...g.sources, src.key] })}>
                      {on && <Icon name="check" size={14} />}{src.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
        <button className="btn add-source" onClick={() => set({ totals: [...totals, { key: `sum${totals.length + 1}`, label: "", sources: [] }] })}>
          <Icon name="plus" size={16} /> Add a total
        </button>
      </section>

      <section className="card card-pad form-section">
        <div className="form-section-head">
          <div><h2>Moments</h2><p>Note the highest counts in every stream and Zoom at a set time, like Aarti. You can also mark one live from Runs.</p></div>
        </div>
        {moments.map((m, i) => (
          <div className="source" key={i}>
            <div className="source-head">
              <div className="label"><Icon name="clock" size={16} /> {m.label || `Moment ${i + 1}`}</div>
              <button className="btn btn-ghost btn-sm btn-icon" aria-label="Remove moment" onClick={() => set({ moments: moments.filter((_, j) => j !== i) })}>
                <Icon name="trash" size={15} />
              </button>
            </div>
            <div className="field-grid" style={{ ["--cols" as string]: 2, gridTemplateColumns: "minmax(0,1fr) 110px" }}>
              <Field label="Name"><input className="input" value={m.label} onChange={(e) => setMoment(i, { label: e.target.value })} placeholder="Aarti" /></Field>
              <Field label="SMS tag"><input className="input" value={m.key} onChange={(e) => setMoment(i, { key: e.target.value })} /></Field>
            </div>
            <div className="field-grid" style={{ ["--cols" as string]: 2 }}>
              <Field label="Starts at"><input className="input" type="time" value={m.at} onChange={(e) => setMoment(i, { at: e.target.value })} /></Field>
              <Field label="Watch for">
                <select className="input" value={m.minutes} onChange={(e) => setMoment(i, { minutes: Number(e.target.value) })}>
                  {[10, 15, 20, 30, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}
                </select>
              </Field>
            </div>
          </div>
        ))}
        <button className="btn add-source" onClick={() => set({ moments: [...moments, { key: moments.length ? `m${moments.length + 1}` : "aarti", label: moments.length ? "" : "Aarti", at: "06:00", minutes: 30 }] })}>
          <Icon name="plus" size={16} /> Add a moment
        </button>
      </section>

      <section className="card card-pad form-section">
        <div className="form-section-head">
          <div><h2>SMS</h2><p>Sent from a member’s phone when the run ends.</p></div>
        </div>
        <Field label="Send from" hint={devices.length === 0 ? "No phones yet. Install the phone app and sign in; it appears here." : undefined}>
          <select className="input" value={a.sms.senderDeviceId} onChange={(e) => setSms({ senderDeviceId: e.target.value })}>
            <option value="">Choose a phone…</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.label} · {d.ownerEmail}</option>)}
          </select>
        </Field>
        <Field label="Send to">
          <input className="input" type="tel" value={a.sms.to} onChange={(e) => setSms({ to: e.target.value })} placeholder="+91 98765 43210" />
        </Field>
        <div className="field" style={{ marginTop: 16 }}>
          <span>Message</span>
          <textarea ref={tplRef} className="input" rows={3} value={a.sms.template} onChange={(e) => setSms({ template: e.target.value })} />
          <div className="tokens">
            {tokens.map((t) => <button type="button" key={t} className="token" onClick={() => insertToken(t)}>{`{${t}}`}</button>)}
          </div>
          <span className="hint">
            Tap a tag to insert it. {"{total}"} adds up every stream and Zoom. A moment tag like {"{aarti.total}"} uses only the highest counts during that moment, and {"{moments}"} lists every moment, including ones marked live. Missing values are sent as NA.
          </span>
        </div>
        <div className="sms-preview">
          <div className="cap">Preview</div>
          <div className="bubble">{renderTemplate(a.sms.template, sample)}</div>
        </div>
      </section>

      {a.id && (
        <div className="danger-zone">
          <p>Delete this automation</p>
          <button className="btn btn-danger btn-sm" onClick={remove}><Icon name="trash" size={14} /> Delete</button>
        </div>
      )}

      <div className="actionbar">
        {err && <div style={{ position: "absolute", left: 16, right: 16, bottom: "100%", marginBottom: 8 }}><Notice tone="error">{err}</Notice></div>}
        <button className="btn btn-lg" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary btn-lg" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save automation"}</button>
      </div>
    </div>
  );
}
