package com.peakcounter.app

import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentSnapshot
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * SMS values, moments and the passcode reminder. Keep in step with buildValues in
 * web/src/lib/types.ts and build_values in counter/main.py.
 */
object Values {
    private val IST: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")
    private const val IST_OFFSET = 19800L

    data class Moment(val key: String, val label: String, val start: Long, val end: Long)

    /** Moments of a run (fixed ones from the automation and ones marked live), in seconds. */
    @Suppress("UNCHECKED_CAST")
    fun moments(d: DocumentSnapshot): List<Moment> {
        val runStart = d.getTimestamp("startAt")?.seconds ?: return emptyList()
        val cfg = d.get("config") as? Map<String, Any?> ?: emptyMap()
        val out = mutableListOf<Moment>()
        (cfg["moments"] as? List<Map<String, Any?>>)?.forEach { m ->
            val key = (m["key"] as? String)?.ifBlank { null } ?: return@forEach
            val at = (m["at"] as? String)?.ifBlank { null } ?: return@forEach
            val mins = ((m["minutes"] as? Number)?.toLong() ?: 30L).coerceAtLeast(1)
            val day = runStart + IST_OFFSET
            val midnight = day - Math.floorMod(day, 86400L) - IST_OFFSET
            var s = midnight + at.split(":").let { it[0].toLong() * 3600 + it[1].toLong() * 60 }
            var e = s + mins * 60
            if (e <= runStart) { s += 86400; e += 86400 }
            out += Moment(key, (m["label"] as? String)?.ifBlank { null } ?: key, s, e)
        }
        (d.get("extraMoments") as? List<Map<String, Any?>>)?.forEach { m ->
            val key = m["key"] as? String ?: return@forEach
            val s = (m["startAt"] as? Timestamp)?.seconds ?: return@forEach
            val e = (m["endAt"] as? Timestamp)?.seconds ?: return@forEach
            out += Moment(key, (m["label"] as? String)?.ifBlank { null } ?: key, s, e)
        }
        return out.sortedBy { it.start }
    }

    /** Every value the SMS template can use, e.g. {yt1}, {total}, {aarti.zoom}, {moments}. */
    @Suppress("UNCHECKED_CAST")
    fun build(d: DocumentSnapshot): Map<String, String> {
        val cfg = d.get("config") as? Map<String, Any?> ?: emptyMap()
        val srcs = mutableListOf<Pair<String, String>>()
        (cfg["youtube"] as? List<Map<String, Any?>>)?.forEach { y ->
            val k = y["key"] as? String ?: return@forEach
            srcs += k to ((y["label"] as? String)?.ifBlank { null } ?: k)
        }
        val z = cfg["zoom"] as? Map<String, Any?>
        if (z?.get("enabled") == true) {
            srcs += ((z["key"] as? String)?.ifBlank { null } ?: "zoom") to ((z["label"] as? String)?.ifBlank { null } ?: "Zoom")
        }
        val groups = (cfg["totals"] as? List<Map<String, Any?>> ?: emptyList()).filter { !(it["key"] as? String).isNullOrBlank() }
        val v = mutableMapOf(
            "name" to (d.getString("automationName") ?: ""),
            "date" to fmt("dd-MM-yyyy", d.getTimestamp("startAt")?.seconds ?: 0),
        )
        fun total(vals: List<Long?>) = vals.filterNotNull().takeIf { it.isNotEmpty() }?.sum()?.toString() ?: "NA"
        fun fill(prefix: String, get: (String) -> Long?) {
            for ((k, _) in srcs) v[prefix + k] = get(k)?.toString() ?: "NA"
            v[prefix + "total"] = total(srcs.map { get(it.first) })
            for (g in groups) v[prefix + (g["key"] as String)] = total((g["sources"] as? List<String> ?: emptyList()).map(get))
        }
        val peaks = d.get("peaks") as? Map<String, Map<String, Any?>> ?: emptyMap()
        fill("") { (peaks[it]?.get("peak") as? Number)?.toLong() }
        val mpeaks = d.get("momentPeaks") as? Map<String, Map<String, Map<String, Any?>>> ?: emptyMap()
        val lines = mutableListOf<String>()
        for (m in moments(d)) {
            val mp = mpeaks[m.key] ?: emptyMap()
            fill(m.key + ".") { (mp[it]?.get("peak") as? Number)?.toLong() }
            val at = fmt("HH:mm", m.start)
            v[m.key + ".time"] = at
            val parts = srcs.map { "${it.second} ${v[m.key + "." + it.first]}" }.toMutableList()
            if (srcs.size > 1) parts += "Total ${v[m.key + ".total"]}"
            lines += "${m.label} $at: ${parts.joinToString(", ")}"
        }
        v["moments"] = lines.joinToString("\n")
        return v
    }

    fun render(template: String, values: Map<String, String>): String =
        Regex("\\{([\\w.]+)\\}").replace(template) { m -> values[m.groupValues[1]] ?: m.value }

    /** True when the weekly passcode-change day has come and the passcode wasn't saved since. */
    @Suppress("UNCHECKED_CAST")
    fun passcodeDue(automation: DocumentSnapshot, nowMs: Long = System.currentTimeMillis()): Boolean {
        val z = automation.get("zoom") as? Map<String, Any?> ?: return false
        if (z["enabled"] != true) return false
        val day = (z["passcodeDay"] as? Number)?.toInt() ?: return false
        val changed = (z["passcodeChangedAt"] as? Timestamp)?.toDate()?.time ?: return true
        val cal = Calendar.getInstance(IST).apply {
            timeInMillis = nowMs
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        val back = ((cal.get(Calendar.DAY_OF_WEEK) - 1) - day + 7) % 7
        cal.add(Calendar.DAY_OF_MONTH, -back)
        return changed < cal.timeInMillis
    }

    private fun fmt(pattern: String, seconds: Long) =
        SimpleDateFormat(pattern, Locale.US).apply { timeZone = IST }.format(java.util.Date(seconds * 1000))
}
