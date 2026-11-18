"""Count Zoom particants by joining the Zoom web client as a silent guest.

Joins muted with camera off under the configured display name, reads the number on the
Participants button, and subtracts 1 for itself. Zoom changes its web page from time to
time, so selectors are kept loose and a screenshot is saved when something fails.
"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import Browser, Frame, Page, async_playwright

log = logging.getLogger("zoom")
SHOTS = Path("zoom-screenshots")


def parse_link(link: str, passcode: str | None) -> tuple[str, str | None]:
    u = urlparse(link.strip())
    m = re.search(r"/(?:j|wc/join|wc|s|w)/(\d{9,12})", u.path) or re.search(r"(\d{9,12})", link.replace(" ", ""))
    if not m:
        raise ValueError("Could not find the meeting number in the Zoom link")
    pwd = parse_qs(u.query).get("pwd", [None])[0]
    return m.group(1), pwd


def passcode_for(link_pwd: str | None, passcode: str | None) -> str | None:
    """The typed passcode wins (it changes weekly while the link stays the same)."""
    return (passcode or "").strip() or link_pwd


async def _first_visible(page: Page, selectors: list[str], timeout_ms: int = 1500):
    for frame in page.frames:
        for sel in selectors:
            loc = frame.locator(sel).first
            try:
                if await loc.is_visible(timeout=timeout_ms):
                    return loc
            except Exception:  # noqa: BLE001
                continue
    return None


COUNT_JS = r"""
() => {
  const nums = [];
  const push = (s) => { const m = (s || '').match(/(\d[\d,]*)\s*partic/i) || (s || '').match(/partic\w*\D{0,20}(\d[\d,]*)/i); if (m) nums.push(parseInt(m[1].replace(/,/g, ''), 10)); };
  document.querySelectorAll('[aria-label]').forEach(e => push(e.getAttribute('aria-label')));
  document.querySelectorAll('.footer-button__number-counter, [class*="particants-section-container__particants-title"], [class*="number-counter"]').forEach(e => {
    const n = parseInt((e.textContent || '').replace(/[^\d]/g, ''), 10); if (!isNaN(n)) nums.push(n);
  });
  return nums;
}
"""


class ZoomCounter:
    def __init__(self, link: str, passcode: str | None, name: str):
        self.meeting_id, self.url_pwd = parse_link(link, passcode)
        self.pwd = passcode_for(self.url_pwd, passcode)
        self.name = name or "Count"
        self._pw = None
        self.browser: Browser | None = None
        self.page: Page | None = None
        self.joined = False
        self.status = "not joined"

    async def start(self):
        SHOTS.mkdir(exist_ok=True)
        self._pw = await async_playwright().start()
        self.browser = await self._pw.chromium.launch(
            headless=False,  # run under xvfb; the web client behaves better headed
            args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--mute-audio",
                  "--autoplay-policy=no-user-gesture-required"],
        )
        ctx = await self.browser.new_context(
            viewport={"width": 1280, "height": 800}, locale="en-US",
            permissions=["microphone", "camera"],
        )
        self.page = await ctx.new_page()

    async def shot(self, tag: str):
        if self.page:
            try:
                await self.page.screenshot(path=str(SHOTS / f"{tag}.png"))
            except Exception:  # noqa: BLE001
                pass

    async def join(self) -> bool:
        assert self.page
        url = f"https://app.zoom.us/wc/join/{self.meeting_id}"
        if self.url_pwd:
            url += f"?pwd={self.url_pwd}"
        log.info("opening web client for meeting %s", self.meeting_id)
        await self.page.goto(url, wait_until="domcontentloaded", timeout=60000)
        for step in range(40):  # up to ~4 minutes of clicking through join screens
            await asyncio.sleep(6)
            if await self._count_raw() is not None:
                self.joined = True
                self.status = "joined"
                await self._dismiss_audio()
                log.info("joined meeting")
                await self.shot("joined")
                return True
            agree = await _first_visible(self.page, ["button:has-text('I Agree')", "button:has-text('Accept Cookies')", "#onetrust-accept-btn-handler", "button:has-text('Agree')"], 500)
            if agree:
                await agree.click()
                continue
            name_box = await _first_visible(self.page, ["#input-for-name", "input[placeholder*='Name' i]", "input[aria-label*='name' i]"], 500)
            if name_box and not await name_box.input_value():
                await name_box.fill(self.name)
            pwd_box = await _first_visible(self.page, ["#input-for-pwd", "input[type=password]", "input[placeholder*='Passcode' i]"], 500)
            if pwd_box and self.pwd and not await pwd_box.input_value():
                await pwd_box.fill(self.pwd)
            # Turn off mic/camera on the preview screen when the toggles are shown.
            for sel in ["button[aria-label*='Mute' i]", "button[aria-label*='Stop Video' i]", "button[aria-label*='stop my video' i]"]:
                b = await _first_visible(self.page, [sel], 300)
                if b:
                    try:
                        await b.click()
                    except Exception:  # noqa: BLE001
                        pass
            join = await _first_visible(self.page, ["button.preview-join-button", "button:has-text('Join')", "#joinBtn"], 500)
            if join and await join.is_enabled():
                await join.click()
                continue
            body = (await self.page.content()).lower()
            if "waiting room" in body or "host will let you in" in body:
                self.status = "in waiting room"
            elif "captcha" in body:
                self.status = "Zoom asked for a CAPTCHA"
            elif "sign in to join" in body:
                self.status = "meeting requires sign-in"
            elif "has not started" in body or "waiting for the host" in body:
                self.status = "waiting for host to start"
            if step % 5 == 4:
                await self.shot(f"join-step-{step}")
        await self.shot("join-failed")
        return False

    async def _dismiss_audio(self):
        btn = await _first_visible(self.page, ["button:has-text('Continue without audio')", "button[aria-label*='close' i]"], 500)
        if btn:
            try:
                await btn.click()
            except Exception:  # noqa: BLE001
                pass

    async def _count_raw(self) -> int | None:
        assert self.page
        found: list[int] = []
        frames: list[Frame] = list(self.page.frames)
        for f in frames:
            try:
                found += await f.evaluate(COUNT_JS)
            except Exception:  # noqa: BLE001
                continue
        found = [n for n in found if n > 0]
        return max(found) if found else None

    async def read(self) -> int | None:
        """Participants excluding this counter. Rejoins if the page dropped out."""
        if not self.page:
            await self.start()
        if not self.joined:
            if not await self.join():
                return None
        n = await self._count_raw()
        if n is None:
            # Toolbar may be hidden: move the mouse to show it, then retry once.
            try:
                await self.page.mouse.move(640, 700)
                await asyncio.sleep(1)
            except Exception:  # noqa: BLE001
                pass
            n = await self._count_raw()
        if n is None:
            body = (await self.page.content()).lower()
            if "meeting has been ended" in body or "this meeting has ended" in body or "removed" in body:
                self.status = "meeting ended"
                self.joined = False
            return None
        return max(n - 1, 0)

    async def close(self):
        try:
            if self.page:
                leave = await _first_visible(self.page, ["button[aria-label*='Leave' i]", "button:has-text('Leave')"], 500)
                if leave:
                    await leave.click()
                    confirm = await _first_visible(self.page, ["button:has-text('Leave Meeting')"], 2000)
                    if confirm:
                        await confirm.click()
            if self.browser:
                await self.browser.close()
            if self._pw:
                await self._pw.stop()
        except Exception:  # noqa: BLE001
            pass
