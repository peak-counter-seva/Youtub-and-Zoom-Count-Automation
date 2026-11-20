import { useEffect, useRef, useState } from "react";
import { deleteAutomation, liveRunsOf, saveAutomation, startRun, updateYoutubeLinks } from "../lib/api";
import { useCollection } from "../lib/hooks";
import { computeWindow, fmtDayIST, fmtTimeIST } from "../lib/time";
import {
  asDate, buildValues, DEFAULT_ZOOM_VIA, fmtDate, fmtDay, satsangTemplate, momentWindow, passcodeDue, WEEKDAYS, renderTemplate, sourcesOf,
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

export default function Automations({ email, onStarted, editId, onEditOpened }: {
  email: string; onStarted: () => void; editId?: string | null; onEditOpened?: () => void;
}) {
  const { items, error } = useCollection<Automation>("automations");
  const { items: devices } = useCollection<Device>("devices");
  const { confirm, toast } = useUi();
  const [editing, setEditing] = useState<Automation | null>(null);
  // Opened from a live run's Edit button.
  useEffect(() => {
    if (!editId) return;
    const a = items.find((x) => x.id === editId);
    if (a) { setEditing(a); onEditOpened?.(); }
  }, [editId, items, onEditOpened]);
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
              <QuickLinks a={a} />
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
  // Only one stream / total / moment is open at a time; the rest are one-line rows.
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  const [liveCount, setLiveCount] = useState(0);
  useEffect(() => {
    if (value.id) liveRunsOf(value.id).then((r) => setLiveCount(r.length)).catch(() => {});
  }, [value.id]);
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
    { name: a.name || "Satsang", date: fmtDate(now), day: fmtDay(now) },
    samplePeaks,
    moments.filter((m) => m.key && m.at).map((m) => ({ key: m.key, label: m.label || m.key, ...momentWindow(now, m.at, m.minutes) })),
    Object.fromEntries(moments.map((m) => [m.key, sampleMoment])),
  );
  const unknownTags = [...new Set([...a.sms.template.matchAll(/\{([\w.]+)\}/g)].map((m) => m[1]))].filter((t) => !(t in sample));
  const tokens = [
    "name", "date", "day", ...sources.map((x) => x.key),
    ...(sources.length > 1 ? ["total"] : []), ...(a.youtube.length > 1 && a.zoom.enabled ? ["youtube"] : []), ...totals.filter((g) => g.key).map((g) => g.key),
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
    const all = [...keys, ...extra, "name", "date", "day", "total", "youtube", "moments"];
    setErr(null);
    if (!a.name.trim()) return setErr("Give the automation a name.");
    if (new Set(all).size !== all.length) return setErr("Each source, total and moment needs a different SMS tag (and not name, date, total or moments).");
    if ([...keys, ...extra].some((k) => !/^\w+$/.test(k))) return setErr("SMS tags can use only letters, numbers and _.");
    if (totals.some((g) => g.sources.filter((k) => keys.includes(k)).length === 0)) return setErr("Each total needs at least one source ticked.");
    if (moments.some((m) => !m.at)) return setErr("Each moment needs a time.");
    if (a.youtube.some((y) => !y.url.trim())) return setErr("Every YouTube stream needs a link (or a channel link to search).");
    if (a.youtube.some((y) => y.findTitle !== undefined && !y.findTitle.trim())) return setErr("Enter words from the live stream’s title, or switch back to a fixed link.");
    if (a.youtube.some((y) => y.mode === "window" && y.windowStart !== undefined && (!y.windowStart || !y.windowEnd)))
      return setErr("Fill in both custom times, or choose “Whole automation time”.");
    if (a.zoom.enabled && !a.zoom.link.trim()) return setErr("Add the Zoom invite link, or turn Zoom off.");
    if (!a.sms.to.trim()) return setErr("Add the phone number the SMS goes to.");
    setSaving(true);
    try {
      const clean = { ...a, totals: totals.map((g) => ({ ...g, sources: g.sources.filter((k) => keys.includes(k)) })) };
      await saveAutomation(clean, email, a.id ? value : undefined);
      toast(liveCount > 0 ? "Saved. The live run uses it within a minute." : "Automation saved");
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
      <nav className="jumpbar" aria-label="Sections">
        {([["sec-basics", "Basics", ""], ["sec-streams", "Streams", String(a.youtube.length)], ["sec-zoom", "Zoom", ""],
           ["sec-totals", "Totals", totals.length ? String(totals.length) : ""], ["sec-moments", "Moments", moments.length ? String(moments.length) : ""],
           ["sec-sms", "SMS", ""]] as const).map(([id, label, n]) => (
          <button type="button" key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {label}{n && <b>{n}</b>}
          </button>
        ))}
      </nav>
      {liveCount > 0 && (
        <Notice tone="info">This automation is counting now. When you save, the live run switches to the new links and settings within a minute. Its start and end times stay the same.</Notice>
      )}

      <section className="card card-pad" id="sec-basics">
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
        <div className="auto-start">
          <div>
            <b>Start by itself</b>
            <p>Starts a few minutes before the start time, so no one has to press Start.</p>
          </div>
          <Switch on={!!a.autoStart} onChange={(v) => set({ autoStart: v })} label="Start by itself" />
        </div>
        {a.autoStart && (
          <div className="field" style={{ marginTop: 10 }}>
            <span>On these days</span>
            <div className="picks">
              {WEEKDAYS.map((d, i) => {
                const days = a.autoDays?.length ? a.autoDays : [0, 1, 2, 3, 4, 5, 6];
                const on = days.includes(i);
                return (
                  <button type="button" key={d} className={`pick ${on ? "on" : ""}`} aria-pressed={on}
                    onClick={() => { const next = on ? days.filter((x) => x !== i) : [...days, i].sort(); set({ autoDays: next.length === 7 ? [] : next }); }}>
                    {d.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <p className="hint" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
          Zoom is checked every 3 seconds. The exact highest number is always kept, even between saves. If the end is earlier than the start, it ends the next day.
        </p>
      </section>

      <section className="card card-pad form-section" id="sec-streams">
        <div className="form-section-head">
          <div><h2>YouTube streams</h2><p>Highest live viewers for each stream.</p></div>
        </div>
        {a.youtube.length === 0 && <p className="muted small">No streams. Add one below.</p>}
        <div className="source-grid">
        {a.youtube.map((y, i) => (
          <div className={`source ${open === `yt${i}` ? "open" : "closed"}`} key={i}>
            <RowHead open={open === `yt${i}`} onToggle={() => toggle(`yt${i}`)} icon="video"
              title={y.label || `Stream ${i + 1}`} tag={y.key}
              sub={[y.mode === "window" ? "24×7" : "Live event", y.findTitle !== undefined ? `finds “${y.findTitle}”` : shortUrl(y.url), y.pollSeconds ? `every ${fmtSecs(y.pollSeconds)}` : ""].filter(Boolean).join(" · ")}
              onRemove={async () => {
                if (await confirm({ title: `Remove “${y.label || `Stream ${i + 1}`}”?`, body: "Its count won’t be in the SMS any more.", confirm: "Remove", danger: true }))
                  { set({ youtube: a.youtube.filter((_, j) => j !== i) }); setOpen(null); }
              }} />
            {open === `yt${i}` && (<div className="source-body">
            {(
              <div className="field" style={{ marginBottom: 4 }}>
                <span>Which stream</span>
                <Segmented value={y.findTitle !== undefined ? "find" : "link"}
                  onChange={(v) => setYt(i, { findTitle: v === "find" ? (y.findTitle ?? "") : undefined })}
                  options={[{ value: "link", label: "Paste link" }, { value: "find", label: "Find on channel" }]} />
                <span className="hint">
                  {y.findTitle !== undefined
                    ? "Each time it counts, it looks on the channel for a live stream whose title has these words. No link changes needed."
                    : "If this stream has ended, it switches by itself to the channel’s new live or upcoming stream with a similar title, and saves the new link here."}
                </span>
              </div>
            )}
            {y.findTitle !== undefined ? (
              <div className="field-grid stack-sm" style={{ ["--cols" as string]: 2 }}>
                <Field label="Channel link">
                  <input className="input" inputMode="url" value={y.url} onChange={(e) => setYt(i, { url: e.target.value })} placeholder="youtube.com/@channel" />
                </Field>
                <Field label="Title contains">
                  <input className="input" value={y.findTitle} onChange={(e) => setYt(i, { findTitle: e.target.value })} placeholder="કથા" />
                </Field>
              </div>
            ) : (
              <Field label="Link">
                <input className="input" inputMode="url" value={y.url} onChange={(e) => setYt(i, { url: e.target.value })} placeholder="youtube.com/live/…" />
              </Field>
            )}
            <div className="field-grid" style={{ ["--cols" as string]: 2, gridTemplateColumns: "minmax(0,1fr) 110px" }}>
              <Field label="Label"><input className="input" value={y.label} onChange={(e) => setYt(i, { label: e.target.value })} /></Field>
              <Field label="SMS tag"><input className="input" value={y.key} onChange={(e) => setYt(i, { key: e.target.value })} /></Field>
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <span>Stream type</span>
              <Segmented value={y.mode} onChange={(m) => setYt(i, { mode: m })}
                options={[{ value: "event", label: "Live event" }, { value: "window", label: "24×7 stream" }]} />
              <span className="hint">{y.mode === "event" ? "Counted whenever it is live during the run." : (y.windowStart !== undefined ? "Counted only between the times below." : `Counted for the automation’s own time (${a.startTime} – ${a.endTime}).`)}</span>
            </div>
            {y.mode === "window" && (
              <div className="field" style={{ marginTop: 12 }}>
                <span>Count during</span>
                <Segmented value={y.windowStart !== undefined ? "custom" : "all"}
                  onChange={(v) => setYt(i, v === "custom" ? { windowStart: a.startTime, windowEnd: a.endTime } : { windowStart: undefined, windowEnd: undefined })}
                  options={[{ value: "all", label: "Whole automation time" }, { value: "custom", label: "Custom times" }]} />
              </div>
            )}
            {y.mode === "window" && y.windowStart !== undefined && (
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
            </div>)}
          </div>
        ))}
        </div>
        <button className="btn add-source" onClick={() => { set({ youtube: [...a.youtube, { key: `yt${a.youtube.length + 1}`, label: `YouTube ${a.youtube.length + 1}`, url: "", mode: "event" }] }); setOpen(`yt${a.youtube.length}`); }}>
          <Icon name="plus" size={16} /> Add stream
        </button>
      </section>

      <section className="card card-pad form-section" id="sec-zoom">
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

      <section className="card card-pad form-section" id="sec-totals">
        <div className="form-section-head">
          <div><h2>Totals</h2><p>Add counts together for the SMS. {"{total}"} already adds up everything.</p></div>
        </div>
        <div className="source-grid">
        {totals.map((g, i) => (
          <div className={`source ${open === `t${i}` ? "open" : "closed"}`} key={i}>
            <RowHead open={open === `t${i}`} onToggle={() => toggle(`t${i}`)} icon="plus"
              title={g.label || `Total ${i + 1}`} tag={g.key}
              sub={sources.filter((x) => g.sources.includes(x.key)).map((x) => x.label).join(" + ") || "nothing ticked yet"}
              onRemove={() => { set({ totals: totals.filter((_, j) => j !== i) }); setOpen(null); }} />
            {open === `t${i}` && (<div className="source-body">
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
            </div>)}
          </div>
        ))}
        </div>
        <button className="btn add-source" onClick={() => { set({ totals: [...totals, { key: `sum${totals.length + 1}`, label: "", sources: [] }] }); setOpen(`t${totals.length}`); }}>
          <Icon name="plus" size={16} /> Add a total
        </button>
      </section>

      <section className="card card-pad form-section" id="sec-moments">
        <div className="form-section-head">
          <div><h2>Moments</h2><p>Note the highest counts in every stream and Zoom at a set time, like Aarti. You can also mark one live from Runs.</p></div>
        </div>
        <div className="source-grid">
        {moments.map((m, i) => (
          <div className={`source ${open === `m${i}` ? "open" : "closed"}`} key={i}>
            <RowHead open={open === `m${i}`} onToggle={() => toggle(`m${i}`)} icon="clock"
              title={m.label || `Moment ${i + 1}`} tag={m.key} sub={`${m.at} for ${m.minutes} min`}
              onRemove={() => { set({ moments: moments.filter((_, j) => j !== i) }); setOpen(null); }} />
            {open === `m${i}` && (<div className="source-body">
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
            </div>)}
          </div>
        ))}
        </div>
        <button className="btn add-source" onClick={() => { setOpen(`m${moments.length}`); set({ moments: [...moments, { key: moments.length ? `m${moments.length + 1}` : "aarti", label: moments.length ? "" : "Aarti", at: "06:00", minutes: 30 }] }); }}>
          <Icon name="plus" size={16} /> Add a moment
        </button>
      </section>

      <section className="card card-pad form-section" id="sec-sms">
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
          <span className="msg-label">Message
            <button type="button" className="btn btn-sm" onClick={async () => {
              if (a.sms.template.trim() && !(await confirm({ title: "Use the Satsang format?", body: "This replaces the message below. You can still change it after.", confirm: "Use it" }))) return;
              setSms({ template: satsangTemplate(a) });
            }}>Use Satsang format</button>
          </span>
          <textarea ref={tplRef} className="input" rows={Math.min(14, Math.max(3, a.sms.template.split("\n").length + 1))} value={a.sms.template} onChange={(e) => setSms({ template: e.target.value })} />
          <div className="tokens">
            {tokens.map((t) => <button type="button" key={t} className="token" onClick={() => insertToken(t)}>{`{${t}}`}</button>)}
          </div>
          <span className="hint">
            Tap a tag to insert it. {"{total}"} adds up every stream and Zoom, {"{youtube}"} only the YouTube streams, and {"{day}"} writes the date like 18 Nov 2026. A moment tag like {"{aarti.total}"} uses only the highest counts during that moment, and {"{moments}"} lists every moment, including ones marked live. Missing values are sent as NA.
          </span>
        </div>
        <div className="sms-preview">
          <div className="cap">Preview</div>
          <div className="bubble">{renderTemplate(a.sms.template, sample)}</div>
          {unknownTags.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Notice tone="warn">
                {unknownTags.map((t) => `{${t}}`).join(", ")} {unknownTags.length === 1 ? "doesn’t" : "don’t"} match any stream, total or moment, so {unknownTags.length === 1 ? "it" : "they"} would be sent as written. Tags must match exactly, including capital letters.
              </Notice>
            </div>
          )}
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

/** The day's live event links, editable right on the card (they change every day). */
function QuickLinks({ a }: { a: Automation }) {
  const { toast } = useUi();
  const events = a.youtube.map((y, i) => ({ y, i })).filter(({ y }) => y.mode === "event" && y.findTitle === undefined);
  const [open, setOpen] = useState(false);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  if (events.length === 0) return null;
  const updated = asDate(a.linksUpdatedAt);
  const today = updated && fmtDayIST(updated) === "Today";

  function begin() {
    setUrls(Object.fromEntries(events.map(({ y, i }) => [i, y.url])));
    setOpen(true);
  }
  async function paste(i: number) {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) setUrls((u) => ({ ...u, [i]: t }));
      else toast("Nothing copied yet");
    } catch {
      toast("Long-press the box and choose Paste");
    }
  }
  async function save() {
    if (events.some(({ i }) => !(urls[i] ?? "").trim())) return toast("Every live event needs a link");
    setSaving(true);
    try {
      await updateYoutubeLinks(a, urls);
      toast("Links saved");
      setOpen(false);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!open)
    return (
      <button className={`links-bar ${today ? "" : "stale"}`} onClick={begin}>
        <Icon name="video" size={15} />
        <span>{events.length === 1 ? "Live event link" : `${events.length} live event links`}</span>
        <small>{updated ? `changed ${fmtDayIST(updated).toLowerCase()}` : "change for today"}</small>
        <Icon name="pencil" size={14} />
      </button>
    );

  return (
    <div className="links-edit">
      {events.map(({ y, i }) => (
        <label className="field" key={i}>
          <span>{y.label || `Stream ${i + 1}`}</span>
          <div className="links-row">
            <input className="input" inputMode="url" value={urls[i] ?? ""} placeholder="youtube.com/live/…"
              onChange={(e) => setUrls((u) => ({ ...u, [i]: e.target.value }))} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={() => paste(i)}>Paste</button>
          </div>
        </label>
      ))}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save links"}</button>
      </div>
    </div>
  );
}

function shortUrl(u: string) {
  const t = u.trim().replace(/^https?:\/\/(www\.)?/, "");
  return t ? (t.length > 34 ? t.slice(0, 33) + "…" : t) : "no link yet";
}

/** One-line summary of a stream / total / moment. Tap to open its settings. */
function RowHead({ open, onToggle, icon, title, tag, sub, onRemove }: {
  open: boolean; onToggle: () => void; icon: "video" | "plus" | "clock"; title: string; tag: string; sub: string; onRemove: () => void;
}) {
  return (
    <div className="row-head">
      <button type="button" className="row-main" onClick={onToggle} aria-expanded={open}>
        <Icon name={icon} size={16} />
        <span className="row-text">
          <span className="row-title">{title} <code>{`{${tag}}`}</code></span>
          <span className="row-sub">{sub}</span>
        </span>
        <span className={`row-chev ${open ? "up" : ""}`}><Icon name="chevron" size={16} /></span>
      </button>
      {open && (
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove ${title}`} onClick={onRemove}>
          <Icon name="trash" size={15} />
        </button>
      )}
    </div>
  );
}
