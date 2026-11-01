// Testserver voor de webapp op deze pc. Geen dependencies. Start met:
//
//   node tools/dev-server.mjs
//
// Daarna op http://localhost:8790.
//
// Een browser mag niet zomaar met de receiver praten: die staat op een ander
// adres en stuurt geen CORS-headers mee. In de Android-app lost MainActivity dat
// op, en deze server doet hier precies hetzelfde, onder dezelfde adressen:
//
//   /denon/<ip>/goform/<pagina>.xml?<commando>   doorgegeven aan http://<ip>/goform/...
//   /denon/<ip>/dlna/play?url=..&title=..        speelt een stream af (UPnP AVTransport)
//   /denon-discover                              zoekt receivers op het netwerk (SSDP)
//
// Alles daarbuiten zijn de bestanden uit web/.
import { createServer, get as httpGet, request as httpRequest } from 'node:http'
import { createSocket } from 'node:dgram'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname, relative, isAbsolute } from 'node:path'
import { networkInterfaces } from 'node:os'

const ROOT = join(import.meta.dirname, '..', 'web')
const PORT = Number(process.env.PORT) || 8790

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/* ─── Receiver ────────────────────────────────────────────────────────────── */

/** Alleen adressen op het eigen netwerk; zo wordt dit nooit een open proxy. */
function isLanAddress(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const b = parts.map(p => (/^(0|[1-9]\d{0,2})$/.test(p) ? Number(p) : NaN))
  if (b.some(n => !(n >= 0 && n <= 255))) return false
  return b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168)
}

const FORWARD = /^\/denon\/([0-9.]+)\/(goform\/[A-Za-z0-9_]+\.xml)$/
const QUERY = /^[A-Za-z0-9%/?._-]*$/

function fetchText(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function forward(res, host, path, query) {
  if (!isLanAddress(host) || !QUERY.test(query)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Ongeldig adres')
    return
  }
  try {
    const r = await fetchText(`http://${host}/${path}${query ? '?' + query : ''}`)
    res.writeHead(r.status, { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(r.body)
  } catch {
    res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Receiver niet bereikbaar')
  }
}

/* Een stream afspelen via DLNA: de receiver is ook een UPnP-mediaspeler, op
   poort 8080. Eerst het adres zetten, dan Play. Zie ReceiverBridge.kt. */

const PLAY = /^\/denon\/([0-9.]+)\/dlna\/play$/
const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1'

const xmlEscape = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function soap(host, action, args) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${AV_TRANSPORT}"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port: 8080,
        path: '/AVTransport/ctrl',
        method: 'POST',
        timeout: 8000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(body),
          SOAPACTION: `"${AV_TRANSPORT}#${action}"`,
        },
      },
      res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

async function play(res, host, params) {
  const url = params.get('url') ?? ''
  const title = (params.get('title') ?? '').slice(0, 200)
  const text = (code, msg) => res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg)
  if (!isLanAddress(host) || !/^http:\/\/[^\s]+$/.test(url) || url.length > 1500) {
    return text(400, 'Ongeldig adres')
  }
  const didl =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="1" parentID="0" restricted="1"><dc:title>${xmlEscape(title)}</dc:title>` +
    '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
    `<res protocolInfo="http-get:*:audio/mpeg:*">${xmlEscape(url)}</res></item></DIDL-Lite>`
  try {
    const set = await soap(host, 'SetAVTransportURI',
      `<CurrentURI>${xmlEscape(url)}</CurrentURI><CurrentURIMetaData>${xmlEscape(didl)}</CurrentURIMetaData>`)
    if (set !== 200) return text(502, 'De receiver weigert dit adres')
    const started = await soap(host, 'Play', '<Speed>1</Speed>')
    if (started !== 200) return text(502, 'De receiver start de stream niet')
    text(200, 'OK')
  } catch {
    text(504, 'Receiver niet bereikbaar')
  }
}

const SEARCH = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: 239.255.255.250:1900\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n',
)

const tag = (xml, name) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) ?? [])[1]?.trim() ?? ''

/**
 * Stuurt een SSDP-zoekvraag uit over elke netwerkkaart en vraagt bij elk
 * apparaat dat antwoordt de beschrijving op. Houdt alleen Denon en Marantz.
 */
async function discover() {
  const locations = new Map()
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address)

  await Promise.all(
    addresses.map(
      address =>
        new Promise(resolve => {
          const socket = createSocket('udp4')
          socket.on('error', () => resolve())
          socket.on('message', (msg, rinfo) => {
            const location = /^location:\s*(\S+)/im.exec(msg.toString())?.[1]
            if (location && isLanAddress(rinfo.address) && !locations.has(rinfo.address)) {
              locations.set(rinfo.address, location)
            }
          })
          socket.bind(0, address, () => {
            socket.setMulticastInterface(address)
            socket.send(SEARCH, 1900, '239.255.255.250')
            setTimeout(() => socket.send(SEARCH, 1900, '239.255.255.250'), 300)
          })
          setTimeout(() => {
            socket.close()
            resolve()
          }, 2500)
        }),
    ),
  )

  const found = []
  for (const [host, location] of locations) {
    let url
    try {
      url = new URL(location)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' || url.hostname !== host) continue
    try {
      const xml = (await fetchText(url.href, 2500)).body.toString()
      const manufacturer = tag(xml, 'manufacturer')
      if (!/denon|marantz/i.test(manufacturer)) continue
      found.push({ host, name: tag(xml, 'friendlyName'), model: tag(xml, 'modelName').replace(/^\*/, '') })
    } catch {
      // Geen beschrijving: dan ook geen receiver die we kunnen tonen.
    }
  }
  return found
}

/* ─── Bestanden ───────────────────────────────────────────────────────────── */

async function serveFile(res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'

  // Pad-traversal blokkeren, via relative() en niet met startsWith: dat zou ook
  // een map naast ROOT doorlaten waarvan de naam met "web" begint.
  const abs = normalize(join(ROOT, rel))
  const inside = relative(ROOT, abs)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    res.writeHead(403).end('Verboden')
    return
  }

  const info = await stat(abs)
  if (info.isDirectory()) {
    res.writeHead(302, { Location: rel.replace(/\/?$/, '/') + 'index.html' }).end()
    return
  }
  const body = await readFile(abs)
  res.writeHead(200, {
    'Content-Type': TYPES[extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const m = FORWARD.exec(url.pathname)
    if (m) return await forward(res, m[1], m[2], url.search.slice(1))
    const p = PLAY.exec(url.pathname)
    if (p) return await play(res, p[1], url.searchParams)
    if (url.pathname === '/denon-discover') {
      const body = JSON.stringify(await discover())
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(body)
    }
    await serveFile(res, url.pathname)
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : 500
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(code === 404 ? 'Niet gevonden' : 'Serverfout')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Receiver draait op  http://localhost:${PORT}`)
  console.log(`Map: ${ROOT}`)
})
