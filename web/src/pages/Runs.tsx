import { resendSms, stopRun } from "../lib/api";
import { useCollection } from "../lib/hooks";
import { fmtDayIST, fmtTimeIST } from "../lib/time";
import type { Run } from "../lib/types";
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

export default function Runs() {
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
          {live.map((r) => <RunCard key={r.id} r={r} />)}
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

function RunCard({ r }: { r: Run }) {
  const { confirm, toast } = useUi();
  const active = isActive(r);
  const stale = active && r.status === "running" && r.heartbeatAt && Date.now() - r.heartbeatAt.toMillis() > 3 * 60000;
  const start = r.startAt?.toDate();
  const end = r.endAt?.toDate();
  const peaks = Object.entries(r.peaks ?? {});

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
          {peaks.map(([k, p]) => (
            <div className="stat" key={k}>
              <div className="stat-label"><Icon name={k.toLowerCase().includes("zoom") ? "users" : "video"} size={14} /><span>{p.label}</span></div>
              <div className="stat-value">{fmtN(p.peak)}</div>
              <div className="stat-sub">
                {active && p.current !== null && p.current !== undefined ? `Now ${fmtN(p.current)} · ` : ""}
                {p.peakAt ? `peak ${fmtTimeIST(p.peakAt.toDate())}` : "no reading yet"}
              </div>
              {p.note && <div className="stat-note">{p.note}</div>}
            </div>
          ))}
        </div>
      )}

      {r.smsText && (
        <div className="sms-out">
          <div className="bubble">{r.smsText}</div>
          <div className={`meta ${r.smsStatus === "failed" ? "failed" : ""}`}>{SMS_TEXT[r.smsStatus ?? "pending"]}</div>
        </div>
      )}

      {r.error && <Notice tone="error">{r.error}</Notice>}

      {(active || r.smsText || (r.log && r.log.length > 0)) && (
        <div className="run-foot">
          {r.log && r.log.length > 0 ? (
            <details className="log" style={{ flex: 1, minWidth: 0 }}>
              <summary><Icon name="chevron" size={14} /> Activity log</summary>
              <pre>{r.log.slice(-30).join("\n")}</pre>
            </details>
          ) : <span />}
          <div className="btn-row" style={{ alignSelf: "flex-start" }}>
            {active && !r.stopRequested && <button className="btn btn-danger btn-sm" onClick={stop}><Icon name="stop" size={12} /> Stop now</button>}
            {active && r.stopRequested && <span className="muted small">Stopping…</span>}
            {!active && r.smsText && <button className="btn btn-sm" onClick={resend}><Icon name="send" size={14} /> Resend SMS</button>}
          </div>
        </div>
      )}
    </div>
  );
}
