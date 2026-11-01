// Genereert de app-iconen als echte PNG-bestanden.
//
//   node tools/make-icons.mjs
//
// Het script schrijft de PNG's met de hand (IHDR/IDAT/IEND + CRC32), zodat er
// geen enkele dependency nodig is. Het hoeft alleen opnieuw te draaien als het
// beeldmerk verandert.
//
// Het schrijft het icoon van de webpagina (web/) en de lagen van het adaptieve
// icoon van de Android-app (android/app/src/main/res/mipmap-*).

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/* ─── PNG schrijven ───────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Zet RGBA-pixels om naar een PNG-bestand (8 bits, kleurtype 6). */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 //  bitdiepte
  ihdr[9] = 6 //  kleurtype RGBA
  ihdr[10] = 0 // compressie: deflate
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // geen interlace

  // Elke scanline krijgt een filterbyte 0 (geen filter) vooraf.
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ─── Het beeldmerk ───────────────────────────────────────────────────────── */

// De draaiknop uit de app: een ring die voor tweederde oplicht, met in het
// midden een aluminium knop en een streepje dat naar het einde van de ring wijst.
const GROUND = [0x13, 0x24, 0x2b] //  rookglas, de achtergrond van de app
const TRACK = [0x2b, 0x46, 0x51] //   het deel van de ring dat uit staat
const PHOSPHOR = [0x7c, 0xf2, 0xdf] // de kleur van het display
const KNOB = [0xd5, 0xda, 0xdd] //    aluminium
const KNOB_EDGE = [0xa9, 0xb1, 0xb6]

const START = 135 //  graden met de klok mee vanaf 3 uur, zoals in app.js
const SWEEP = 270
const LEVEL = 0.62 // hoe ver de ring oplicht

const RING_R = 0.8 //     midden van de ring
const RING_W = 0.15 //    dikte van de ring
const KNOB_R = 0.56
const EDGE_W = 0.045
const MARK_IN = 0.2 //    het streepje op de knop, van hier
const MARK_OUT = 0.44 //  tot hier
const MARK_W = 0.075

const END = START + SWEEP * LEVEL
const rad = d => (d * Math.PI) / 180
const MARK = [Math.cos(rad(END)), Math.sin(rad(END))]

/** Hoek in graden vanaf START, 0 tot 360. */
function along(x, y) {
  let a = (Math.atan2(y, x) * 180) / Math.PI
  while (a < START) a += 360
  return a - START
}

/** Welk onderdeel ligt er op dit punt (in vormruimte, -1 tot 1)? */
function shape(x, y) {
  const r = Math.hypot(x, y)
  if (Math.abs(r - RING_R) <= RING_W / 2) {
    const a = along(x, y)
    // Ronde uiteinden: een halve cirkel om begin en eind van elk stuk.
    if (a <= SWEEP * LEVEL) return 'lit'
    if (a <= SWEEP) return 'track'
  }
  for (const [deg, part] of [[START, 'lit'], [END, 'lit'], [START + SWEEP, 'track']]) {
    const cx = RING_R * Math.cos(rad(deg))
    const cy = RING_R * Math.sin(rad(deg))
    if (Math.hypot(x - cx, y - cy) <= RING_W / 2) return part
  }
  if (r <= KNOB_R) {
    // Het streepje: afstand tot het lijnstuk langs MARK.
    const t = x * MARK[0] + y * MARK[1]
    const off = Math.abs(-x * MARK[1] + y * MARK[0])
    if (t >= MARK_IN && t <= MARK_OUT && off <= MARK_W / 2) return 'mark'
    return r >= KNOB_R - EDGE_W ? 'edge' : 'knob'
  }
  return null
}

const COLORS = { lit: PHOSPHOR, track: TRACK, knob: KNOB, edge: KNOB_EDGE, mark: GROUND }

const SAMPLES = 4 // 4x4 per pixel, genoeg om de randen glad te krijgen

/**
 * @param size   breedte en hoogte in pixels
 * @param scale  hoe groot het beeldmerk mag worden; de ring reikt tot
 *               0,875 x scale vanaf het midden (1 = halve canvasbreedte)
 * @param layer  'full'        dekkend icoon met de achtergrond erin (web)
 *               'foreground'  alleen het beeldmerk, rest transparant (Android)
 *               'monochrome'  silhouet voor de thema-iconen van Android 13+:
 *                             alleen de alfa telt; het uitgeschakelde deel van
 *                             de ring en het streepje zijn gaten
 */
function drawIcon(size, scale, layer = 'full') {
  const rgba = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0]
      let cover = 0
      let mono = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) / size * 2 - 1) / scale
          const y = ((py + (sy + 0.5) / SAMPLES) / size * 2 - 1) / scale
          const part = shape(x, y)
          if (part === 'lit' || part === 'knob' || part === 'edge') mono++
          const color = part ? COLORS[part] : layer === 'full' ? GROUND : null
          if (!color) continue
          cover++
          for (let ch = 0; ch < 3; ch++) sum[ch] += color[ch]
        }
      }

      const total = SAMPLES * SAMPLES
      const i = (py * size + px) * 4

      if (layer === 'monochrome') {
        rgba.fill(255, i, i + 3)
        rgba[i + 3] = Math.round((mono / total) * 255)
        continue
      }
      for (let ch = 0; ch < 3; ch++) rgba[i + ch] = cover ? Math.round(sum[ch] / cover) : 0
      rgba[i + 3] = Math.round((cover / total) * 255)
    }
  }

  return encodePng(size, size, rgba)
}

/* ─── Schrijven ───────────────────────────────────────────────────────────── */

const root = join(import.meta.dirname, '..')
const web = join(root, 'web')
const res = join(root, 'android', 'app', 'src', 'main', 'res')

const targets = [{ file: join(web, 'icon-192.png'), size: 192, scale: 1.0 }]

// Adaptief icoon: 108 dp per laag, waarvan de launcher hooguit de binnenste
// 72 dp laat zien en alleen een cirkel van 66 dp gegarandeerd is (straal 0,61).
// Met 0,66 reikt de ring tot 0,58: binnen die cirkel.
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [density, factor] of Object.entries(DENSITIES)) {
  const size = 108 * factor
  const dir = join(res, `mipmap-${density}`)
  targets.push(
    { file: join(dir, 'ic_launcher_foreground.png'), size, scale: 0.66, layer: 'foreground' },
    { file: join(dir, 'ic_launcher_monochrome.png'), size, scale: 0.66, layer: 'monochrome' },
  )
}

for (const { file, size, scale, layer } of targets) {
  const png = drawIcon(size, scale, layer)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
  const name = relative(root, file).replaceAll('\\', '/')
  console.log(`${name.padEnd(68)} ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} bytes`)
}
