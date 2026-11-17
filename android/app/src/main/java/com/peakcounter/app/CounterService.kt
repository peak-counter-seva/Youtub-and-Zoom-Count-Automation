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
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Runs while the phone app is switched on:
 *  - sends SMS jobs addressed to this phone from its SIM,
 *  - keeps this phone marked online in the web app,
 *  - backup: if the GitHub counter goes quiet during a run that sends from this phone,
 *    counts YouTube itself and sends the result at the end time (Zoom is not counted here).
 */
class CounterService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val db by lazy { FirebaseFirestore.getInstance() }
    private lateinit var prefs: Prefs
    private var smsListener: ListenerRegistration? = null
    private var runListener: ListenerRegistration? = null
    private val activeRuns = mutableMapOf<String, DocumentSnapshot>()
    private var wakeLock: PowerManager.WakeLock? = null

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
        }
        return START_STICKY
    }

    override fun onDestroy() {
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
        while (scope.isActive) {
            try {
                db.collection("devices").document(prefs.deviceId).set(
                    mapOf(
                        "ownerUid" to uid,
                        "ownerEmail" to email,
                        "label" to prefs.label.ifBlank { Build.MODEL },
                        "lastSeen" to FieldValue.serverTimestamp(),
                        "appVersion" to BuildConfig.VERSION_NAME,
                    ),
                    SetOptions.merge(),
                ).await()
            } catch (e: Exception) {
                Log.w(TAG, "heartbeat failed", e)
            }
            delay(5 * 60_000L)
        }
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
                    if (old == null || pair.second!! > old) { p["peak"] = pair.second; p["peakAt"] = now }
                }
                peaks[key] = p
            }
            tx.update(ref, mapOf("peaks" to peaks, "backupAt" to now, "engine" to "phone backup", "status" to "running"))
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
            @Suppress("UNCHECKED_CAST")
            val peaks = d.get("peaks") as? Map<String, Map<String, Any?>> ?: emptyMap()
            val values = mutableMapOf(
                "name" to (d.getString("automationName") ?: ""),
                "date" to fmtDate(d.getTimestamp("startAt")!!),
            )
            peaks.forEach { (k, p) -> values[k] = (p["peak"] as? Number)?.toString() ?: "NA" }
            val text = Regex("\\{(\\w+)\\}").replace(sms["template"] as String) { m -> values[m.groupValues[1]] ?: m.value }
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
    private fun fmtDate(t: Timestamp) = SimpleDateFormat("dd-MM-yyyy", Locale.US).apply { timeZone = IST }.format(t.toDate())

    companion object {
        private const val TAG = "PeakCounter"
        private const val IST_OFFSET = 19800L
        private val IST: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")
        private val ACTIVE = setOf("queued", "waiting", "running")

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, CounterService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, CounterService::class.java))
        }
    }
}
