package com.esp3d.controller

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * Finds the Wi-Fi network created by the ESP32 and can ask Android to join it.
 *
 * The ESP32 hands the phone an address in 192.168.4.0/24 and uses
 * 192.168.4.1 as the gateway, so the network can be identified from its
 * [LinkProperties] without reading the SSID or requiring location access.
 */
class EspNetworkManager(
    context: Context,
    private val onNetworkChanged: (Network?) -> Unit
) {
    companion object {
        const val AP_SSID = "ESP3D_Controller"
        const val AP_PASSWORD = "ESP3D-1234"
        const val ESP_HOST = "192.168.4.1"
        private const val TAG = "ESP3D-Network"
        private const val REQUEST_TIMEOUT_MS = 60_000
    }

    private val connectivity =
        context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var lastNetwork: Network? = null
    private var watcher: ConnectivityManager.NetworkCallback? = null
    private var request: ConnectivityManager.NetworkCallback? = null

    fun start() {
        if (watcher != null) return

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = publish()
            override fun onLost(network: Network) = publish()
            override fun onLinkPropertiesChanged(
                network: Network,
                linkProperties: LinkProperties
            ) = publish()
        }

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .build()

        try {
            connectivity.registerNetworkCallback(request, callback, mainHandler)
            watcher = callback
        } catch (error: Exception) {
            Log.w(TAG, "Could not watch Wi-Fi networks", error)
        }

        publish(force = true)
    }

    fun stop() {
        watcher?.let { callback ->
            runCatching { connectivity.unregisterNetworkCallback(callback) }
        }
        watcher = null

        request?.let { callback ->
            runCatching { connectivity.unregisterNetworkCallback(callback) }
        }
        request = null
    }

    fun refresh() = publish(force = true)

    /** The Wi-Fi network whose link belongs to the ESP32 access point. */
    fun currentNetwork(): Network? = findEspNetwork()

    /**
     * Shows Android's Wi-Fi approval dialog for the ESP32 AP. The resulting
     * network is app-scoped, local-only, and stays up while the callback is
     * registered.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    fun requestEspNetwork(onResult: (Boolean) -> Unit) {
        request?.let { callback ->
            runCatching { connectivity.unregisterNetworkCallback(callback) }
        }

        val specifier = WifiNetworkSpecifier.Builder()
            .setSsid(AP_SSID)
            .setWpa2Passphrase(AP_PASSWORD)
            .build()

        val networkRequest = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier)
            .build()

        val callback = object : ConnectivityManager.NetworkCallback() {
            private var answered = false

            override fun onAvailable(network: Network) {
                publish()
                if (!answered) {
                    answered = true
                    onResult(true)
                }
            }

            override fun onLinkPropertiesChanged(
                network: Network,
                linkProperties: LinkProperties
            ) = publish()

            override fun onLost(network: Network) = publish()

            override fun onUnavailable() {
                if (answered) return
                answered = true
                request = null
                runCatching { connectivity.unregisterNetworkCallback(this) }
                onResult(false)
            }
        }

        request = callback

        try {
            connectivity.requestNetwork(
                networkRequest,
                callback,
                mainHandler,
                REQUEST_TIMEOUT_MS
            )
        } catch (error: Exception) {
            Log.w(TAG, "Could not request the ESP3D network", error)
            request = null
            onResult(false)
        }
    }

    private fun findEspNetwork(): Network? {
        val networks = try {
            connectivity.allNetworks
        } catch (error: Exception) {
            Log.w(TAG, "Could not enumerate networks", error)
            return null
        }

        for (network in networks) {
            val capabilities =
                connectivity.getNetworkCapabilities(network) ?: continue
            if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue

            val link = connectivity.getLinkProperties(network) ?: continue
            if (isEspLink(link)) return network
        }

        return null
    }

    private fun isEspLink(link: LinkProperties): Boolean {
        for (route in link.routes) {
            if (route.gateway?.hostAddress == ESP_HOST) return true
        }

        for (linkAddress in link.linkAddresses) {
            val address = linkAddress.address?.hostAddress ?: continue
            if (address.startsWith("192.168.4.")) return true
        }

        return false
    }

    private fun publish(force: Boolean = false) {
        val network = findEspNetwork()
        if (!force && network == lastNetwork) return

        lastNetwork = network
        onNetworkChanged(network)
    }
}
