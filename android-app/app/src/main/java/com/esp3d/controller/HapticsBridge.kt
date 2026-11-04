package com.esp3d.controller

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface
import org.json.JSONArray
import kotlin.math.roundToLong

/**
 * Replaces navigator.vibrate for the bundled page. The web app scales the
 * pattern with the user's intensity setting before calling this, so the
 * timings already carry the intended strength.
 */
class HapticsBridge(context: Context) {
    private val appContext = context.applicationContext

    @JavascriptInterface
    fun vibrate(patternJson: String?) {
        val timings = parseTimings(patternJson) ?: return
        if (timings.isEmpty()) return

        val total = timings.sum()
        if (total <= 0L || total > 10_000L) return

        val vibrator = systemVibrator() ?: return
        if (!vibrator.hasVibrator()) return

        try {
            vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
        } catch (_: Exception) {
            /* Some devices reject unusual waveforms. Never break input. */
        }
    }

    private fun parseTimings(patternJson: String?): LongArray? {
        val json = patternJson?.trim().orEmpty()
        if (json.isEmpty()) return null

        return try {
            if (json.startsWith("[")) {
                val array = JSONArray(json)
                val count = minOf(array.length(), 32)
                LongArray(count) { index ->
                    array.optLong(index, 0L).coerceAtLeast(0L)
                }
            } else {
                val duration = json.toDoubleOrNull()?.roundToLong() ?: return null
                longArrayOf(duration.coerceAtLeast(0L))
            }
        } catch (_: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun systemVibrator(): Vibrator? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            appContext.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            appContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }
}
