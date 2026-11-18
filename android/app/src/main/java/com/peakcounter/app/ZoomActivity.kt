package com.peakcounter.app

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/** Shows the hidden Zoom page so a person can tap through a robot check, then hands it back. */
class ZoomActivity : AppCompatActivity() {
    private var watcher: ZoomWatcher? = null
    private lateinit var status: TextView
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = true
        val d = resources.displayMetrics.density

        val rootView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#F5F5F3"))
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((16 * d).toInt(), (10 * d).toInt(), (8 * d).toInt(), (10 * d).toInt())
        }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(Color.parseColor("#15171C"))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.parseColor("#7D828C"))
        }
        texts.addView(title); texts.addView(status)
        bar.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(TextView(this).apply {
            text = "Done"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(Color.parseColor("#0E6B55"))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding((12 * d).toInt(), (8 * d).toInt(), (12 * d).toInt(), (8 * d).toInt())
            setOnClickListener { finish() }
        })
        val container = FrameLayout(this)
        rootView.addView(bar)
        rootView.addView(container, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }
        setContentView(rootView)

        val runId = intent.getStringExtra(EXTRA_RUN)
        val w = (runId?.let { ZoomWatcher.active[it] }) ?: ZoomWatcher.active.values.firstOrNull()
        if (w == null) {
            title.text = "Zoom"
            status.text = "Zoom isn’t being counted right now."
            return
        }
        watcher = w
        title.text = w.title
        w.showIn(this, container)
        refresh()
    }

    private fun refresh() {
        val w = watcher ?: return
        status.text = ZoomWatcher.stateText(w.state, w.count)
        main.postDelayed(::refresh, 2000)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        watcher?.hide()
        super.onDestroy()
    }

    companion object { const val EXTRA_RUN = "runId" }
}
