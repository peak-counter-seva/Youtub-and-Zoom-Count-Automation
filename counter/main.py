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
ZOOM_EVERY = 3          # seconds between Zoom readings (reading the page is free)
ZOOM_RETRY_EVERY = 20   # seconds between attempts while not in the meeting
SAVE_AT_LEAST_EVERY = 60  # seconds; keeps the website's "alive" signal fresh
STOP_CHECK_EVERY = 15   # seconds between Stop-button checks when nothing was saved
DEFAULT_SAVE_STEP = 5


class Tracker:
    """Holds the newest readings and the exact peaks locally, and decides when a save is worth it.

    A save happens when any count moves by at least `step` since the last save, when a source
    goes live/offline or its note changes, and at least once a minute. Peaks are tracked on every
    reading, so the saved peak is exact even when it rose by less than `step`.
    """

    def __init__(self, step: int):
        self.step = max(1, int(step))
        self.readings: dict[str, dict] = {}
        self.peaks: dict[str, tuple[int, datetime]] = {}
        self.saved: dict[str, dict] = {}
        self.last_save: float | None = None
        self.moments: list[tuple[str, datetime, datetime, str]] = []  # key, start, end, label
        self.mpeaks: dict[tuple[str, str], tuple[int, datetime]] = {}  # (moment, source) -> highest
        self.mpeaks_saved: dict[tuple[str, str], int] = {}

    def update(self, key: str, reading: dict, t: datetime):
        self.readings[key] = reading
        v = reading["value"]
        if v is None:
            return
        if key not in self.peaks or v > self.peaks[key][0]:
            self.peaks[key] = (v, t)
        for mk, ms, me, _ in self.moments:
            if ms <= t < me and ((mk, key) not in self.mpeaks or v > self.mpeaks[(mk, key)][0]):
                self.mpeaks[(mk, key)] = (v, t)

    def moment_payload(self) -> dict[str, dict[str, dict]]:
        out: dict[str, dict[str, dict]] = {}
        for (mk, key), (v, t) in self.mpeaks.items():
            out.setdefault(mk, {})[key] = {"peak": v, "peakAt": t}
        return out

    def due(self, mono: float) -> bool:
        if not self.readings:
            return False
        if self.last_save is None or mono - self.last_save >= SAVE_AT_LEAST_EVERY:
            return True
        for key, r in self.readings.items():
            s = self.saved.get(key)
            if s is None:
                return True
            v, sv = r["value"], s["value"]
            if (v is None) != (sv is None) or r.get("note", "") != s.get("note", ""):
                return True
            if v is not None and abs(v - sv) >= self.step:
                return True
            best = self.peaks.get(key)
            if best and (s["peak"] is None or best[0] - s["peak"] >= self.step):
                return True
        # A moment's highest count rose: save soon so the website shows it.
        if mono - self.last_save >= 10 and any(self.mpeaks_saved.get(k) != v for k, (v, _) in self.mpeaks.items()):
            return True
        return False

    def payload(self) -> dict[str, dict]:
        out = {}
        for key, r in self.readings.items():
            out[key] = dict(r)
            if key in self.peaks:
                out[key]["peak"], out[key]["peakAt"] = self.peaks[key]
        return out

    def mark_saved(self, mono: float):
        self.last_save = mono
        for key, r in self.readings.items():
            best = self.peaks.get(key)
            self.saved[key] = {"value": r["value"], "note": r.get("note", ""), "peak": best[0] if best else None}
        self.mpeaks_saved = {k: v for k, (v, _) in self.mpeaks.items()}


def init_db():
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    cred = credentials.Certificate(json.loads(sa)) if sa else credentials.ApplicationDefault()
    firebase_admin.initialize_app(cred)
    return firestore.client()


def render(template: str, values: dict) -> str:
    return re.sub(r"\{([\w.]+)\}", lambda m: str(values[m.group(1)]) if values.get(m.group(1)) is not None else m.group(0), template)


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

    def merge_peaks(self, readings: dict[str, dict], status: str | None = None, moments: dict | None = None) -> dict:
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
                # The sender phone may count the same source; don't blank out its fresh reading.
                last = p.get("lastAt")
                fresh = last is not None and (ts - last).total_seconds() < 30
                if r["value"] is not None or not fresh:
                    p["current"] = r["value"]
                    p["note"] = r.get("note", "")
                if r["value"] is not None:
                    p["lastAt"] = ts
                # The tracker passes the exact highest value seen (and when), even if it was never saved.
                best = r.get("peak", r["value"])
                if best is not None and (p.get("peak") is None or best > p["peak"]):
                    p["peak"] = best
                    p["peakAt"] = r.get("peakAt") or ts
                    p.pop("manualBy", None)  # the counter saw more than the number typed in
                peaks[key] = p
            upd = {"peaks": peaks, "heartbeatAt": ts, "engine": ENGINE}
            if moments:
                mp = data.get("momentPeaks") or {}
                for mk, per in moments.items():
                    cur = mp.setdefault(mk, {})
                    for key, r in per.items():
                        old = (cur.get(key) or {}).get("peak")
                        if old is None or r["peak"] > old:
                            cur[key] = r
                upd["momentPeaks"] = mp
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
    windows = windows_for(start_at, sources)

    zcfg = cfg.get("zoom") or {}
    zoom = None
    zoom_via = zcfg.get("via") or "phone"  # "phone" (default), "both" or "github"
    if zcfg.get("enabled") and zcfg.get("link") and zoom_via != "phone":
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
    last_error = None
    tracker = Tracker(cfg.get("saveStep") or DEFAULT_SAVE_STEP)
    tracker.moments = moment_windows(data)
    # Each stream can have its own check interval; streams due together share one API call.
    polls = {s["key"]: max(10, int(s.get("pollSeconds") or poll)) for s in sources}
    next_yt = {s["key"]: 0.0 for s in sources}
    tick = min(([ZOOM_EVERY] if zoom else []) + list(polls.values()) or [poll])
    next_zoom = 0.0
    last_stop_check = time.monotonic()
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
            mono = time.monotonic()
            try:
                due_now = [s for s in sources if mono >= next_yt[s["key"]] - 0.5]
                for s in due_now:  # set first so a failing read retries after its interval, not every tick
                    next_yt[s["key"]] = mono + polls[s["key"]]
                if due_now:
                    for key, r in read_youtube(yt, due_now, windows, t).items():
                        tracker.update(key, r, t)
                if zoom and mono >= next_zoom:
                    zn = await read_zoom(zoom)
                    next_zoom = mono + (ZOOM_EVERY if zoom.joined else ZOOM_RETRY_EVERY)
                    tracker.update(zcfg.get("key") or "zoom", {"label": zcfg.get("label") or "Zoom", "value": zn,
                                                              "note": "" if zn is not None else zoom.status}, now())
                last_error = None
            except Exception as e:  # noqa: BLE001 - keep counting through a bad reading
                log.exception("reading failed")
                if str(e) != last_error:
                    run.note(f"Reading failed, will retry: {e}")
                    last_error = str(e)
            if zoom and zoom.status != last_zoom_status:
                run.note(f"Zoom: {zoom.status}")
                last_zoom_status = zoom.status

            stop = False
            if tracker.due(mono):
                data = run.merge_peaks(tracker.payload(), status="running", moments=tracker.moment_payload())
                tracker.mark_saved(mono)
                last_stop_check = mono
                stop = bool(data.get("stopRequested"))
                tracker.moments = moment_windows(data)  # picks up moments marked from the website
                fresh = data
            elif mono - last_stop_check >= STOP_CHECK_EVERY:
                fresh = run.ref.get().to_dict() or {}
                stop = bool(fresh.get("stopRequested"))
                tracker.moments = moment_windows(fresh) or tracker.moments
                last_stop_check = mono
            else:
                fresh = None
            # The automation was edited while running (e.g. today's live link): use the new streams.
            new_yt = ((fresh or {}).get("config") or {}).get("youtube")
            if new_yt is not None and new_yt != sources:
                old_urls = {x["key"]: x.get("url") for x in sources}
                poll = max(10, int(fresh["config"].get("pollSeconds") or poll))
                sources = new_yt
                windows = windows_for(start_at, sources)
                polls = {x["key"]: max(10, int(x.get("pollSeconds") or poll)) for x in sources}
                next_yt = {x["key"]: (next_yt.get(x["key"], 0.0) if old_urls.get(x["key"]) == x.get("url") else 0.0) for x in sources}
                keep = {x["key"] for x in sources} | ({zcfg.get("key") or "zoom"} if zoom else set())
                for k in list(tracker.readings):
                    if k not in keep:
                        tracker.readings.pop(k, None)
                tick = min(([ZOOM_EVERY] if zoom else []) + list(polls.values()) or [poll])
                tracker.step = max(1, int(fresh["config"].get("saveStep") or tracker.step))
                run.note("Settings changed: now counting " + ", ".join(x.get("label") or x["key"] for x in sources) + ".")
            if stop:
                stopped = True
                run.note("Stop requested.")
                break
            await asyncio.sleep(tick)
    finally:
        if tracker.readings:
            try:  # save the exact final values and peaks before the SMS is written
                run.merge_peaks(tracker.payload(), moments=tracker.moment_payload())
            except Exception:  # noqa: BLE001
                log.exception("final save failed")
        if zoom:
            await zoom.close()
        if not handed_over:
            if zcfg.get("enabled") and zoom_via != "github" and not stopped:
                await asyncio.sleep(30)  # let the sender phone save its last Zoom peak
            finish(db, run, stopped)


def windows_for(start_at, sources) -> dict:
    return {s["key"]: window_for(start_at, s["windowStart"], s["windowEnd"])
            for s in sources if s.get("mode") == "window" and s.get("windowStart") and s.get("windowEnd")}


def moment_windows(data: dict) -> list[tuple[str, datetime, datetime, str]]:
    """Moments of a run: fixed ones from the automation (e.g. Aarti 06:00 for 30 min) and ones marked live."""
    if not data.get("startAt"):
        return []
    start_at: datetime = data["startAt"]
    out = []
    for m in (data.get("config") or {}).get("moments") or []:
        if not m.get("key") or not m.get("at"):
            continue
        d = start_at.astimezone(IST).date()
        hh, mm = map(int, m["at"].split(":"))
        ms = datetime(d.year, d.month, d.day, hh, mm, tzinfo=IST)
        me = ms + timedelta(minutes=max(1, int(m.get("minutes") or 30)))
        if me <= start_at:
            ms, me = ms + timedelta(days=1), me + timedelta(days=1)
        out.append((m["key"], ms, me, m.get("label") or m["key"]))
    for m in data.get("extraMoments") or []:
        if m.get("key") and m.get("startAt") and m.get("endAt"):
            out.append((m["key"], m["startAt"], m["endAt"], m.get("label") or m["key"]))
    out.sort(key=lambda x: x[1])
    return out


def build_values(data: dict) -> dict:
    """Every SMS value. Keep in step with buildValues in web/src/lib/types.ts and Values.kt."""
    cfg = data["config"]
    srcs = [(y["key"], y.get("label") or y["key"]) for y in cfg.get("youtube", [])]
    z = cfg.get("zoom") or {}
    if z.get("enabled"):
        srcs.append((z.get("key") or "zoom", z.get("label") or "Zoom"))
    groups = [g for g in cfg.get("totals") or [] if g.get("key")]
    v: dict = {"name": data.get("automationName", ""), "date": fmt_date(data["startAt"])}

    def total(vals):
        nums = [x for x in vals if isinstance(x, (int, float))]
        return sum(nums) if nums else "NA"

    def fill(prefix, get):
        for k, _ in srcs:
            v[prefix + k] = get(k) if get(k) is not None else "NA"
        v[prefix + "total"] = total([get(k) for k, _ in srcs])
        for g in groups:
            v[prefix + g["key"]] = total([get(k) for k in g.get("sources", [])])

    peaks = data.get("peaks") or {}
    fill("", lambda k: (peaks.get(k) or {}).get("peak"))
    mpeaks = data.get("momentPeaks") or {}
    lines = []
    for mk, ms, _me, label in moment_windows(data):
        mp = mpeaks.get(mk) or {}
        fill(mk + ".", lambda k, mp=mp: (mp.get(k) or {}).get("peak"))
        at = ms.astimezone(IST).strftime("%H:%M")
        v[mk + ".time"] = at
        parts = [f"{lab} {v[mk + '.' + k]}" for k, lab in srcs]
        if len(srcs) > 1:
            parts.append(f"Total {v[mk + '.total']}")
        lines.append(f"{label} {at}: {', '.join(parts)}")
    v["moments"] = "\n".join(lines)
    return v


def read_youtube(yt, sources, windows, t) -> dict[str, dict]:
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
            readings[s["key"]] = {"label": s["label"], "value": r.viewers, "note": r.note or ""}
    return readings


async def read_zoom(zoom) -> int | None:
    try:
        return await asyncio.wait_for(zoom.read(), timeout=300)
    except Exception as e:  # noqa: BLE001
        zoom.status = f"error: {e}"
        await zoom.shot("error")
        return None


def finish(db, run: Run, stopped: bool):
    data = run.get()
    cfg = data["config"]
    text = render(cfg["sms"]["template"], build_values(data))
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
