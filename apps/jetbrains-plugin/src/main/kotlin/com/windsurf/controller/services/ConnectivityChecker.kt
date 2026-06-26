package com.windsurf.controller.services

import java.net.HttpURLConnection
import java.net.URL

enum class Reachability { REACHABLE, BLOCKED }

object ConnectivityChecker {
    // The one detection primitive: did we get any HTTP response from our API?
    fun checkApiReachable(apiBaseUrl: String, timeoutMs: Int = 3500): Reachability {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL("${apiBaseUrl.trimEnd('/')}/healthz").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
            }
            conn.responseCode // forces the request; any status = reachable
            Reachability.REACHABLE
        } catch (e: Exception) {
            Reachability.BLOCKED
        } finally {
            conn?.disconnect()
        }
    }
}
