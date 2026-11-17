package com.peakcounter.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.firebase.auth.FirebaseAuth

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED &&
            Prefs(context).serviceEnabled &&
            FirebaseAuth.getInstance().currentUser != null
        ) {
            CounterService.start(context)
        }
    }
}
