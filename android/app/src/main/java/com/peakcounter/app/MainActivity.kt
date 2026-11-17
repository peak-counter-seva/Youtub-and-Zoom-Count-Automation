package com.peakcounter.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.firebase.auth.FirebaseAuth

/** One screen: sign in, then switch sending on, finish setup, name the phone, pick the SIM, send a test. */
class MainActivity : AppCompatActivity() {
    private val auth = FirebaseAuth.getInstance()
    private lateinit var prefs: Prefs
    private lateinit var root: LinearLayout

    // Same palette as the website.
    private val cBg = Color.parseColor("#F5F5F3")
    private val cSurface = Color.WHITE
    private val cSurface2 = Color.parseColor("#FAFAF8")
    private val cInk = Color.parseColor("#15171C")
    private val cInk2 = Color.parseColor("#474C56")
    private val cMuted = Color.parseColor("#7D828C")
    private val cLine = Color.parseColor("#E7E6E1")
    private val cLine2 = Color.parseColor("#D7D6D0")
    private val cAccent = Color.parseColor("#0E6B55")
    private val cAccentSoft = Color.parseColor("#E6F2EE")
    private val cLive = Color.parseColor("#12804F")
    private val cLiveSoft = Color.parseColor("#E5F4EC")
    private val cWait = Color.parseColor("#7A4700")
    private val cWaitSoft = Color.parseColor("#FBF1E1")
    private val cDanger = Color.parseColor("#B93A2F")

    private val medium: Typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    private val bold: Typeface = Typeface.create("sans-serif", Typeface.BOLD)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(12), dp(20), dp(32))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(cBg)
            isFillViewport = true
            clipToPadding = false
            addView(root)
        }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
        render()
    }

    override fun onResume() { super.onResume(); render() }

    // ---------- Screens ----------

    private fun render() {
        root.removeAllViews()
        if (auth.currentUser == null) renderSignIn() else renderHome()
    }

    private fun renderSignIn() {
        root.gravity = Gravity.CENTER_VERTICAL
        root.addView(ImageView(this).apply { setImageResource(R.drawable.ic_logo) }, LinearLayout.LayoutParams(dp(48), dp(48)).apply { topMargin = dp(40) })
        root.addView(text("Peak Counter", 28f, cInk, bold).apply { letterSpacing = -0.02f }, lp(top = 24))
        root.addView(text("Sign in to make this phone a sender. Use your website email and the phone app password you set in the website’s Settings.", 15f, cInk2).apply {
            setLineSpacing(0f, 1.3f)
        }, lp(top = 10))

        val email = input("Email", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val pass = input("Password", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        root.addView(fieldLabel("Email"), lp(top = 32))
        root.addView(email, lp(top = 6, h = 52))
        root.addView(fieldLabel("Password"), lp(top = 16))
        root.addView(pass, lp(top = 6, h = 52))

        val err = text("", 13f, cDanger).apply { visibility = View.GONE }
        lateinit var go: TextView
        val submit: () -> Unit = {
            val e = email.text.toString().trim()
            val p = pass.text.toString()
            if (e.isEmpty() || p.isEmpty()) {
                err.text = "Enter your email and password."; err.visibility = View.VISIBLE
            } else {
                go.isEnabled = false; go.text = "Signing in…"; err.visibility = View.GONE
                auth.signInWithEmailAndPassword(e, p)
                    .addOnSuccessListener { render() }
                    .addOnFailureListener {
                        go.isEnabled = true; go.text = "Sign in"
                        err.text = friendlyAuthError(it.message); err.visibility = View.VISIBLE
                    }
            }
        }
        pass.imeOptions = EditorInfo.IME_ACTION_DONE
        pass.setOnEditorActionListener { _, _, _ -> submit(); true }
        go = button("Sign in", Style.PRIMARY) { submit() }
        root.addView(go, lp(top = 24, h = 52))
        root.addView(err, lp(top = 12))
        root.addView(text("Only approved members can sign in.", 13f, cMuted), lp(top = 20))
    }

    private fun renderHome() {
        root.gravity = Gravity.TOP
        val user = auth.currentUser!!
        val on = prefs.serviceEnabled
        val permsOk = hasPermissions()
        val batteryOk = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

        // Header
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(ImageView(context).apply { setImageResource(R.drawable.ic_logo) }, LinearLayout.LayoutParams(dp(30), dp(30)))
            addView(text("Peak Counter", 17f, cInk, medium), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(10) })
            addView(TextView(context).apply {
                text = (user.email ?: "?").first().uppercase()
                setTextColor(cInk2); typeface = medium; textSize = 14f; gravity = Gravity.CENTER
                background = shape(cSurface, 999f, cLine2)
            }, LinearLayout.LayoutParams(dp(34), dp(34)))
        }, lp(top = 8))

        // Status card
        val status = card().apply {
            if (on) background = shape(cSurface, 16f, blend(cLive, cLine, 0.35f))
            addView(pill(if (on) "On" else "Off", on))
            addView(text(if (on) "This phone is sending" else "Sending is off", 22f, cInk, bold).apply { letterSpacing = -0.02f }, lp(top = 14))
            addView(text(
                if (on) "It sends the SMS when an automation ends and counts YouTube as a backup. You can close the app."
                else "Turn on so this phone can send the SMS results from its SIM.",
                14.5f, cInk2,
            ).apply { setLineSpacing(0f, 1.3f) }, lp(top = 6))
            addView(button(if (on) "Turn off" else "Turn on", if (on) Style.OUTLINE else Style.ACCENT) {
                if (!on && !hasPermissions()) { askPermissions(); return@button }
                prefs.serviceEnabled = !on
                if (!on) CounterService.start(this@MainActivity) else CounterService.stop(this@MainActivity)
                render()
            }, lp(top = 18, h = 52))
        }
        root.addView(status, lp(top = 24))

        // Setup checklist
        root.addView(sectionTitle("Setup"), lp(top = 28))
        root.addView(list(
            checkRow("Permissions", "Send SMS, choose SIM, show status", permsOk, "Allow") { askPermissions() },
            checkRow("Background running", "Keeps the app working when closed", batteryOk, "Allow") { askBatteryExemption() },
        ), lp(top = 10))
        if (on && !batteryOk) {
            root.addView(notice("Android may stop the app in the background. Tap Allow next to Background running."), lp(top = 10))
        }

        // This phone
        root.addView(sectionTitle("This phone"), lp(top = 28))
        val phoneCard = card()
        phoneCard.addView(fieldLabel("Name shown on the website"))
        val label = input(Build.MODEL).apply { setText(prefs.label) }
        val saveName = button("Save", Style.OUTLINE) {
            prefs.label = label.text.toString().trim()
            hideKeyboard(label)
            toast("Name saved")
        }
        phoneCard.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(label, LinearLayout.LayoutParams(0, dp(48), 1f))
            addView(saveName, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply { leftMargin = dp(8) })
        }, lp(top = 6))
        phoneCard.addView(fieldLabel("Send SMS from"), lp(top = 18))
        phoneCard.addView(simRow(), lp(top = 6, h = 48))
        root.addView(phoneCard, lp(top = 10))

        // Test SMS
        root.addView(sectionTitle("Test SMS"), lp(top = 28))
        val testCard = card()
        testCard.addView(text("Sends “Peak Counter test message” from the chosen SIM.", 13.5f, cMuted))
        val testTo = input("+91 98765 43210", InputType.TYPE_CLASS_PHONE)
        val send = button("Send", Style.PRIMARY) {
            val to = testTo.text.toString().trim()
            if (to.isEmpty()) { toast("Enter a phone number"); return@button }
            if (!hasPermissions()) { askPermissions(); return@button }
            try {
                Sms.send(this, to, "Peak Counter test message", prefs.subscriptionId)
                hideKeyboard(testTo)
                toast("Test SMS sent")
            } catch (e: Exception) { toast("Couldn’t send: ${e.message}") }
        }
        testCard.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(testTo, LinearLayout.LayoutParams(0, dp(48), 1f))
            addView(send, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)).apply { leftMargin = dp(8) })
        }, lp(top = 12))
        root.addView(testCard, lp(top = 10))

        // Account
        root.addView(sectionTitle("Account"), lp(top = 28))
        root.addView(list(
            infoRow("Signed in as", user.email ?: ""),
            infoRow("Phone id · version", "${prefs.deviceId.take(8)} · ${BuildConfig.VERSION_NAME}"),
            actionRow("Sign out", cDanger) {
                AlertDialog.Builder(this)
                    .setTitle("Sign out?")
                    .setMessage("This phone will stop sending SMS until you sign in again.")
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Sign out") { _, _ ->
                        prefs.serviceEnabled = false
                        CounterService.stop(this)
                        auth.signOut()
                        render()
                    }
                    .show()
            },
        ), lp(top = 10))
    }

    // ---------- SIM picker ----------

    @SuppressLint("MissingPermission")
    private fun simOptions(): Pair<List<String>, List<Int>> {
        val labels = mutableListOf("Phone’s default SIM")
        val ids = mutableListOf(-1)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            val subs = getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoList ?: emptyList()
            subs.forEach { s -> labels += "SIM ${s.simSlotIndex + 1} · ${s.carrierName}"; ids += s.subscriptionId }
        }
        return labels to ids
    }

    private fun simRow(): View {
        val (labels, ids) = simOptions()
        val current = ids.indexOf(prefs.subscriptionId).coerceAtLeast(0)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), 0, dp(10), 0)
            background = ripple(shape(cSurface, 10f, cLine2))
            isClickable = true
            addView(text(labels[current], 16f, cInk), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(ImageView(context).apply { setImageResource(R.drawable.ic_chevron) }, LinearLayout.LayoutParams(dp(18), dp(18)))
            setOnClickListener {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
                    toast("Allow permissions to see your SIMs"); askPermissions(); return@setOnClickListener
                }
                AlertDialog.Builder(context)
                    .setTitle("Send SMS from")
                    .setSingleChoiceItems(labels.toTypedArray(), current) { d, which ->
                        prefs.subscriptionId = ids[which]; d.dismiss(); render()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        }
    }

    // ---------- Building blocks ----------

    private enum class Style { PRIMARY, ACCENT, OUTLINE }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun dpf(v: Float): Float = v * resources.displayMetrics.density

    private fun lp(top: Int = 0, h: Int = -1) = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, if (h < 0) ViewGroup.LayoutParams.WRAP_CONTENT else dp(h),
    ).apply { topMargin = dp(top) }

    private fun shape(fill: Int, radius: Float, stroke: Int? = null) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dpf(radius)
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun ripple(content: GradientDrawable) =
        RippleDrawable(ColorStateList.valueOf(Color.parseColor("#1F15171C")), content, null)

    private fun blend(a: Int, b: Int, t: Float): Int {
        fun ch(x: Int, y: Int) = (x * t + y * (1 - t)).toInt()
        return Color.rgb(ch(Color.red(a), Color.red(b)), ch(Color.green(a), Color.green(b)), ch(Color.blue(a), Color.blue(b)))
    }

    private fun text(s: String, size: Float, color: Int, face: Typeface? = null) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
        if (face != null) typeface = face
    }

    private fun fieldLabel(s: String) = text(s, 13f, cInk2, medium)
    private fun sectionTitle(s: String) = text(s, 13f, cInk2, medium).apply { setPadding(dp(2), 0, 0, 0) }

    private fun input(hint: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint
        inputType = type
        setSingleLine()
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setTextColor(cInk)
        setHintTextColor(Color.parseColor("#A8ACB3"))
        setPadding(dp(14), 0, dp(14), 0)
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(cSurface, 10f, cAccent).apply { setStroke(dp(2), cAccent) })
            addState(intArrayOf(), shape(cSurface, 10f, cLine2))
        }
    }

    private fun button(label: String, style: Style, onClick: () -> Unit) = TextView(this).apply {
        text = label
        gravity = Gravity.CENTER
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        typeface = medium
        setPadding(dp(18), 0, dp(18), 0)
        isClickable = true
        isFocusable = true
        val (fill, fg, stroke) = when (style) {
            Style.PRIMARY -> Triple(cInk, Color.WHITE, null)
            Style.ACCENT -> Triple(cAccent, Color.WHITE, null)
            Style.OUTLINE -> Triple(cSurface, cInk, cLine2)
        }
        setTextColor(fg)
        background = ripple(shape(fill, 12f, stroke))
        setOnClickListener { if (isEnabled) onClick() }
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = shape(cSurface, 16f, cLine)
        setPadding(dp(18), dp(18), dp(18), dp(18))
    }

    private fun list(vararg rows: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = shape(cSurface, 16f, cLine)
        rows.forEachIndexed { i, r ->
            if (i > 0) addView(View(context).apply { setBackgroundColor(cLine) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)))
            addView(r)
        }
    }

    private fun pill(label: String, on: Boolean) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(10), dp(4), dp(12), dp(4))
        background = shape(if (on) cLiveSoft else Color.parseColor("#EFEEEA"), 999f)
        val color = if (on) cLive else cInk2
        addView(View(context).apply { background = shape(color, 999f) }, LinearLayout.LayoutParams(dp(7), dp(7)))
        addView(text(label, 12.5f, color, medium), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = dp(6) })
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun rowBase() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(64)
        setPadding(dp(16), dp(12), dp(16), dp(12))
    }

    private fun twoLines(title: String, sub: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(text(title, 15f, cInk, medium))
        addView(text(sub, 13f, cMuted), lp(top = 2))
    }

    private fun checkRow(title: String, sub: String, done: Boolean, action: String, onClick: () -> Unit) = rowBase().apply {
        addView(twoLines(title, sub), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (done) {
            addView(FrameLayout(context).apply {
                background = shape(cLiveSoft, 999f)
                addView(ImageView(context).apply { setImageResource(R.drawable.ic_check) }, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
            }, LinearLayout.LayoutParams(dp(28), dp(28)))
        } else {
            addView(button(action, Style.PRIMARY, onClick).apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f); setPadding(dp(14), 0, dp(14), 0) },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(36)))
        }
    }

    private fun infoRow(title: String, value: String) = rowBase().apply {
        addView(twoLines(title, value).apply {
            // Value reads as the main text here.
            (getChildAt(0) as TextView).apply { setTextColor(cMuted); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); typeface = Typeface.DEFAULT }
            (getChildAt(1) as TextView).apply { setTextColor(cInk); setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f) }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun actionRow(title: String, color: Int, onClick: () -> Unit) = rowBase().apply {
        minimumHeight = dp(56)
        background = ripple(shape(Color.TRANSPARENT, 16f))
        isClickable = true
        addView(text(title, 15f, color, medium))
        setOnClickListener { onClick() }
    }

    private fun notice(msg: String) = text(msg, 13.5f, cWait).apply {
        background = shape(cWaitSoft, 12f)
        setPadding(dp(14), dp(12), dp(14), dp(12))
        setLineSpacing(0f, 1.3f)
    }

    private fun friendlyAuthError(msg: String?): String = when {
        msg == null -> "Couldn’t sign in. Try again."
        msg.contains("password", true) || msg.contains("credential", true) -> "Email or password is wrong. Set the password on the website under Settings → Phone app password."
        msg.contains("network", true) -> "No internet connection."
        else -> msg
    }

    private fun hideKeyboard(v: View) {
        v.clearFocus()
        getSystemService(android.view.inputmethod.InputMethodManager::class.java).hideSoftInputFromWindow(v.windowToken, 0)
    }

    // ---------- Permissions ----------

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
