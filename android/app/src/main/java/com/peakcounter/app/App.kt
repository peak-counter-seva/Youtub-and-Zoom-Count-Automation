package com.peakcounter.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        if (FirebaseApp.getApps(this).isEmpty()) {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setApiKey(BuildConfig.FB_API_KEY)
                    .setApplicationId(BuildConfig.FB_APP_ID)
                    .setProjectId(BuildConfig.FB_PROJECT_ID)
                    .build(),
            )
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Peak Counter", NotificationManager.IMPORTANCE_LOW),
        )
    }

    companion object { const val CHANNEL = "counter" }
}
