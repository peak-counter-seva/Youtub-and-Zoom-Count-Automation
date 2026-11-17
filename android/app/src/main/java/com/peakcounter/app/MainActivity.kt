package com.peakcounter.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.text.InputType
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.firebase.auth.FirebaseAuth

/** Simple screen: sign in, name this phone, choose the SIM, switch the service on or off. */
class MainActivity : AppCompatActivity() {
    private val auth = FirebaseAuth.getInstance()
    private lateinit var prefs: Prefs
    private lateinit var root: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 48, 48, 48) }
        setContentView(ScrollView(this).apply { addView(root) })
        render()
    }

    override fun onResume() { super.onResume(); render() }

    private fun text(s: String, size: Float = 16f) = TextView(this).apply { text = s; textSize = size; setPadding(0, 16, 0, 8) }
    private fun button(s: String, onClick: () -> Unit) = Button(this).apply { text = s; setOnClickListener { onClick() } }
    private fun input(hint: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply { this.hint = hint; inputType = type }

    private fun render() {
        root.removeAllViews()
        root.addView(text("Peak Counter", 24f))
        val user = auth.currentUser
        if (user == null) {
            root.addView(text("Sign in with the same email you use on the website. Set your phone-app password there first (Settings → Phone app password)."))
            val email = input("Email", InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or InputType.TYPE_CLASS_TEXT)
            val pass = input("Password", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
            root.addView(email); root.addView(pass)
            root.addView(button("Sign in") {
                auth.signInWithEmailAndPassword(email.text.toString().trim(), pass.text.toString())
                    .addOnSuccessListener { render() }
                    .addOnFailureListener { Toast.makeText(this, it.message, Toast.LENGTH_LONG).show() }
            })
            return
        }

        root.addView(text("Signed in as ${user.email}"))
        root.addView(text("Phone name (shown on the website)"))
        val label = input(Build.MODEL).apply { setText(prefs.label) }
        root.addView(label)
        root.addView(button("Save name") { prefs.label = label.text.toString().trim(); toast("Saved") })

        root.addView(text("Send SMS from SIM"))
        addSimPicker()

        val on = prefs.serviceEnabled
        root.addView(text(if (on) "Status: ON — this phone sends SMS and backs up counting." else "Status: OFF", 18f))
        root.addView(button(if (on) "Turn OFF" else "Turn ON") {
            if (!on && !hasPermissions()) { askPermissions(); return@button }
            prefs.serviceEnabled = !on
            if (!on) CounterService.start(this) else CounterService.stop(this)
            render()
        })

        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            root.addView(text("Important: allow the app to run in the background, or Android may stop it."))
            root.addView(button("Allow background running") { askBatteryExemption() })
        }

        root.addView(text("Send a test SMS"))
        val testTo = input("+91…", InputType.TYPE_CLASS_PHONE)
        root.addView(testTo)
        root.addView(button("Send test") {
            if (!hasPermissions()) { askPermissions(); return@button }
            try {
                Sms.send(this, testTo.text.toString().trim(), "Peak Counter test message", prefs.subscriptionId)
                toast("Test SMS sent")
            } catch (e: Exception) { toast("Failed: ${e.message}") }
        })

        root.addView(text("Phone id: ${prefs.deviceId.take(8)} · v${BuildConfig.VERSION_NAME}", 12f))
        root.addView(button("Sign out") {
            prefs.serviceEnabled = false
            CounterService.stop(this)
            auth.signOut()
            render()
        })
    }

    @SuppressLint("MissingPermission")
    private fun addSimPicker() {
        val spinner = Spinner(this)
        val labels = mutableListOf("Phone default SIM")
        val ids = mutableListOf(-1)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            val subs = getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList ?: emptyList()
            subs.forEach { s -> labels += "SIM ${s.simSlotIndex + 1}: ${s.carrierName}"; ids += s.subscriptionId }
        } else {
            root.addView(text("Grant phone permission to choose a SIM.", 12f))
        }
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        spinner.setSelection(ids.indexOf(prefs.subscriptionId).coerceAtLeast(0))
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { prefs.subscriptionId = ids[pos] }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        root.addView(spinner)
    }

    private val needed: Array<String>
        get() = buildList {
            add(Manifest.permission.SEND_SMS)
            add(Manifest.permission.READ_PHONE_STATE)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private fun hasPermissions() = needed.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
    private fun askPermissions() = requestPermissions(needed, 1)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    @SuppressLint("BatteryLife")
    private fun askBatteryExemption() {
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
