"""Peak counter for one run. Started by GitHub Actions with the Firestore run id.

Reads the run's config from Firestore, polls YouTube (and Zoom) until the end time or a stop
request, keeps the highest counts in the run document, and at the end writes the SMS text and
an SMS job for the sender's phone. GitHub jobs stop after 6 hours, so long runs hand over to a
fresh job before that.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

import firebase_admin
import requests
from firebase_admin import credentials, firestore

from timeutil import IST, fmt_date, now, window_for
from youtube import YouTubeReader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("counter")

HANDOVER_AFTER = timedelta(hours=5, minutes=30)
ENGINE = "github"


def init_db():
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    cred = credentials.Certificate(json.loads(sa)) if sa else credentials.ApplicationDefault()
    firebase_admin.initialize_app(cred)
    return firestore.client()


def render(template: str, values: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(values[m.group(1)]) if values.get(m.group(1)) is not None else m.group(0), template)


class Run:
    def __init__(self, db, run_id: str):
        self.db = db
        self.ref = db.collection("runs").document(run_id)
        self.logs: list[str] = []

    def get(self) -> dict:
        snap = self.ref.get()
        if not snap.exists:
            raise SystemExit(f"run {self.ref.id} not found")
        return snap.to_dict()

    def note(self, msg: str):
        log.info(msg)
        stamp = datetime.now(IST).strftime("%H:%M:%S")
        self.ref.update({"log": firestore.ArrayUnion([f"{stamp} {msg}"])})

    def merge_peaks(self, readings: dict[str, dict], status: str | None = None) -> dict:
        """Write current values and raise peaks only upward (the phone backup may also write)."""
        @firestore.transactional
        def tx(transaction):
            snap = self.ref.get(transaction=transaction)
            data = snap.to_dict() or {}
            peaks = data.get("peaks") or {}
            ts = now()
            for key, r in readings.items():
                p = peaks.get(key) or {"label": r["label"], "current": None, "peak": None, "peakAt": None, "lastAt": None}
                p["label"] = r["label"]
                p["current"] = r["value"]
                p["note"] = r.get("note", "")
                if r["value"] is not None:
                    p["lastAt"] = ts
                    if p.get("peak") is None or r["value"] > p["peak"]:
                        p["peak"] = r["value"]
                        p["peakAt"] = ts
                peaks[key] = p
            upd = {"peaks": peaks, "heartbeatAt": ts, "engine": ENGINE}
            if status:
                upd["status"] = status
            transaction.update(self.ref, upd)
            return data
        return tx(self.db.transaction())


def dispatch_continuation(run_id: str) -> bool:
    token, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    if not token or not repo:
        return False
    r = requests.post(
        f"https://api.github.com/repos/{repo}/actions/workflows/counter.yml/dispatches",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
        json={"ref": ref, "inputs": {"run_id": run_id, "continuation": "true"}}, timeout=20,
    )
    return r.status_code == 204


async def main(run_id: str):
    db = init_db()
    run = Run(db, run_id)
    data = run.get()
    if data.get("status") in ("finished", "failed", "stopped"):
        log.info("run already %s", data["status"])
        return
    cfg = data["config"]
    start_at: datetime = data["startAt"]
    end_at: datetime = data["endAt"]
    poll = max(10, int(cfg.get("pollSeconds") or 20))
    job_started = now()

    yt_key = os.environ.get("YOUTUBE_API_KEY") or None
    if not yt_key:
        ysnap = db.collection("config").document("youtube").get()
        yt_key = (ysnap.to_dict() or {}).get("apiKey") if ysnap.exists else None
    yt = YouTubeReader(yt_key)
    sources = cfg.get("youtube", [])
    windows = {s["key"]: window_for(start_at, s["windowStart"], s["windowEnd"])
               for s in sources if s.get("mode") == "window" and s.get("windowStart") and s.get("windowEnd")}

    zcfg = cfg.get("zoom") or {}
    zoom = None
    if zcfg.get("enabled") and zcfg.get("link"):
        from zoom import ZoomCounter
        try:
            zoom = ZoomCounter(zcfg["link"], zcfg.get("passcode"), zcfg.get("displayName") or "Count")
        except ValueError as e:
            run.note(f"Zoom: {e}")

    run.note(f"Counter started on GitHub (YouTube {'API' if yt_key else 'page reading'}; "
             f"{len(sources)} stream(s){'; Zoom' if zoom else ''}). Ends {end_at.astimezone(IST):%d %b %H:%M} IST.")

    # Wait for the start time, staying responsive to Stop.
    if now() < start_at:
        run.ref.update({"status": "waiting", "heartbeatAt": now(), "engine": ENGINE})
        while now() < start_at:
            if (run.ref.get().to_dict() or {}).get("stopRequested"):
                break
            run.ref.update({"heartbeatAt": now()})
            await asyncio.sleep(min(60, max(1, (start_at - now()).total_seconds())))

    handed_over = False
    stopped = False
    last_zoom_status = None
    try:
        while True:
            t = now()
            if t >= end_at:
                break
            if t - job_started > HANDOVER_AFTER:
                if dispatch_continuation(run_id):
                    run.note("Handing over to a fresh GitHub job (6-hour limit).")
                    handed_over = True
                    return
            try:
                data = await poll_once(run, yt, sources, windows, zoom, zcfg, t)
            except Exception as e:  # noqa: BLE001 - keep counting through a bad reading
                log.exception("poll failed")
                run.note(f"Reading failed, will retry: {e}")
                await asyncio.sleep(poll)
                continue
            if zoom and zoom.status != last_zoom_status:
                run.note(f"Zoom: {zoom.status}")
                last_zoom_status = zoom.status
            if data.get("stopRequested"):
                stopped = True
                run.note("Stop requested.")
                break
            await asyncio.sleep(poll)
    finally:
        if zoom:
            await zoom.close()
        if not handed_over:
            finish(db, run, stopped)


async def poll_once(run, yt, sources, windows, zoom, zcfg, t) -> dict:
            readings: dict[str, dict] = {}

            ids = yt.ids_for([s["url"] for s in sources], time.time())
            res = yt.read([v for v in ids.values() if v])
            for s in sources:
                vid = ids.get(s["url"])
                r = res.get(vid) if vid else None
                in_window = True
                if s["key"] in windows:
                    ws, we = windows[s["key"]]
                    in_window = ws <= t < we
                if r is None:
                    readings[s["key"]] = {"label": s["label"], "value": None, "note": "no live video found"}
                elif not in_window:
                    readings[s["key"]] = {"label": s["label"], "value": None, "note": "outside its time window"}
                elif not r.live or r.viewers is None:
                    readings[s["key"]] = {"label": s["label"], "value": None, "note": r.note or "not live yet"}
                else:
                    readings[s["key"]] = {"label": s["label"], "value": r.viewers, "note": r.note}

            if zoom:
                try:
                    zn = await asyncio.wait_for(zoom.read(), timeout=300)
                except Exception as e:  # noqa: BLE001
                    zn = None
                    zoom.status = f"error: {e}"
                    await zoom.shot("error")
                readings[zcfg.get("key") or "zoom"] = {"label": zcfg.get("label") or "Zoom", "value": zn,
                                                        "note": "" if zn is not None else zoom.status}

            return run.merge_peaks(readings, status="running")


def finish(db, run: Run, stopped: bool):
    data = run.get()
    cfg = data["config"]
    peaks = data.get("peaks") or {}
    values = {"name": data.get("automationName", ""), "date": fmt_date(data["startAt"])}
    for k, p in peaks.items():
        values[k] = p.get("peak") if p.get("peak") is not None else "NA"
    text = render(cfg["sms"]["template"], values)
    batch = db.batch()
    batch.update(run.ref, {"status": "stopped" if stopped else "finished", "smsText": text, "smsStatus": "pending",
                           "finishedAt": now(), "heartbeatAt": now()})
    job = db.collection("smsJobs").document()
    batch.set(job, {"runId": run.ref.id, "deviceId": cfg["sms"].get("senderDeviceId", ""), "to": cfg["sms"]["to"],
                    "text": text, "status": "pending", "createdAt": firestore.SERVER_TIMESTAMP})
    batch.commit()
    run.note(f"Finished. SMS queued: {text}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    args = ap.parse_args()
    asyncio.run(main(args.run_id))
