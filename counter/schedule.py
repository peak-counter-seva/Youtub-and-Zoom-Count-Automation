"""Starts automations that have "Start by itself" switched on.

Runs every few minutes on GitHub (.github/workflows/schedule.yml). For each such automation, it
makes today's run about 20 minutes before the start time (the counter then waits for the start)
and starts the counter job, exactly as pressing Start on the website does.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from firebase_admin import firestore

from main import dispatch_run, init_db
from timeutil import IST, now

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("schedule")
LEAD = timedelta(minutes=20)


def window(start_hhmm: str, end_hhmm: str, t: datetime) -> tuple[datetime, datetime]:
    """Same as computeWindow on the website: today's window, or tomorrow's if today's is over."""
    d = t.astimezone(IST).date()
    sh, sm = map(int, start_hhmm.split(":"))
    eh, em = map(int, end_hhmm.split(":"))
    s = datetime(d.year, d.month, d.day, sh, sm, tzinfo=IST)
    e = datetime(d.year, d.month, d.day, eh, em, tzinfo=IST)
    if e <= s:
        e += timedelta(days=1)
    if e <= t:
        s, e = s + timedelta(days=1), e + timedelta(days=1)
    return s, e


def main():
    db = init_db()
    t = now()
    for snap in db.collection("automations").where("autoStart", "==", True).stream():
        a = snap.to_dict()
        try:
            s, e = window(a["startTime"], a["endTime"], t)
        except (KeyError, ValueError):
            continue
        days = a.get("autoDays") or []
        if days and (s.astimezone(IST).weekday() + 1) % 7 not in days:
            continue
        if not (s - LEAD <= t < e):
            continue
        # Skip if today's run already exists (started by hand or by an earlier check).
        existing = db.collection("runs").where("automationId", "==", snap.id).where("startAt", "==", s).limit(1).get()
        if existing:
            continue
        run_id = f"auto-{snap.id}-{s.astimezone(IST):%Y%m%d%H%M}"
        config = {k: v for k, v in a.items() if k not in ("updatedAt", "linksUpdatedAt")}
        ref = db.collection("runs").document(run_id)
        try:
            ref.create({
                "automationId": snap.id, "automationName": a.get("name", ""), "config": config,
                "status": "queued", "requestedBy": "auto-start", "createdAt": firestore.SERVER_TIMESTAMP,
                "startAt": s, "endAt": e, "peaks": {},
                "log": [f"{datetime.now(IST):%H:%M:%S} Started by itself (Start by itself is on)."],
            })
        except Exception as ex:  # noqa: BLE001 - already created by an overlapping check
            log.info("run %s exists: %s", run_id, ex)
            continue
        ok = dispatch_run(run_id)
        log.info("auto-started %s (%s) dispatch=%s", a.get("name"), run_id, ok)
        if not ok:
            ref.update({"log": firestore.ArrayUnion(["Could not start the GitHub counter; the phone backup will count YouTube."])})


if __name__ == "__main__":
    main()
