import { resendSms, stopRun } from "../lib/api";
import { useCollection } from "../lib/hooks";
import { fmtIST } from "../lib/time";
import type { Run } from "../lib/types";

const STATUS_TEXT: Record<Run["status"], string> = {
  queued: "Starting",
  waiting: "Waiting for start time",
  running: "Counting",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

export default function Runs() {
  const { items, error } = useCollection<Run>("runs", "createdAt", 30);
  return (
    <div>
      <h2>Runs</h2>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && <p className="muted">No runs yet.</p>}
      {items.map((r) => {
        const active = ["queued", "waiting", "running"].includes(r.status);
        const stale = active && r.heartbeatAt && Date.now() - r.heartbeatAt.toMillis() > 3 * 60000;
        return (
          <div className={`card ${active ? "active" : ""}`} key={r.id}>
            <div className="row between">
              <h3>{r.automationName}</h3>
              <span className={`badge ${r.status}`}>{STATUS_TEXT[r.status]}</span>
            </div>
            <div className="muted small">
              {fmtIST(r.startAt?.toDate())} → {fmtIST(r.endAt?.toDate())} · by {r.requestedBy}
              {r.engine ? ` · counter: ${r.engine}` : ""}
            </div>
            {stale && <p className="error small">No update from the counter for 3+ minutes. The phone backup should take over YouTube.</p>}
            <table>
              <thead><tr><th>Source</th><th>Now</th><th>Highest</th><th>At</th></tr></thead>
              <tbody>
                {Object.entries(r.peaks ?? {}).map(([k, p]) => (
                  <tr key={k}>
                    <td>{p.label} <span className="muted small">{`{${k}}`}</span>{p.note && <div className="muted small">{p.note}</div>}</td>
                    <td>{p.current ?? "-"}</td>
                    <td><b>{p.peak ?? "-"}</b></td>
                    <td className="small">{fmtIST(p.peakAt?.toDate())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.smsText && (
              <p className="preview">
                SMS ({r.smsStatus ?? "pending"}): {r.smsText}
              </p>
            )}
            {r.error && <p className="error small">{r.error}</p>}
            {r.log && r.log.length > 0 && (
              <details><summary className="small">Log</summary><pre>{r.log.slice(-20).join("\n")}</pre></details>
            )}
            <div className="row">
              {active && !r.stopRequested && <button className="danger" onClick={() => confirm("Stop now and send the SMS with the counts so far?") && stopRun(r.id)}>Stop now</button>}
              {r.stopRequested && active && <span className="muted small">Stopping…</span>}
              {r.smsText && !active && <button onClick={() => resendSms(r)}>Resend SMS</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
