"""Read YouTube concurrent live viewers.

Primary: YouTube Data API v3 videos.list (1 quota unit per call, up to 50 ids per call).
Fallback: read the public watch page when no API key is set or the API fails.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

import requests

log = logging.getLogger("youtube")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


@dataclass
class Reading:
    live: bool
    viewers: int | None
    note: str = ""


def video_id_from_url(url: str) -> str | None:
    """Return the video id if the link names one directly, else None (e.g. a channel /live link)."""
    url = url.strip()
    if ID_RE.match(url):
        return url
    u = urlparse(url if "://" in url else "https://" + url)
    host = (u.hostname or "").lower()
    if host.endswith("youtu.be"):
        vid = u.path.strip("/").split("/")[0]
        return vid if ID_RE.match(vid) else None
    if "youtube.com" in host:
        q = parse_qs(u.query)
        if "v" in q and ID_RE.match(q["v"][0]):
            return q["v"][0]
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in ("live", "shorts", "embed", "v") and ID_RE.match(parts[1]):
            return parts[1]
    return None


def resolve_live_id(url: str, session: requests.Session) -> str | None:
    """For channel links like youtube.com/@name/live, find the current live video id."""
    try:
        r = session.get(url, headers={"User-Agent": UA, "Accept-Language": "en"}, timeout=20,
                        cookies={"CONSENT": "YES+1"})
        m = re.search(r'<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})"', r.text)
        if m:
            return m.group(1)
        m = re.search(r'"videoId":"([A-Za-z0-9_-]{11})"', r.text)
        return m.group(1) if m else None
    except requests.RequestException as e:
        log.warning("resolve failed for %s: %s", url, e)
        return None


def _channel_streams_url(url: str) -> str:
    u = url.strip()
    if "://" not in u:
        u = "https://" + u
    u = u.split("?")[0].rstrip("/")
    u = re.sub(r"/(live|streams|featured|videos|about)$", "", u)
    return u + "/streams"


def _walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


def find_live_by_title(channel_url: str, words: str, session: requests.Session) -> str | None:
    """Find a channel's stream whose title contains `words`: one live now first, else an upcoming one.

    Reads the channel's public Live tab page, so it costs no API units.
    """
    want = words.strip().casefold()
    try:
        r = session.get(_channel_streams_url(channel_url), headers={"User-Agent": UA, "Accept-Language": "en"},
                        timeout=20, cookies={"CONSENT": "YES+1"})
        m = re.search(r"var ytInitialData\s*=\s*(\{.*?\});\s*</script>", r.text, re.S)
        if not m:
            return None
        data = json.loads(m.group(1))
    except (requests.RequestException, ValueError) as e:
        log.warning("channel search failed for %s: %s", channel_url, e)
        return None
    live, upcoming = None, None
    for node in _walk(data):
        v = node.get("videoRenderer") or node.get("gridVideoRenderer")
        if not isinstance(v, dict) or "videoId" not in v:
            continue
        t = v.get("title") or {}
        title = t.get("simpleText") or "".join(x.get("text", "") for x in t.get("runs", []))
        if want not in title.casefold():
            continue
        blob = json.dumps(v.get("thumbnailOverlays", [])) + json.dumps(v.get("badges", []))
        if "LIVE" in blob and "UPCOMING" not in blob:
            live = live or v["videoId"]
        elif "UPCOMING" in blob or "upcomingEventData" in v:
            upcoming = upcoming or v["videoId"]
    return live or upcoming


def fetch_api(ids: list[str], api_key: str, session: requests.Session) -> dict[str, Reading]:
    out: dict[str, Reading] = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        r = session.get(
            "https://www.googleapis.com/youtube/v3/videos",
            params={"part": "liveStreamingDetails,snippet", "id": ",".join(chunk), "key": api_key},
            timeout=20,
        )
        r.raise_for_status()
        for item in r.json().get("items", []):
            lsd = item.get("liveStreamingDetails", {})
            live = item.get("snippet", {}).get("liveBroadcastContent") == "live"
            cv = lsd.get("concurrentViewers")
            out[item["id"]] = Reading(live=live, viewers=int(cv) if cv is not None else None)
        for vid in chunk:
            out.setdefault(vid, Reading(live=False, viewers=None, note="video not found"))
    return out


def fetch_page(vid: str, session: requests.Session) -> Reading:
    r = session.get(f"https://www.youtube.com/watch?v={vid}", headers={"User-Agent": UA, "Accept-Language": "en"},
                    timeout=20, cookies={"CONSENT": "YES+1"})
    text = r.text
    live = '"isLiveNow":true' in text or '"isLive":true' in text
    m = re.search(r'"originalViewCount":"(\d+)"', text)
    if not m:
        m = re.search(r'"text":"([\d,]+)"\},\{"text":" watching now"', text)
    if not m:
        m = re.search(r'([\d,]+) watching now', text)
    viewers = int(m.group(1).replace(",", "")) if (m and live) else None
    return Reading(live=live, viewers=viewers, note="read from page")


class YouTubeReader:
    def __init__(self, api_key: str | None):
        self.api_key = api_key
        self.session = requests.Session()
        self._resolved: dict[str, tuple[str | None, float]] = {}

    def id_for_title(self, url: str, words: str, now_ts: float) -> str | None:
        """Today's stream on a channel by title words. Looked up again every 2 minutes (every minute until found)."""
        key = url + "|" + words
        cached = self._resolved.get(key)
        if not cached or now_ts - cached[1] > (120 if cached[0] else 60):
            self._resolved[key] = (find_live_by_title(url, words, self.session), now_ts)
        return self._resolved[key][0]

    def ids_for(self, urls: list[str], now_ts: float) -> dict[str, str | None]:
        out = {}
        for url in urls:
            vid = video_id_from_url(url)
            if vid is None:
                cached = self._resolved.get(url)
                if not cached or now_ts - cached[1] > 300 or cached[0] is None:
                    self._resolved[url] = (resolve_live_id(url, self.session), now_ts)
                vid = self._resolved[url][0]
            out[url] = vid
        return out

    def read(self, ids: list[str]) -> dict[str, Reading]:
        ids = [i for i in dict.fromkeys(ids) if i]
        if not ids:
            return {}
        if self.api_key:
            try:
                return fetch_api(ids, self.api_key, self.session)
            except Exception as e:  # noqa: BLE001 - fall back to page reading
                log.warning("API failed, reading pages instead: %s", e)
        out = {}
        for vid in ids:
            try:
                out[vid] = fetch_page(vid, self.session)
            except Exception as e:  # noqa: BLE001
                out[vid] = Reading(live=False, viewers=None, note=f"read failed: {e}")
        return out
