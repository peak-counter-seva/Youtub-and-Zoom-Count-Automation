package com.peakcounter.app

import android.content.Context
import java.util.UUID

class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("peak", Context.MODE_PRIVATE)

    val deviceId: String
        get() = p.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            p.edit().putString("deviceId", it).apply()
        }

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
}
