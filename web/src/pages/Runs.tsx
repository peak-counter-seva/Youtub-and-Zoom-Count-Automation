import { useEffect, useState, type ReactNode } from "react";
import { markMoment, resendSms, sendNow, setManualPeak, stopRun } from "../lib/api";
import { auth } from "../lib/firebase";
import { useCollection } from "../lib/hooks";
import { fmtDayIST, fmtTimeIST } from "../lib/time";
import { momentsOf, renderTemplate, runValues, sourcesOf, type Peak, type Run } from "../lib/types";
import { Empty, Icon, Notice, useUi } from "../components/ui";

const STATUS_TEXT: Record<Run["status"], string> = {
  queued: "Starting",
  waiting: "Scheduled",
  running: "Live",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

const SMS_TEXT = { pending: "Waiting to send", sent: "Sent", failed: "Not sent" } as const;

const isActive = (r: Run) => ["queued", "waiting", "running"].includes(r.status);
const fmtN = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toLocaleString("en-IN"));

export default function Runs({ onEdit }: { onEdit: (automationId: string) => void }) {
  const { items, error } = useCollection<Run>("runs", "createdAt", 30);
  const live = items.filter(isActive);
  const past = items.filter((r) => !isActive(r));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p>Live counts and the last 30 runs.</p>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {items.length === 0 && !error && (
        <Empty icon="activity" title="No runs yet" text="Start an automation and its live counts will show here." />
      )}

      {live.length > 0 && (
        <>
          <div className="section-title">Now <span className="count">{live.length}</span></div>
          {live.map((r) => <RunCard key={r.id} r={r} onEdit={() => onEdit(r.automationId)} />)}
        </>
      )}
      {past.length > 0 && (
        <>
          <div className="section-title">History <span className="count">{past.length}</span></div>
          {past.map((r) => <RunCard key={r.id} r={r} />)}
        </>
      )}
    </div>
  );
}

function RunCard({ r, onEdit }: { r: Run; onEdit?: () => void }) {
  const { confirm, toast } = useUi();
  const active = isActive(r);
  const stale = active && r.status === "running" && r.heartbeatAt && Date.now() - r.heartbeatAt.toMillis() > 3 * 60000;
  const start = r.startAt?.toDate();
  const end = r.endAt?.toDate();
  const peaks = Object.entries(r.peaks ?? {});
  const [sheet, setSheet] = useState<"moment" | "send" | null>(null);
  const values = runValues(r);
  const showTotal = peaks.length > 1 && values.total !== "NA";

  async function stop() {
    const ok = await confirm({ title: "Stop this run now?", body: "Counting stops and the SMS is sent with the highest numbers so far.", confirm: "Stop and send", danger: true });
    if (ok) { await stopRun(r.id); toast("Stopping…"); }
  }

  async function resend() {
    const ok = await confirm({ title: "Send the SMS again?", body: r.smsText, confirm: "Send again" });
    if (ok) { await resendSms(r); toast("SMS queued"); }
  }

  return (
    <div className={`card card-pad ${r.status === "running" ? "live" : ""}`}>
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <div className="card-title">{r.automationName}</div>
          <div className="run-meta">
            <span><Icon name="calendar" size={13} />{fmtDayIST(start)}</span>
            <span className="num"><Icon name="clock" size={13} />{fmtTimeIST(start)} – {fmtTimeIST(end)}</span>
            <span><Icon name="user" size={13} />{r.requestedBy.split("@")[0]}</span>
          </div>
        </div>
        <span className={`status ${r.status}`}>{STATUS_TEXT[r.status]}</span>
      </div>

      {stale && <Notice tone="warn">No update from the counter for over 3 minutes. The phone backup will take over YouTube counting.</Notice>}

      {peaks.length > 0 && (
        <div className="stats">
          {peaks.map(([k, p]) => <StatTile key={k} r={r} k={k} p={p} active={active} />)}
          {showTotal && (
            <div className="stat">
              <div className="stat-label"><Icon name="plus" size={14} /><span>Total</span></div>
              <div className="stat-value">{fmtN(Number(values.total))}</div>
              <div className="stat-sub">all highest counts added</div>
            </div>
          )}
        </div>
      )}

      <Moments r={r} />

      {r.smsText && (
        <div className="sms-out">
          <div className="bubble">{r.smsText}</div>
          <div className={`meta ${r.smsStatus === "failed" ? "failed" : ""}`}>{SMS_TEXT[r.smsStatus ?? "pending"]}</div>
        </div>
      )}

      {r.error && <Notice tone="error">{r.error}</Notice>}
      {sheet === "moment" && <MarkMomentSheet r={r} onClose={() => setSheet(null)} />}
      {sheet === "send" && <SendNowSheet r={r} onClose={() => setSheet(null)} />}

      {(active || r.smsText || (r.log && r.log.length > 0)) && (
        <div className="run-foot">
          {r.log && r.log.length > 0 ? (
            <details className="log" style={{ flex: 1, minWidth: 0 }}>
              <summary><Icon name="chevron" size={14} /> Activity log</summary>
              <pre>{r.log.slice(-30).join("\n")}</pre>
            </details>
          ) : <span />}
          <div className="btn-row" style={{ alignSelf: "flex-start" }}>
            {active && !r.stopRequested && (
              <>
                {onEdit && <button className="btn btn-sm" onClick={onEdit}><Icon name="pencil" size={14} /> Edit</button>}
                <button className="btn btn-sm" onClick={() => setSheet("moment")}><Icon name="clock" size={14} /> Mark moment</button>
                <button className="btn btn-sm" onClick={() => setSheet("send")}><Icon name="send" size={14} /> Send SMS now</button>
                <button className="btn btn-danger btn-sm" onClick={stop}><Icon name="stop" size={12} /> Stop now</button>
              </>
            )}
            {active && r.stopRequested && <span className="muted small">Stopping…</span>}
            {!active && r.smsText && <button className="btn btn-sm" onClick={resend}><Icon name="send" size={14} /> Resend SMS</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({ r, k, p, active }: { r: Run; k: string; p: Peak; active: boolean }) {
  const { toast } = useUi();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(p.peak?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 0) return toast("Enter a whole number");
    setSaving(true);
    try {
      await setManualPeak(r, k, n, auth.currentUser?.email ?? "someone");
      toast(r.smsText ? "Saved. Tap Resend SMS to send the new numbers." : "Saved. Counting goes on, and a higher count will replace it.");
      setEditing(false);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stat">
      <div className="stat-label">
        <Icon name={k.toLowerCase().includes("zoom") ? "users" : "video"} size={14} /><span>{p.label}</span>
        {!editing && (
          <button className="stat-edit" aria-label={`Enter ${p.label} by hand`} title="Enter by hand" onClick={() => { setVal(p.peak?.toString() ?? ""); setEditing(true); }}>
            <Icon name="pencil" size={13} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="stat-form">
          <input className="input" type="number" inputMode="numeric" min={0} autoFocus value={val}
            onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Highest" />
          <div className="btn-row">
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>Save</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="stat-value">{fmtN(p.peak)}</div>
          <div className="stat-sub">
            {active && p.current !== null && p.current !== undefined ? `Now ${fmtN(p.current)} · ` : ""}
            {p.manualBy ? `typed by ${p.manualBy.split("@")[0]}` : p.peakAt ? `peak ${fmtTimeIST(p.peakAt.toDate())}` : "no reading yet"}
          </div>
          {p.manualBy && active && <div className="stat-sub">Still counting. A higher count replaces it.</div>}
          {p.note && <div className="stat-note">{p.note}</div>}
          {p.peak == null && p.note && (
            <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => { setVal(""); setEditing(true); }}>Enter by hand</button>
          )}
        </>
      )}
    </div>
  );
}

function Moments({ r }: { r: Run }) {
  const moments = momentsOf(r);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);
  if (moments.length === 0) return null;
  const srcs = sourcesOf(r.config);
  const v = runValues(r);
  const now = Date.now();
  return (
    <div className="moments">
      {moments.map((m) => {
        const live = now >= m.start.getTime() && now < m.end.getTime();
        const upcoming = now < m.start.getTime();
        return (
          <div className="moment" key={m.key}>
            <div className="moment-head">
              <b>{m.label}</b>
              <span>
                {live ? <span className="moment-live">Watching now · </span> : null}
                {fmtTimeIST(m.start)} – {fmtTimeIST(m.end)}
              </span>
            </div>
            {upcoming ? (
              <div className="moment-vals"><span className="muted">Not started yet</span></div>
            ) : (
              <div className="moment-vals">
                {srcs.map((src) => <span key={src.key}>{src.label} <b>{fmtV(v[`${m.key}.${src.key}`])}</b></span>)}
                {srcs.length > 1 && <span>Total <b>{fmtV(v[`${m.key}.total`])}</b></span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const fmtV = (x: string | number | undefined) => (typeof x === "number" ? fmtN(x) : "–");

function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function MarkMomentSheet({ r, onClose }: { r: Run; onClose: () => void }) {
  const { toast } = useUi();
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await markMoment(r, label, minutes, auth.currentUser?.email ?? "someone");
      toast("Noting the highest counts from now");
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Sheet title="Mark a moment" onClose={onClose}>
      <p>Notes the highest count in every stream and Zoom from now on. It shows on this run and in the {"{moments}"} part of the SMS.</p>
      <label className="field"><span>Name</span>
        <input className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Aarti" onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      <label className="field"><span>Watch for</span>
        <select className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {[10, 15, 20, 30, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}
        </select>
      </label>
      <div className="btn-row">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={go}>Start noting</button>
      </div>
    </Sheet>
  );
}

function SendNowSheet({ r, onClose }: { r: Run; onClose: () => void }) {
  const { toast } = useUi();
  const [text, setText] = useState(() => renderTemplate(r.config.sms.template, runValues(r)));
  const [busy, setBusy] = useState(false);
  async function go() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await sendNow(r, text.trim(), auth.currentUser?.email ?? "someone");
      toast("SMS queued. Counting carries on.");
      onClose();
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Sheet title="Send SMS now" onClose={onClose}>
      <p>Goes to {r.config.sms.to} from the sender phone, with the counts so far. You can change the text. Counting carries on and the usual SMS is still sent at the end.</p>
      <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="btn-row">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={go}><Icon name="send" size={14} /> Send</button>
      </div>
    </Sheet>
  );
}
