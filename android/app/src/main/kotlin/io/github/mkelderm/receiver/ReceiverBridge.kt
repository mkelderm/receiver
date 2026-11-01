package io.github.mkelderm.receiver

import android.net.Uri
import android.os.SystemClock
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URL

/**
 * Laat de pagina met de receiver praten.
 *
 * Een pagina in de WebView mag de receiver niet zelf aanspreken: die staat op
 * een ander adres, kent alleen http en stuurt geen CORS-headers. Daarom vraagt
 * de pagina alles op haar eigen adres op, en geeft MainActivity het hier door:
 *
 *   /denon/<ip>/goform/<pagina>.xml?<commando>   naar http://<ip>/goform/...
 *   /denon/<ip>/dlna/play?url=..&title=..        speelt een stream af
 *   /denon-discover                              zoekt receivers op het netwerk
 *
 * tools/dev-server.mjs doet op de pc precies hetzelfde onder dezelfde adressen.
 *
 * Alleen adressen op een thuisnetwerk en alleen goform-pagina's: zo kan deze
 * doorgifte nooit iets anders bereiken dan een receiver in huis.
 */
object ReceiverBridge {

    private val FORWARD = Regex("""^/denon/([0-9.]+)/(goform/[A-Za-z0-9_]+\.xml)$""")
    private val QUERY = Regex("""^[A-Za-z0-9%/?._-]*$""")
    private val OCTET = Regex("""^(0|[1-9]\d{0,2})$""")
    private val PLAY = Regex("""^/denon/([0-9.]+)/dlna/play$""")
    private val STREAM = Regex("""^http://\S+$""")

    fun handles(path: String): Boolean = path == "/denon-discover" || path.startsWith("/denon/")

    /** Wordt aangeroepen op een achtergronddraad van de WebView; blokkeren mag. */
    fun respond(url: Uri): WebResourceResponse {
        val path = url.path.orEmpty()
        if (path == "/denon-discover") return json(discover())
        PLAY.matchEntire(path)?.let { return play(it.groupValues[1], url) }

        val match = FORWARD.matchEntire(path) ?: return text(400, "Ongeldig adres")
        val (host, page) = match.destructured
        val query = url.encodedQuery.orEmpty()
        if (!isLanAddress(host) || !QUERY.matches(query)) return text(400, "Ongeldig adres")

        val target = "http://$host/$page" + if (query.isEmpty()) "" else "?$query"
        return try {
            val (code, body) = get(target, connectMs = 2500, readMs = 4000)
            WebResourceResponse("text/xml", "utf-8", code, reason(code), NO_STORE, ByteArrayInputStream(body))
        } catch (_: IOException) {
            text(504, "Receiver niet bereikbaar")
        }
    }

    /** IPv4 op een thuisnetwerk: 10.x, 172.16-31.x of 192.168.x. */
    fun isLanAddress(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val b = parts.map { p ->
            if (!OCTET.matches(p)) return false
            p.toInt().takeIf { it in 0..255 } ?: return false
        }
        return b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168)
    }

    /* ─── Een stream afspelen ───────────────────────────────────────────── */

    // De receiver is ook een UPnP-mediaspeler (DLNA), op poort 8080. Daarmee
    // speelt hij elk http-adres af: eerst het adres zetten, dan Play. https
    // weigert hij. tools/dev-server.mjs doet hetzelfde.

    private const val AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1"

    private fun play(host: String, url: Uri): WebResourceResponse {
        val stream = url.getQueryParameter("url").orEmpty()
        val title = url.getQueryParameter("title").orEmpty().take(200)
        if (!isLanAddress(host) || !STREAM.matches(stream) || stream.length > 1500) {
            return text(400, "Ongeldig adres")
        }
        val didl =
            "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" " +
                "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">" +
                "<item id=\"1\" parentID=\"0\" restricted=\"1\"><dc:title>${escape(title)}</dc:title>" +
                "<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>" +
                "<res protocolInfo=\"http-get:*:audio/mpeg:*\">${escape(stream)}</res></item></DIDL-Lite>"
        return try {
            val set = soap(host, "SetAVTransportURI",
                "<CurrentURI>${escape(stream)}</CurrentURI><CurrentURIMetaData>${escape(didl)}</CurrentURIMetaData>")
            if (set != 200) return text(502, "De receiver weigert dit adres")
            if (soap(host, "Play", "<Speed>1</Speed>") != 200) return text(502, "De receiver start de stream niet")
            text(200, "OK")
        } catch (_: IOException) {
            text(504, "Receiver niet bereikbaar")
        }
    }

    private fun soap(host: String, action: String, args: String): Int {
        val body = ("<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
            "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body><u:$action xmlns:u=\"$AV_TRANSPORT\"><InstanceID>0</InstanceID>$args</u:$action></s:Body>" +
            "</s:Envelope>").toByteArray()
        val conn = URL("http://$host:8080/AVTransport/ctrl").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 2500
            conn.readTimeout = 8000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"")
            conn.setRequestProperty("SOAPACTION", "\"$AV_TRANSPORT#$action\"")
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            (if (code < 400) conn.inputStream else conn.errorStream)?.use { it.readNBytesCompat(MAX_BODY) }
            return code
        } finally {
            conn.disconnect()
        }
    }

    private fun escape(s: String) =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    /* ─── Zoeken op het netwerk ─────────────────────────────────────────── */

    private const val SEARCH =
        "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: 239.255.255.250:1900\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: 2\r\n" +
            "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"

    /**
     * Vraagt via SSDP welke mediaspelers er zijn, en houdt alleen Denon en
     * Marantz over. De antwoorden komen rechtstreeks terug naar dit socket, dus
     * een MulticastLock is niet nodig.
     */
    private fun discover(): JSONArray {
        val locations = LinkedHashMap<String, String>()
        try {
            DatagramSocket().use { socket ->
                socket.soTimeout = 300
                val message = SEARCH.toByteArray()
                val group = InetAddress.getByName("239.255.255.250")
                repeat(2) { socket.send(DatagramPacket(message, message.size, group, 1900)) }

                val buffer = ByteArray(2048)
                val until = SystemClock.elapsedRealtime() + 2500
                while (SystemClock.elapsedRealtime() < until) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    try {
                        socket.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        continue
                    }
                    val host = packet.address.hostAddress ?: continue
                    val location = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        .lineSequence()
                        .firstOrNull { it.startsWith("location:", ignoreCase = true) }
                        ?.substringAfter(':')
                        ?.trim()
                        ?: continue
                    if (isLanAddress(host)) locations.putIfAbsent(host, location)
                }
            }
        } catch (_: IOException) {
            // Geen netwerk: dan is er gewoon niets gevonden.
        }

        val found = JSONArray()
        for ((host, location) in locations) {
            val uri = Uri.parse(location)
            if (uri.scheme != "http" || uri.host != host) continue
            val xml = try {
                String(get(location, connectMs = 2000, readMs = 2500).second, Charsets.UTF_8)
            } catch (_: IOException) {
                continue
            }
            val manufacturer = tag(xml, "manufacturer")
            if (!manufacturer.contains("Denon", true) && !manufacturer.contains("Marantz", true)) continue
            found.put(
                JSONObject()
                    .put("host", host)
                    .put("name", tag(xml, "friendlyName"))
                    .put("model", tag(xml, "modelName").trimStart('*')),
            )
        }
        return found
    }

    private fun tag(xml: String, name: String): String =
        Regex("<$name>([^<]*)</$name>").find(xml)?.groupValues?.get(1)?.trim().orEmpty()

    /* ─── Hulpjes ───────────────────────────────────────────────────────── */

    private const val MAX_BODY = 256 * 1024

    private fun get(target: String, connectMs: Int, readMs: Int): Pair<Int, ByteArray> {
        val conn = URL(target).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = connectMs
            conn.readTimeout = readMs
            conn.useCaches = false
            conn.instanceFollowRedirects = false
            val code = conn.responseCode
            val stream = if (code < 400) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readNBytesCompat(MAX_BODY) } ?: ByteArray(0)
            return code to body
        } finally {
            conn.disconnect()
        }
    }

    /** InputStream.readNBytes bestaat pas vanaf Android 13. */
    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (out.size() < limit) {
            val n = read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private val NO_STORE = mapOf("Cache-Control" to "no-store")

    private fun reason(code: Int) = when (code) {
        200 -> "OK"
        400 -> "Bad Request"
        404 -> "Not Found"
        504 -> "Gateway Timeout"
        else -> "Status $code"
    }

    private fun text(code: Int, message: String) = WebResourceResponse(
        "text/plain", "utf-8", code, reason(code), NO_STORE, ByteArrayInputStream(message.toByteArray()),
    )

    private fun json(value: JSONArray) = WebResourceResponse(
        "application/json", "utf-8", 200, "OK", NO_STORE, ByteArrayInputStream(value.toString().toByteArray()),
    )
}
