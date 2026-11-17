package com.peakcounter.app

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Backup YouTube reader using the Data API (key stored by the admin in Firestore config/youtube). */
object YouTube {
    private val idRe = Regex("^[A-Za-z0-9_-]{11}$")

    fun videoId(url: String): String? {
        val u = url.trim()
        if (idRe.matches(u)) return u
        Regex("[?&]v=([A-Za-z0-9_-]{11})").find(u)?.let { return it.groupValues[1] }
        Regex("youtu\\.be/([A-Za-z0-9_-]{11})").find(u)?.let { return it.groupValues[1] }
        Regex("/(?:live|shorts|embed)/([A-Za-z0-9_-]{11})").find(u)?.let { return it.groupValues[1] }
        return null
    }

    /** Returns video id -> concurrent viewers (null when not live). */
    fun read(ids: List<String>, apiKey: String): Map<String, Long?> {
        if (ids.isEmpty()) return emptyMap()
        val q = URLEncoder.encode(ids.distinct().take(50).joinToString(","), "UTF-8")
        val conn = URL("https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=$q&key=$apiKey")
            .openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        try {
            val body = conn.inputStream.bufferedReader().readText()
            val items = JSONObject(body).getJSONArray("items")
            val out = mutableMapOf<String, Long?>()
            for (i in 0 until items.length()) {
                val it = items.getJSONObject(i)
                val live = it.optJSONObject("snippet")?.optString("liveBroadcastContent") == "live"
                val cv = it.optJSONObject("liveStreamingDetails")?.optString("concurrentViewers", "")
                out[it.getString("id")] = if (live && !cv.isNullOrEmpty()) cv.toLong() else null
            }
            return out
        } finally {
            conn.disconnect()
        }
    }
}
