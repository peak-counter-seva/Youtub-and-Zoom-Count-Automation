package com.peakcounter.app

import android.content.Context
import android.os.Build
import com.google.firebase.auth.FirebaseAuth
import java.security.MessageDigest
import java.util.UUID

class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("peak", Context.MODE_PRIVATE)

    /**
     * This phone's id. Made from the signed-in account and the phone model, so it stays the same
     * when the app is uninstalled and installed again for an update. An id from an older app
     * version is kept in [oldDeviceId] so automations can be moved over.
     */
    val deviceId: String
        get() {
            val uid = FirebaseAuth.getInstance().currentUser?.uid
            val stored = p.getString("deviceId", null)
            if (uid == null) return stored ?: UUID.randomUUID().toString().also { p.edit().putString("deviceId", it).apply() }
            val stable = stableId(uid)
            if (stored != stable) {
                val e = p.edit().putString("deviceId", stable)
                if (stored != null) e.putString("oldDeviceId", stored)
                e.apply()
            }
            return stable
        }

    var oldDeviceId: String?
        get() = p.getString("oldDeviceId", null)
        set(v) = p.edit().putString("oldDeviceId", v).apply()

    /** Which automations' passcode reminders were already shown, so each shows once per week. */
    var passcodeNotified: String
        get() = p.getString("passcodeNotified", "") ?: ""
        set(v) = p.edit().putString("passcodeNotified", v).apply()

    var label: String
        get() = p.getString("label", "") ?: ""
        set(v) = p.edit().putString("label", v).apply()

    /** SIM subscription id to send from; -1 = phone default. */
    var subscriptionId: Int
        get() = p.getInt("subId", -1)
        set(v) = p.edit().putInt("subId", v).apply()

    var serviceEnabled: Boolean
        get() = p.getBoolean("enabled", false)
        set(v) = p.edit().putBoolean("enabled", v).apply()

    /** True once someone signed in to a Zoom account in the app's browser. */
    var zoomSignedIn: Boolean
        get() = p.getBoolean("zoomSignedIn", false)
        set(v) = p.edit().putBoolean("zoomSignedIn", v).apply()

    companion object {
        fun stableId(uid: String): String {
            val raw = "$uid|${Build.MANUFACTURER}|${Build.MODEL}"
            val hash = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
            return "p-" + hash.take(10).joinToString("") { "%02x".format(it) }
        }
    }
}
