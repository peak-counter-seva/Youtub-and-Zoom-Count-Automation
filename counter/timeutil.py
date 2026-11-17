"""Time helpers. All user-facing times are India time (UTC+05:30, no DST)."""
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


def now() -> datetime:
    return datetime.now(timezone.utc)


def window_for(run_start: datetime, start_hhmm: str, end_hhmm: str) -> tuple[datetime, datetime]:
    """Window (e.g. 24/7 stream from-to) on the IST date of the run start.

    If 'to' is earlier than 'from', the window ends the next day. If the whole window
    ends before the run starts, use the next day's window.
    """
    d = run_start.astimezone(IST).date()
    sh, sm = map(int, start_hhmm.split(":"))
    eh, em = map(int, end_hhmm.split(":"))
    start = datetime(d.year, d.month, d.day, sh, sm, tzinfo=IST)
    end = datetime(d.year, d.month, d.day, eh, em, tzinfo=IST)
    if end <= start:
        end += timedelta(days=1)
    if end <= run_start:
        start += timedelta(days=1)
        end += timedelta(days=1)
    return start, end


def fmt_date(dt: datetime) -> str:
    return dt.astimezone(IST).strftime("%d-%m-%Y")
