package com.peakcounter.app

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.SetOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlin.math.abs
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Runs while the phone app is switched on:
 *  - sends SMS jobs addressed to this phone from its SIM,
 *  - keeps this phone marked online in the web app,
 *  - backup: if the GitHub counter goes quiet during a run that sends from this phone,
 *    counts YouTube itself and sends the result at the end time,
 *  - Zoom: joins the meeting in a hidden browser on this phone and counts participants
 *    (see [ZoomWatcher]); this works from home internet where Zoom often blocks cloud servers.
 */
class CounterService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val db by lazy { FirebaseFirestore.getInstance() }
    private lateinit var prefs: Prefs
    private var smsListener: ListenerRegistration? = null
    private var runListener: ListenerRegistration? = null
    private val activeRuns = mutableMapOf<String, DocumentSnapshot>()
    private var wakeLock: PowerManager.WakeLock? = null

    /** Zoom meetings being counted, by meeting number. Touched only on the main thread. */
    private val zoomMeetings = mutableMapOf<String, ZoomMeeting>()
    private val zoomFailed = mutableSetOf<String>()

    private class ZoomMeeting(val id: String) {
        lateinit var watcher: ZoomWatcher
        val runs = mutableMapOf<String, RunZoom>()
        var captchaShown = false
    }

    /** One run's share of a meeting's count. */
    private class RunZoom(val runId: String, val key: String, val label: String, val step: Int) {
        lateinit var doc: DocumentSnapshot
        @Volatile var count: Int? = null
        @Volatile var state: String = "starting"
        @Volatile var localPeak: Int? = null
        @Volatile var localPeakAt: Timestamp? = null
        val momentPeaks = java.util.concurrent.ConcurrentHashMap<String, Pair<Int, Timestamp>>()
        val savedMoments = java.util.concurrent.ConcurrentHashMap<String, Int>()
        @Volatile var savedValue: Int? = null
        @Volatile var savedPeak: Int? = null
        @Volatile var savedState: String = ""
        @Volatile var lastSave = 0L
        @Volatile var saving = false
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        val n = notification("Waiting for SMS jobs and runs")
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "peakcounter:service").apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (smsListener == null) {
            listenSms()
            listenRuns()
            scope.launch { heartbeatLoop(user.uid, user.email ?: "") }
            scope.launch { backupLoop() }
            scope.launch { zoomLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        zoomMeetings.values.forEach { it.watcher.stop() }
        zoomMeetings.clear()
        smsListener?.remove()
        runListener?.remove()
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, App.CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setColor(0xFF0E6B55.toInt())
            .setContentTitle("Peak Counter is on")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(android.app.NotificationManager::class.java).notify(1, notification(text))
    }

    private suspend fun heartbeatLoop(uid: String, email: String) {
        try { migrateDeviceId(uid) } catch (e: Exception) { Log.w(TAG, "device id move failed", e) }
        while (scope.isActive) {
            try {
                db.collection("devices").document(prefs.deviceId).set(
                    mapOf(
                        "ownerUid" to uid,
                        "ownerEmail" to email,
                        "label" to prefs.label.ifBlank { Build.MODEL },
                        "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
                        "lastSeen" to FieldValue.serverTimestamp(),
                        "appVersion" to BuildConfig.VERSION_NAME,
                    ),
                    SetOptions.merge(),
                ).await()
            } catch (e: Exception) {
                Log.w(TAG, "heartbeat failed", e)
            }
            try { passcodeReminders() } catch (e: Exception) { Log.w(TAG, "passcode check failed", e) }
            delay(5 * 60_000L)
        }
    }

    /**
     * Older app versions gave the phone a random id that changed on every reinstall. Move
     * automations, live runs and waiting SMS from that old id to this phone's lasting id.
     * The old id is known if the app wasn't reinstalled; otherwise, if this account has exactly
     * one phone from an older version, that is taken to be this phone.
     */
    private suspend fun migrateDeviceId(uid: String) {
        val newId = prefs.deviceId
        val mine = db.collection("devices").whereEqualTo("ownerUid", uid).get().await().documents
        val old = prefs.oldDeviceId?.let { o -> mine.filter { it.id == o } }?.takeIf { it.isNotEmpty() }
            ?: mine.filter { it.id != newId && it.getString("model") == null }.takeIf { it.size == 1 }
            ?: return
        for (od in old) {
            if (od.id == newId) continue
            if (prefs.label.isBlank()) od.getString("label")?.let { prefs.label = it }
            val batch = db.batch()
            db.collection("automations").whereEqualTo("sms.senderDeviceId", od.id).get().await()
                .forEach { batch.update(it.reference, "sms.senderDeviceId", newId) }
            db.collection("runs").whereEqualTo("config.sms.senderDeviceId", od.id).get().await()
                .filter { it.getString("status") in ACTIVE }
                .forEach { batch.update(it.reference, "config.sms.senderDeviceId", newId) }
            db.collection("smsJobs").whereEqualTo("deviceId", od.id).whereEqualTo("status", "pending").get().await()
                .forEach { batch.update(it.reference, "deviceId", newId) }
            batch.delete(od.reference)
            batch.commit().await()
        }
        prefs.oldDeviceId = null
    }

    /** Once a day, on and after the weekly passcode-change day, remind until the new passcode is saved. */
    private suspend fun passcodeReminders() {
        val hour = java.util.Calendar.getInstance(IST).get(java.util.Calendar.HOUR_OF_DAY)
        if (hour < 7 || hour >= 22) return
        val today = SimpleDateFormat("yyyyMMdd", Locale.US).apply { timeZone = IST }.format(java.util.Date())
        val due = db.collection("automations").whereEqualTo("sms.senderDeviceId", prefs.deviceId).get().await()
            .documents.filter { Values.passcodeDue(it) }
        val done = prefs.passcodeNotified.split(",").filter { it.endsWith(":$today") }.toMutableSet()
        for (a in due) {
            val tag = "${a.id}:$today"
            if (tag in done) continue
            done += tag
            val name = a.getString("name") ?: "your automation"
            val n = NotificationCompat.Builder(this, App.ALERTS)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(0xFF0E6B55.toInt())
                .setContentTitle("New Zoom passcode?")
                .setContentText("Update the Zoom passcode for $name on the website.")
                .setStyle(NotificationCompat.BigTextStyle().bigText("The host changes the Zoom passcode this week. Open the website, edit “$name” and save the new passcode."))
                .setContentIntent(PendingIntent.getActivity(this, 3,
                    Intent(Intent.ACTION_VIEW, android.net.Uri.parse(WEB_URL)), PendingIntent.FLAG_IMMUTABLE))
                .setAutoCancel(true)
                .build()
            getSystemService(android.app.NotificationManager::class.java).notify(100 + (a.id.hashCode() and 0xffff), n)
        }
        prefs.passcodeNotified = done.joinToString(",")
    }

    // ---------- SMS sending ----------

    private fun listenSms() {
        smsListener = db.collection("smsJobs")
            .whereEqualTo("deviceId", prefs.deviceId)
            .whereEqualTo("status", "pending")
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.w(TAG, "sms listen failed", err); return@addSnapshotListener }
                snap?.documents?.forEach { doc -> scope.launch { sendJob(doc.id) } }
            }
    }

    private suspend fun sendJob(jobId: String) {
        val ref = db.collection("smsJobs").document(jobId)
        // Claim the job so it is sent only once.
        val job = try {
            db.runTransaction { tx ->
                val s = tx.get(ref)
                if (s.getString("status") != "pending") null
                else { tx.update(ref, "status", "sending"); s.data }
            }.await()
        } catch (e: Exception) { Log.w(TAG, "claim failed", e); null } ?: return

        val to = job["to"] as? String ?: return
        val text = job["text"] as? String ?: return
        val runId = job["runId"] as? String
        var status = "sent"
        var error: String? = null
        try {
            Sms.send(this, to, text, prefs.subscriptionId)
            updateNotification("Sent SMS to $to")
        } catch (e: Exception) {
            status = "failed"; error = e.message ?: e.javaClass.simpleName
        }
        ref.update(mapOf("status" to status, "sentAt" to FieldValue.serverTimestamp(), "error" to error)).await()
        if (runId != null) {
            db.collection("runs").document(runId).update(
                mapOf("smsStatus" to status, "log" to FieldValue.arrayUnion("${clock()} Phone: SMS $status${error?.let { " ($it)" } ?: ""}")),
            ).await()
        }
    }

    // ---------- Backup counting ----------

    private fun listenRuns() {
        runListener = db.collection("runs")
            .whereEqualTo("config.sms.senderDeviceId", prefs.deviceId)
            .addSnapshotListener { snap, err ->
                if (err != null) { Log.w(TAG, "runs listen failed", err); return@addSnapshotListener }
                synchronized(activeRuns) {
                    snap?.documents?.forEach { d ->
                        if (d.getString("status") in ACTIVE) activeRuns[d.id] = d else activeRuns.remove(d.id)
                    }
                }
            }
    }

    private suspend fun backupLoop() {
        var apiKey: String? = null
        while (scope.isActive) {
            val runs = synchronized(activeRuns) { activeRuns.values.toList() }
            if (runs.isEmpty()) {
                wakeLock?.let { if (it.isHeld) it.release() }
            } else {
                wakeLock?.acquire(15 * 60_000L)
                if (apiKey == null) apiKey = try {
                    db.collection("config").document("youtube").get().await().getString("apiKey")
                } catch (e: Exception) { null }
            }
            for (r in runs) {
                try { backupOne(r.id, apiKey) } catch (e: Exception) { Log.w(TAG, "backup failed", e) }
            }
            delay(30_000L)
        }
    }

    private suspend fun backupOne(runId: String, apiKey: String?) {
        val ref = db.collection("runs").document(runId)
        val d = ref.get().await()
        if (d.getString("status") !in ACTIVE) return
        val now = Timestamp.now()
        val startAt = d.getTimestamp("startAt") ?: return
        val endAt = d.getTimestamp("endAt") ?: return
        val created = d.getTimestamp("createdAt") ?: startAt
        val beat = d.getTimestamp("heartbeatAt")
        val githubQuiet = if (beat == null) secs(created, now) > 5 * 60 else secs(beat, now) > 3 * 60
        if (!githubQuiet) return

        val stop = d.getBoolean("stopRequested") == true
        if (now.seconds >= endAt.seconds + 120 || stop) {
            finish(ref, stop)
            return
        }
        if (now.seconds < startAt.seconds || apiKey.isNullOrBlank()) return

        @Suppress("UNCHECKED_CAST")
        val cfg = d.get("config") as? Map<String, Any?> ?: return
        @Suppress("UNCHECKED_CAST")
        val sources = cfg["youtube"] as? List<Map<String, Any?>> ?: emptyList()
        val ids = sources.associate { (it["key"] as String) to YouTube.videoId(it["url"] as? String ?: "") }
        val values = YouTube.read(ids.values.filterNotNull(), apiKey)
        val readings = mutableMapOf<String, Pair<String, Long?>>()
        val inMoments = Values.moments(d).filter { now.seconds in it.start until it.end }
        for (s in sources) {
            val key = s["key"] as String
            var v = ids[key]?.let { values[it] }
            if (s["mode"] == "window" && !inWindow(startAt, s["windowStart"] as? String, s["windowEnd"] as? String, now)) v = null
            readings[key] = (s["label"] as? String ?: key) to v
        }
        db.runTransaction { tx ->
            val cur = tx.get(ref)
            @Suppress("UNCHECKED_CAST")
            val peaks = (cur.get("peaks") as? Map<String, Map<String, Any?>> ?: emptyMap()).toMutableMap()
            for ((key, pair) in readings) {
                val p = (peaks[key] ?: emptyMap()).toMutableMap()
                p["label"] = pair.first
                p["current"] = pair.second
                p["note"] = if (pair.second == null) "phone backup: not live" else "phone backup"
                val old = (p["peak"] as? Number)?.toLong()
                if (pair.second != null) {
                    p["lastAt"] = now
                    if (old == null || pair.second!! > old) { p["peak"] = pair.second; p["peakAt"] = now; p.remove("manualBy") }
                }
                peaks[key] = p
            }
            val add = readings.filterValues { it.second != null }
                .mapValues { (_, pair) -> inMoments.associate { it.key to (pair.second!!.toInt() to now) } }
            val upd = mutableMapOf<String, Any?>("peaks" to peaks, "backupAt" to now, "engine" to "phone backup", "status" to "running")
            if (inMoments.isNotEmpty() && add.isNotEmpty()) upd["momentPeaks"] = mergeMoments(cur, add)
            tx.update(ref, upd)
        }.await()
        updateNotification("Backup counting: ${d.getString("automationName")}")
    }

    private suspend fun finish(ref: com.google.firebase.firestore.DocumentReference, stopped: Boolean) {
        val jobRef = db.collection("smsJobs").document()
        db.runTransaction { tx ->
            val d = tx.get(ref)
            if (d.getString("status") !in ACTIVE) return@runTransaction
            @Suppress("UNCHECKED_CAST")
            val cfg = d.get("config") as Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val sms = cfg["sms"] as Map<String, Any?>
            val text = Values.render(sms["template"] as String, Values.build(d))
            tx.update(ref, mapOf(
                "status" to if (stopped) "stopped" else "finished",
                "smsText" to text, "smsStatus" to "pending", "finishedAt" to Timestamp.now(),
                "log" to FieldValue.arrayUnion("${clock()} Phone backup finished the run (GitHub counter was quiet)."),
            ))
            tx.set(jobRef, mapOf(
                "runId" to ref.id, "deviceId" to prefs.deviceId, "to" to sms["to"], "text" to text,
                "status" to "pending", "createdAt" to FieldValue.serverTimestamp(),
            ))
        }.await()
    }

    // ---------- Zoom counting on this phone ----------

    /**
     * One hidden Zoom browser per meeting, even when several runs count the same meeting, so the
     * meeting shows this phone's name only once. Each reading is shared with every run.
     */
    private suspend fun zoomLoop() {
        while (scope.isActive) {
            val runs = synchronized(activeRuns) { activeRuns.values.toList() }
            val nowS = Timestamp.now().seconds
            val want = mutableMapOf<String, MutableList<DocumentSnapshot>>() // meeting number -> runs
            for (d in runs) {
                @Suppress("UNCHECKED_CAST")
                val cfg = d.get("config") as? Map<String, Any?> ?: continue
                @Suppress("UNCHECKED_CAST")
                val z = cfg["zoom"] as? Map<String, Any?> ?: continue
                if (z["enabled"] != true || z["via"] == "github") continue
                val link = (z["link"] as? String)?.ifBlank { null } ?: continue
                val start = d.getTimestamp("startAt")?.seconds ?: continue
                val end = d.getTimestamp("endAt")?.seconds ?: continue
                if (d.getBoolean("stopRequested") == true) continue
                // Join 2 minutes early; stay until just after the end so the last peak is saved
                // before the GitHub counter writes the SMS (it waits 30 s for this).
                if (nowS < start - 120 || nowS >= end + 15) continue
                val meeting = try { ZoomWatcher.parseLink(link, null).first } catch (e: IllegalArgumentException) {
                    if (zoomFailed.add(d.id)) scope.launch { note(d.id, "Phone: ${e.message}") }
                    continue
                }
                want.getOrPut(meeting) { mutableListOf() } += d
            }
            withContext(Dispatchers.Main) {
                for (mid in zoomMeetings.keys.toList()) {
                    val m = zoomMeetings[mid] ?: continue
                    val keep = want[mid]?.map { it.id }?.toSet() ?: emptySet()
                    for (rid in m.runs.keys.toList()) {
                        if (rid !in keep) {
                            val r = m.runs.remove(rid) ?: continue
                            scope.launch { saveZoom(r); note(rid, "Phone: stopped counting Zoom. Highest seen ${r.localPeak ?: "none"}.") }
                        }
                    }
                    if (m.runs.isEmpty()) {
                        zoomMeetings.remove(mid)
                        m.watcher.stop()
                        cancelCaptcha()
                    }
                }
                for ((mid, docs) in want) {
                    val m = zoomMeetings[mid] ?: startMeeting(mid, docs.first()) ?: continue
                    for (d in docs) {
                        val r = m.runs[d.id]
                        if (r != null) { r.doc = d; continue }
                        m.runs[d.id] = newRunZoom(d)
                        if (m.runs.size > 1) scope.launch { note(d.id, "Phone: already in this Zoom meeting for another run, sharing that count.") }
                        else scope.launch {
                            note(d.id, if (android.provider.Settings.canDrawOverlays(this@CounterService)) "Phone: opening Zoom to count participants."
                                       else "Phone: opening Zoom without 'Display over other apps' permission; counting may pause when the screen is off.")
                        }
                    }
                }
            }
            delay(10_000L)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun newRunZoom(d: DocumentSnapshot): RunZoom {
        val cfg = d.get("config") as Map<String, Any?>
        val z = cfg["zoom"] as Map<String, Any?>
        return RunZoom(
            runId = d.id,
            key = (z["key"] as? String)?.ifBlank { null } ?: "zoom",
            label = (z["label"] as? String)?.ifBlank { null } ?: "Zoom",
            step = ((cfg["saveStep"] as? Number)?.toInt() ?: 5).coerceAtLeast(1),
        ).also { it.doc = d }
    }

    @Suppress("UNCHECKED_CAST")
    private fun startMeeting(mid: String, d: DocumentSnapshot): ZoomMeeting? {
        val z = (d.get("config") as Map<String, Any?>)["zoom"] as Map<String, Any?>
        val m = ZoomMeeting(mid)
        try {
            m.watcher = ZoomWatcher(
                this, mid, d.getString("automationName") ?: "Zoom",
                z["link"] as String, z["passcode"] as? String,
                (z["displayName"] as? String)?.ifBlank { null } ?: "Count",
            ) { c, st -> onZoomReading(m, c, st) }
        } catch (e: IllegalArgumentException) {
            zoomFailed += d.id
            scope.launch { note(d.id, "Phone: ${e.message}") }
            return null
        }
        zoomMeetings[mid] = m
        m.watcher.start()
        wakeLock?.acquire(15 * 60_000L)
        updateNotification("Counting Zoom: ${m.watcher.title}")
        return m
    }

    /** Main thread. Keeps exact peaks (overall and per moment); saves only on real changes, new peaks, or once a minute. */
    private fun onZoomReading(m: ZoomMeeting, count: Int?, state: String) {
        if (state == "captcha" && !m.captchaShown) { m.captchaShown = true; notifyCaptcha(m.id, m.watcher.title) }
        if (state != "captcha" && m.captchaShown) { m.captchaShown = false; cancelCaptcha() }
        val nowMs = System.currentTimeMillis()
        val nowTs = Timestamp.now()
        var saved = false
        for (r in m.runs.values) {
            r.count = count
            r.state = state
            if (count != null) {
                if (r.localPeak == null || count > r.localPeak!!) { r.localPeak = count; r.localPeakAt = nowTs }
                for (mo in Values.moments(r.doc)) {
                    if (nowTs.seconds in mo.start until mo.end) {
                        val old = r.momentPeaks[mo.key]
                        if (old == null || count > old.first) r.momentPeaks[mo.key] = count to nowTs
                    }
                }
            }
            val sv = r.savedValue
            val sp = r.savedPeak
            val lp = r.localPeak
            val momentsChanged = r.momentPeaks.any { (k, v) -> r.savedMoments[k] != v.first }
            val due = r.lastSave == 0L || nowMs - r.lastSave >= 60_000L || state != r.savedState ||
                (count == null) != (sv == null) ||
                (count != null && sv != null && abs(count - sv) >= r.step) ||
                (lp != null && (sp == null || lp > sp) && nowMs - r.lastSave >= 5_000L) ||
                (momentsChanged && nowMs - r.lastSave >= 10_000L)
            if (due && !r.saving) {
                r.saving = true
                r.lastSave = nowMs
                scope.launch { try { saveZoom(r) } finally { r.saving = false } }
                saved = true
            }
        }
        if (saved) {
            wakeLock?.acquire(15 * 60_000L)
            updateNotification("Zoom: " + ZoomWatcher.stateText(state, count))
        }
    }

    private suspend fun saveZoom(r: RunZoom) {
        val count = r.count
        val state = r.state
        val peak = r.localPeak
        val peakAt = r.localPeakAt
        val moments = r.momentPeaks.toMap()
        val ref = db.collection("runs").document(r.runId)
        val now = Timestamp.now()
        try {
            db.runTransaction { tx ->
                val cur = tx.get(ref)
                @Suppress("UNCHECKED_CAST")
                val peaks = (cur.get("peaks") as? Map<String, Map<String, Any?>> ?: emptyMap()).toMutableMap()
                val p = (peaks[r.key] ?: emptyMap()).toMutableMap()
                p["label"] = r.label
                val last = p["lastAt"] as? Timestamp
                val fresh = last != null && now.seconds - last.seconds < 30
                if (count != null || !fresh) {
                    p["current"] = count
                    p["note"] = if (count != null) "counted by phone" else "phone: " + ZoomWatcher.stateText(state, null)
                }
                if (count != null) p["lastAt"] = now
                val old = (p["peak"] as? Number)?.toLong()
                if (peak != null && (old == null || peak.toLong() > old)) {
                    p["peak"] = peak
                    p["peakAt"] = peakAt ?: now
                    p.remove("manualBy") // the phone saw more than the number typed in
                }
                peaks[r.key] = p
                val upd = mutableMapOf<String, Any?>("peaks" to peaks, "zoomPhoneAt" to now)
                if (moments.isNotEmpty()) upd["momentPeaks"] = mergeMoments(cur, mapOf(r.key to moments))
                tx.update(ref, upd)
                null
            }.await()
            r.savedValue = count
            if (peak != null) r.savedPeak = peak
            r.savedState = state
            moments.forEach { (k, v) -> r.savedMoments[k] = v.first }
        } catch (e: Exception) {
            Log.w(TAG, "zoom save failed", e)
        }
    }

    /** Raise moment peaks only upward. [add] is source key -> moment key -> (value, time). */
    private fun mergeMoments(cur: DocumentSnapshot, add: Map<String, Map<String, Pair<Int, Timestamp>>>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        val mp = (cur.get("momentPeaks") as? Map<String, Map<String, Map<String, Any?>>> ?: emptyMap())
            .mapValues { it.value.toMutableMap() }.toMutableMap()
        for ((src, per) in add) for ((mk, v) in per) {
            val m = mp.getOrPut(mk) { mutableMapOf() }
            val old = (m[src]?.get("peak") as? Number)?.toLong()
            if (old == null || v.first.toLong() > old) m[src] = mapOf("peak" to v.first, "peakAt" to v.second)
        }
        return mp
    }

    private suspend fun note(id: String, msg: String) {
        try {
            db.collection("runs").document(id).update("log", FieldValue.arrayUnion("${clock()} $msg")).await()
        } catch (e: Exception) { Log.w(TAG, "note failed", e) }
    }

    private fun notifyCaptcha(runId: String, title: String) {
        val open = PendingIntent.getActivity(
            this, 2,
            Intent(this, ZoomActivity::class.java).putExtra(ZoomActivity.EXTRA_RUN, runId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(this, App.ALERTS)
            .setSmallIcon(R.drawable.ic_stat)
            .setColor(0xFF0E6B55.toInt())
            .setContentTitle("Zoom needs one tap")
            .setContentText("Tap to finish Zoom’s robot check for $title. Counting carries on after.")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Tap to finish Zoom’s robot check for $title. Counting carries on after."))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        getSystemService(android.app.NotificationManager::class.java).notify(2, n)
    }

    private fun cancelCaptcha() {
        getSystemService(android.app.NotificationManager::class.java).cancel(2)
    }

    private fun inWindow(runStart: Timestamp, from: String?, to: String?, now: Timestamp): Boolean {
        if (from.isNullOrBlank() || to.isNullOrBlank()) return true
        val day = runStart.seconds + IST_OFFSET
        val midnight = day - Math.floorMod(day, 86400L) - IST_OFFSET
        var s = midnight + hhmm(from)
        var e = midnight + hhmm(to)
        if (e <= s) e += 86400
        if (e <= runStart.seconds) { s += 86400; e += 86400 }
        return now.seconds in s until e
    }

    private fun hhmm(v: String): Long = v.split(":").let { it[0].toLong() * 3600 + it[1].toLong() * 60 }
    private fun secs(a: Timestamp, b: Timestamp) = b.seconds - a.seconds
    private fun clock() = SimpleDateFormat("HH:mm:ss", Locale.US).apply { timeZone = IST }.format(java.util.Date())

    companion object {
        private const val TAG = "PeakCounter"
        private const val IST_OFFSET = 19800L
        private val IST: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")
        private val ACTIVE = setOf("queued", "waiting", "running")
        private const val WEB_URL = "https://youtub-and-zoom-count.web.app"

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, CounterService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, CounterService::class.java))
        }
    }
}
