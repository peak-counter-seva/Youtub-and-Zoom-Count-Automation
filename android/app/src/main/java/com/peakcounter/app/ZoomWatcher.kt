package com.peakcounter.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.content.MutableContextWrapper
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Joins a Zoom meeting in a hidden browser on this phone as a muted guest and reads the
 * participant count every few seconds. The phone's own internet (home Wi-Fi or mobile data)
 * is what Zoom sees, which it trusts far more than a cloud server.
 *
 * The browser lives in an invisible, untouchable overlay window so it keeps running while the
 * app is closed. If Zoom shows an "I'm not a robot" check, [ZoomActivity] shows the same page
 * so a person can tap through it once.
 *
 * All methods must be called on the main thread.
 */
class ZoomWatcher(
    private val service: Context,
    /** Meeting number: one watcher per meeting, shared by every run that counts it. */
    val id: String,
    val title: String,
    link: String,
    passcode: String?,
    private val name: String,
    /** Called on the main thread with the participant count (excluding this guest) or null. */
    private val onReading: (count: Int?, state: String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val wrapper = MutableContextWrapper(service)
    private val meetingId: String
    private val urlPwd: String?   // the encoded ?pwd= from the link, if any
    private val pwd: String?      // what to type into the passcode box
    private var webView: WebView? = null
    private var inOverlay = false
    private var shownInActivity = false
    private var stopped = false
    private var lastLoad = 0L
    private var notJoinedSince = System.currentTimeMillis()

    var state = "starting"; private set
    var count: Int? = null; private set

    init {
        val parsed = parseLink(link, passcode)
        meetingId = parsed.first
        urlPwd = parsed.second
        pwd = passcode?.trim()?.ifBlank { null } ?: urlPwd
    }

    fun start() {
        active[id] = this
        create()
        main.postDelayed(::tick, TICK_MS)
    }

    fun stop() {
        stopped = true
        active.remove(id)
        main.removeCallbacksAndMessages(null)
        webView?.let { wv ->
            try { wv.evaluateJavascript(LEAVE_JS, null) } catch (_: Exception) {}
            main.postDelayed({
                detachFromAnything()
                wv.loadUrl("about:blank")
                wv.destroy()
            }, 1500)
        }
        webView = null
    }

    /** Move the browser into an Activity so a person can see and tap it (e.g. for a CAPTCHA). */
    fun showIn(activity: Context, container: ViewGroup) {
        val wv = webView ?: return
        detachFromAnything()
        wrapper.baseContext = activity
        container.addView(wv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shownInActivity = true
        // A WebView moved from the hidden window into a screen can stay blank until it is told to redraw.
        wv.visibility = android.view.View.VISIBLE
        wv.alpha = 1f
        wv.onResume()
        wv.resumeTimers()
        wv.post { wv.requestLayout(); wv.invalidate() }
    }

    /** Put the browser back into the hidden overlay when the Activity closes. */
    fun hide() {
        if (!shownInActivity) return
        shownInActivity = false
        detachFromAnything()
        wrapper.baseContext = service
        if (!stopped) attachOverlay()
    }

    /** Load the join page again now (from the Zoom screen's Reload button). */
    fun reloadNow() {
        if (stopped) return
        notJoinedSince = System.currentTimeMillis()
        load()
    }

    // ---------- internals ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun create() {
        val wv = WebView(wrapper)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            userAgentString = DESKTOP_UA
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
        wv.webChromeClient = object : WebChromeClient() {
            // No microphone or camera: the counter only watches.
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        }
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript(VIEWPORT_JS, null)
            }
        }
        webView = wv
        attachOverlay()
        load()
    }

    private fun load() {
        val first = lastLoad == 0L
        lastLoad = System.currentTimeMillis()
        val url = "https://app.zoom.us/wc/join/$meetingId" + (urlPwd?.let { "?pwd=" + Uri.encode(it) } ?: "")
        val wv = webView ?: return
        if (first) { wv.loadUrl(url); return }
        // Leave properly first, so Zoom doesn't keep a second copy of this name in the meeting.
        try { wv.evaluateJavascript(LEAVE_JS, null) } catch (_: Exception) {}
        main.postDelayed({ if (!stopped) webView?.loadUrl(url) }, 3000)
    }

    private fun attachOverlay() {
        val wv = webView ?: return
        if (inOverlay || !Settings.canDrawOverlays(service)) return
        val wm = service.getSystemService(WindowManager::class.java)
        val lp = WindowManager.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply { alpha = 0f }
        try {
            wm.addView(wv, lp)
            inOverlay = true
        } catch (e: Exception) {
            Log.w(TAG, "overlay failed", e)
        }
    }

    private fun detachFromAnything() {
        val wv = webView ?: return
        if (inOverlay) {
            try { service.getSystemService(WindowManager::class.java).removeView(wv) } catch (_: Exception) {}
            inOverlay = false
        }
        (wv.parent as? ViewGroup)?.removeView(wv)
    }

    private fun tick() {
        if (stopped) return
        val wv = webView ?: return
        val js = "($STEP_JS)(${JSONObject.quote(name)}, ${JSONObject.quote(pwd ?: "")})"
        wv.evaluateJavascript(js) { result ->
            if (stopped) return@evaluateJavascript
            var raw: Int? = null
            var st = "joining"
            try {
                val o = JSONObject(result)
                st = o.optString("state", "joining")
                if (!o.isNull("count")) raw = o.getInt("count")
            } catch (_: Exception) {
                // Page still loading.
            }
            val now = System.currentTimeMillis()
            // Never reload while inside the meeting, even if the count can't be read for a moment.
            if (raw != null || st == "in_meeting") notJoinedSince = now
            // Stuck on the join screens or meeting over: start again from the join page now and then.
            val stuckMs = if (st == "ended") 60_000L else 6 * 60_000L
            val canReload = st != "captcha" && st != "waiting_room" && st != "in_meeting"
            if (raw == null && canReload && now - notJoinedSince > stuckMs && now - lastLoad > stuckMs) {
                load()
            }
            state = st
            count = raw?.let { (it - 1).coerceAtLeast(0) }
            onReading(count, st)
            main.postDelayed(::tick, TICK_MS)
        }
    }

    companion object {
        private const val TAG = "ZoomWatcher"
        const val TICK_MS = 3000L
        /** Watchers by meeting number, so the screen can show one. */
        val active = ConcurrentHashMap<String, ZoomWatcher>()

        const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

        fun parseLink(link: String, passcode: String?): Pair<String, String?> {
            val clean = link.trim()
            val id = Regex("/(?:j|wc/join|wc|s|w)/(\\d{9,12})").find(clean)?.groupValues?.get(1)
                ?: Regex("(\\d{9,12})").find(clean.replace(" ", ""))?.groupValues?.get(1)
                ?: throw IllegalArgumentException("Could not find the meeting number in the Zoom link")
            val pwd = try { Uri.parse(clean).getQueryParameter("pwd") } catch (_: Exception) { null }
            return id to pwd?.ifBlank { null }
        }

        fun stateText(state: String, count: Int?): String = when {
            count != null -> "In the meeting · $count participants"
            state == "in_meeting" -> "In the meeting · reading the count…"
            state == "captcha" -> "Zoom wants a robot check. Tap to finish it."
            state == "waiting_room" -> "In the waiting room"
            state == "waiting_host" -> "Waiting for the host to start"
            state == "signin" -> "This meeting needs a Zoom sign-in"
            state == "ended" -> "Meeting ended"
            state == "starting" -> "Opening Zoom…"
            else -> "Joining Zoom…"
        }

        /** Makes Zoom lay out like a desktop page so the participant count is shown. */
        private const val VIEWPORT_JS = """
            (function(){var m=document.querySelector('meta[name=viewport]');
            if(!m){m=document.createElement('meta');m.name='viewport';document.head&&document.head.appendChild(m);}
            m.content='width=1280';})();
        """

        private const val LEAVE_JS = """
            (function(){var b=[...document.querySelectorAll('button')].find(e=>/^leave/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));
            if(b){b.click();setTimeout(function(){var c=[...document.querySelectorAll('button')].find(e=>/leave meeting/i.test(e.innerText||''));if(c)c.click();},500);}})();
        """

        /** One step: read the count, or click one step further through Zoom's join screens. */
        private const val STEP_JS = """
function(name, pwd) {
  var docs = [document];
  document.querySelectorAll('iframe').forEach(function (f) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} });
  function all(sel) { var out = []; docs.forEach(function (d) { try { d.querySelectorAll(sel).forEach(function (e) { out.push(e); }); } catch (e) {} }); return out; }
  function vis(e) { return e && e.getClientRects().length > 0 && !e.disabled; }
  function first(sels) { for (var i = 0; i < sels.length; i++) { var l = all(sels[i]); for (var j = 0; j < l.length; j++) if (vis(l[j])) return l[j]; } return null; }
  function button(rx) { var l = all('button, [role=button]'); for (var i = 0; i < l.length; i++) { var t = (l[i].innerText || l[i].textContent || '').trim(); if (vis(l[i]) && rx.test(t)) return l[i]; } return null; }
  function setVal(el, v) {
    var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var nums = [];
  function push(s) {
    s = s || '';
    var m = s.match(/(\d[\d,]*)\s*partic/i) || s.match(/partic\w*\D{0,20}(\d[\d,]*)/i);
    if (m) nums.push(parseInt(m[1].replace(/,/g, ''), 10));
  }
  all('[aria-label]').forEach(function (e) { push(e.getAttribute('aria-label')); });
  all('.footer-button__number-counter, [class*="particants-section-container__particants-title"], [class*="number-counter"]').forEach(function (e) {
    var n = parseInt((e.textContent || '').replace(/[^\d]/g, ''), 10); if (!isNaN(n)) nums.push(n);
  });
  nums = nums.filter(function (n) { return n > 0; });
  if (nums.length) {
    var later = button(/^continue without audio$/i); if (later) later.click();
    return { count: Math.max.apply(null, nums), state: 'joined' };
  }
  // Inside the meeting but the count isn't readable right now: don't click or reload anything.
  if (first(['#wc-footer', '.footer__inner', '[class*="footer-button-base"]', 'button[aria-label^="leave" i]']))
    return { count: null, state: 'in_meeting' };

  var text = docs.map(function (d) { return (d.body && d.body.innerText) || ''; }).join(' ').toLowerCase();
  // Only a robot check that is really on screen counts. Zoom's join page always carries an invisible
  // reCAPTCHA and the line "protected by reCAPTCHA", which must not stop the join.
  function challengeShown() {
    if (/i['\u2019]?m not a robot|verify you are human|select all images|complete the security check/.test(text)) return true;
    var frames = all('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]');
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], src = f.getAttribute('src') || '';
      if (/size=invisible/.test(src)) continue;
      var r = f.getBoundingClientRect(), cs = (f.ownerDocument.defaultView || window).getComputedStyle(f);
      if (r.width > 100 && r.height > 60 && r.bottom > 0 && r.top < 4000 && cs.visibility === 'visible' && cs.display !== 'none' && cs.opacity !== '0') return true;
    }
    return false;
  }
  if (challengeShown()) return { count: null, state: 'captcha' };
  if (/meeting has been ended|this meeting has ended|you have been removed|removed you from/.test(text)) return { count: null, state: 'ended' };
  if (/sign in to join|only authenticated users/.test(text)) return { count: null, state: 'signin' };

  var agree = button(/^(i agree|agree|accept cookies|accept all cookies|accept)$/i) || first(['#onetrust-accept-btn-handler']);
  if (agree) { agree.click(); return { count: null, state: 'joining' }; }

  var nameBox = first(['#input-for-name', 'input[placeholder*="name" i]', 'input[aria-label*="name" i]']);
  if (nameBox && !nameBox.value) setVal(nameBox, name);
  var pwdBox = first(['#input-for-pwd', 'input[type=password]', 'input[placeholder*="passcode" i]']);
  if (pwdBox && pwd && !pwdBox.value) setVal(pwdBox, pwd);
  ['button[aria-label^="mute" i]', 'button[aria-label^="stop video" i]', 'button[aria-label^="stop my video" i]'].forEach(function (s) {
    var b = first([s]); if (b) b.click();
  });
  var join = first(['button.preview-join-button', '#joinBtn']) || button(/^join$/i);
  if (join) join.click();

  if (/waiting room|host will let you in|please wait, the meeting host/.test(text)) return { count: null, state: 'waiting_room' };
  if (/has not started|waiting for the host|wait for the host/.test(text)) return { count: null, state: 'waiting_host' };
  return { count: null, state: 'joining' };
}
"""
    }
}
