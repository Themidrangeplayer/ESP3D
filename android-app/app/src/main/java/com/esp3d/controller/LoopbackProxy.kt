package com.esp3d.controller

import android.net.Network
import android.util.Log
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A transparent loopback TCP proxy for the controller WebSocket.
 *
 * WebView connects to ws://127.0.0.1:8081/. Each accepted connection is
 * forwarded to 192.168.4.1:81 using the SocketFactory of the ESP32 [Network],
 * which pins the upstream leg to the ESP32 Wi-Fi and never lets it fall back
 * to cellular. The WebSocket handshake and framing pass through untouched.
 */
class LoopbackProxy(
    private val networkProvider: () -> Network?,
    private val listenPort: Int = 8081,
    private val upstreamHost: String = EspNetworkManager.ESP_HOST,
    private val upstreamPort: Int = 81
) {
    companion object {
        private const val TAG = "ESP3D-Proxy"
        private const val CONNECT_TIMEOUT_MS = 4_000
        private const val BUFFER_SIZE = 16 * 1024
    }

    @Volatile
    private var running = false

    @Volatile
    private var serverSocket: ServerSocket? = null

    private var acceptThread: Thread? = null
    private val clients: MutableSet<Socket> = ConcurrentHashMap.newKeySet()

    @Synchronized
    fun start() {
        if (running) return
        running = true

        acceptThread = Thread({
            try {
                val socket = ServerSocket()
                socket.reuseAddress = true
                socket.bind(
                    InetSocketAddress(
                        InetAddress.getByName("127.0.0.1"),
                        listenPort
                    )
                )

                serverSocket = socket

                if (running) {
                    Log.i(TAG, "Listening on 127.0.0.1:$listenPort")

                    while (running) {
                        val client = try {
                            socket.accept()
                        } catch (error: IOException) {
                            if (running) continue else break
                        }

                        Thread({ handleClient(client) }, "esp3d-client")
                            .apply { isDaemon = true }
                            .start()
                    }
                } else {
                    closeQuietly(socket)
                }
            } catch (error: Exception) {
                Log.e(TAG, "Could not start the loopback proxy", error)
                running = false
            }
        }, "esp3d-proxy").apply { isDaemon = true }

        acceptThread?.start()
    }

    @Synchronized
    fun stop() {
        running = false

        closeQuietly(serverSocket)
        serverSocket = null

        for (client in clients.toList()) {
            closeQuietly(client)
        }
        clients.clear()

        acceptThread = null
    }

    private fun handleClient(client: Socket) {
        clients.add(client)

        var upstream: Socket? = null

        try {
            client.tcpNoDelay = true

            val network = networkProvider()
                ?: throw IOException("ESP3D Wi-Fi is not connected")

            val socket = network.socketFactory.createSocket()
            socket.tcpNoDelay = true
            socket.connect(
                InetSocketAddress(upstreamHost, upstreamPort),
                CONNECT_TIMEOUT_MS
            )
            upstream = socket
            clients.add(socket)

            val once = AtomicBoolean(false)
            val closeBoth = {
                if (once.compareAndSet(false, true)) {
                    closeQuietly(client)
                    closeQuietly(socket)
                    clients.remove(client)
                    clients.remove(socket)
                }
            }

            pump(client, socket, closeBoth)
            pump(socket, client, closeBoth)
        } catch (error: Exception) {
            Log.d(TAG, "Upstream unavailable: ${error.message}")
            closeQuietly(upstream)
            closeQuietly(client)
            clients.remove(client)
            if (upstream != null) clients.remove(upstream)
        }
    }

    private fun pump(from: Socket, to: Socket, onFinished: () -> Unit) {
        Thread({
            val buffer = ByteArray(BUFFER_SIZE)

            try {
                val input = from.getInputStream()
                val output = to.getOutputStream()

                while (running) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count > 0) {
                        output.write(buffer, 0, count)
                        output.flush()
                    }
                }
            } catch (_: IOException) {
                /* The peer closed or the network went away. */
            } finally {
                onFinished()
            }
        }, "esp3d-pump").apply { isDaemon = true }.start()
    }

    private fun closeQuietly(socket: Socket?) {
        if (socket == null) return
        try {
            socket.close()
        } catch (_: IOException) {
            /* ignore */
        }
    }

    private fun closeQuietly(socket: ServerSocket?) {
        if (socket == null) return
        try {
            socket.close()
        } catch (_: IOException) {
            /* ignore */
        }
    }
}
