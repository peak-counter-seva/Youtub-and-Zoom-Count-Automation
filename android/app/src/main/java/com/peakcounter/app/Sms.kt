package com.peakcounter.app

import android.content.Context
import android.os.Build
import android.telephony.SmsManager

object Sms {
    fun send(ctx: Context, to: String, text: String, subscriptionId: Int) {
        val mgr: SmsManager = if (Build.VERSION.SDK_INT >= 31) {
            val base = ctx.getSystemService(SmsManager::class.java)
            if (subscriptionId >= 0) base.createForSubscriptionId(subscriptionId) else base
        } else {
            @Suppress("DEPRECATION")
            if (subscriptionId >= 0) SmsManager.getSmsManagerForSubscriptionId(subscriptionId) else SmsManager.getDefault()
        }
        val parts = mgr.divideMessage(text)
        if (parts.size > 1) mgr.sendMultipartTextMessage(to, null, parts, null, null)
        else mgr.sendTextMessage(to, null, text, null, null)
    }
}
