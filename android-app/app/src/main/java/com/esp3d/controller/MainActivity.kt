package com.esp3d.controller

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

class MainActivity : Activity() {

    companion object {
        private const val ASSET_DOMAIN = "appassets.androidplatform.net"
        private const val START_URL = "http://$ASSET_DOMAIN/assets/www/index.html"
        private const val WIFI_PERMISSION_REQUEST = 1001
        private const val TAG = "ESP3D-Main"
    }

    private lateinit var webView: WebView
    private lateinit var overlay: View
    private lateinit var overlayStatus: TextView
    private lateinit var connectButton: Button
    private lateinit var wifiSettingsButton: Button

    private lateinit var networks: EspNetworkManager
    private lateinit var proxy: LoopbackProxy

    private val mainHandler = Handler(Looper.getMainLooper())

    private var pageLoaded = false
    private var pageFailed = false
    private var connecting = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        overlay = findViewById(R.id.overlay)
        overlayStatus = findViewById(R.id.overlayStatus)
        connectButton = findViewById(R.id.connectButton)
        wifiSettingsButton = findViewById(R.id.wifiSettingsButton)

        networks = EspNetworkManager(this) { network ->
            onNetworkChanged(network)
        }

        proxy = LoopbackProxy(networkProvider = { networks.currentNetwork() })
        proxy.start()

        setupWebView()
        setupOverlay()

        webView.loadUrl(START_URL)
        networks.start()
        hideSystemBars()
    }

    override fun onResume() {
        super.onResume()
        if (::networks.isInitialized) networks.refresh()
        hideSystemBars()
    }

    override fun onPause() {
        releaseInputs()
        super.onPause()
    }

    override fun onDestroy() {
        if (::proxy.isInitialized) proxy.stop()
        if (::networks.isInitialized) networks.stop()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("Esp3dAndroid")
            webView.destroy()
        }
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        releaseInputs()
        moveTaskToBack(true)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)

        if (requestCode != WIFI_PERMISSION_REQUEST) return

        val granted =
            grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED

        if (granted) {
            requestEspNetwork()
        } else {
            showOverlay(getString(R.string.status_connect_failed))
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView.setBackgroundColor(0xFF101010.toInt())
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isLongClickable = false
        webView.setOnLongClickListener { true }
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            mediaPlaybackRequiresUserGesture = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString ESP3D-Android/${BuildConfig.VERSION_NAME}"
        }

        webView.addJavascriptInterface(HapticsBridge(this), "Esp3dAndroid")

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .setHttpAllowed(true)
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url
                val isAsset =
                    url.host == ASSET_DOMAIN &&
                        (url.scheme == "http" || url.scheme == "https")
                return !isAsset
            }

            override fun onPageFinished(view: WebView, url: String) {
                pageLoaded = true
            }

            /* WebViewClientCompat makes the WebResourceRequest overload final and
               forwards it here, so this is the overridable hook. */
            @Deprecated("Required by WebViewClientCompat")
            override fun onReceivedError(
                view: WebView,
                errorCode: Int,
                description: String,
                failingUrl: String
            ) {
                if (failingUrl != START_URL) return

                Log.w(TAG, "Main frame failed: $description")
                pageFailed = true
                connectButton.setText(R.string.retry)
                showOverlay(getString(R.string.status_load_failed))
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) {
                    Log.d(
                        "ESP3D-Web",
                        "${message.message()} (${message.sourceId()}:${message.lineNumber()})"
                    )
                }
                return true
            }
        }
    }

    private fun setupOverlay() {
        connectButton.setOnClickListener { beginConnect() }
        wifiSettingsButton.setOnClickListener { openWifiSettings() }
    }

    private fun beginConnect() {
        if (pageFailed) {
            pageFailed = false
            connectButton.setText(R.string.connect)
            overlayStatus.setText(R.string.status_looking)
            webView.loadUrl(START_URL)
            return
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            openWifiSettings()
            return
        }

        val permission =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Manifest.permission.NEARBY_WIFI_DEVICES
            } else {
                Manifest.permission.ACCESS_FINE_LOCATION
            }

        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(permission), WIFI_PERMISSION_REQUEST)
            return
        }

        requestEspNetwork()
    }

    private fun requestEspNetwork() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            openWifiSettings()
            return
        }
        if (connecting) return

        connecting = true
        connectButton.isEnabled = false
        overlayStatus.setText(R.string.status_requesting)

        networks.requestEspNetwork { success ->
            mainHandler.post {
                connecting = false
                connectButton.isEnabled = true

                if (success) {
                    overlayStatus.setText(R.string.status_connecting)
                    networks.refresh()
                } else {
                    showOverlay(getString(R.string.status_connect_failed))
                }
            }
        }
    }

    private fun onNetworkChanged(network: Network?) {
        if (network != null) {
            if (overlay.visibility == View.VISIBLE) {
                overlay.visibility = View.GONE
            }
            if (pageLoaded) {
                /* The page may be waiting in its reconnect backoff. */
                webView.evaluateJavascript("try{connect()}catch(e){}", null)
            }
        } else {
            showOverlay(getString(R.string.status_need_wifi))
        }
    }

    private fun showOverlay(message: String) {
        overlayStatus.text = message
        connectButton.visibility = View.VISIBLE
        overlay.visibility = View.VISIBLE
    }

    private fun releaseInputs() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            "try{releaseAllButtons(true);resetMotion();resetPadState();}catch(e){}",
            null
        )
    }

    private fun openWifiSettings() {
        val intent =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Intent(Settings.Panel.ACTION_WIFI)
            } else {
                Intent(Settings.ACTION_WIFI_SETTINGS)
            }

        try {
            startActivity(intent)
        } catch (_: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
            } catch (_: Exception) {
                Toast.makeText(
                    this,
                    R.string.status_open_settings_failed,
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
}
