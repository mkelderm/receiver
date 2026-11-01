// Het protocol van de receiver, los van de browser.
//
// Een Denon uit 2014-2016 heeft een kleine webserver op poort 80. Daarop staan
// statuspagina's in XML, en één adres dat elk commando uit het telnetprotocol
// doorgeeft: goform/formiPhoneAppDirect.xml?<commando>. Meer is er niet nodig.
//
// Dit bestand bouwt die adressen en leest de XML. Het raakt geen fetch of DOM,
// zodat Node het kan importeren en de tests precies deze code controleren.

/** Statuspagina met alleen aan/uit, ingang, volume en dempen: klein, voor vaak. */
export const STATUS_LITE = 'goform/formMainZone_MainZoneXmlStatusLite.xml'

/** Statuspagina met daarnaast de lijst ingangen en de geluidsstand. */
export const STATUS_FULL = 'goform/formMainZone_MainZoneXmlStatus.xml'

/** Statuspagina met de naam van de receiver, voor als je zelf een IP-adres invult. */
export const STATUS_MAIN = 'goform/formMainZone_MainZoneXml.xml'

/** Het hoogste volume dat de receiver kent (+18 dB). */
export const VOLUME_MAX = 98

/**
 * De ingangen van de receiver, in de volgorde van zijn eigen lijst.
 *
 * `id` is de naam in InputFuncList. `cmd` schakelt erheen. `aliases` zijn de
 * namen waaronder de receiver de ingang als huidige ingang kan melden: dat is
 * niet altijd dezelfde naam als in de lijst. Netwerk meldt zich zelfs met de
 * dienst die speelt, zoals "Internet Radio".
 */
const INPUTS = [
  { id: 'CBL/SAT', cmd: 'SISAT/CBL', aliases: ['SAT/CBL', 'SAT', 'CBL'] },
  { id: 'DVD', cmd: 'SIDVD', aliases: [] },
  { id: 'BLU-RAY', cmd: 'SIBD', aliases: ['BD'] },
  { id: 'GAME', cmd: 'SIGAME', aliases: [] },
  { id: 'AUX', cmd: 'SIAUX1', aliases: ['AUX1'] },
  { id: 'MEDIA PLAYER', cmd: 'SIMPLAY', aliases: ['MPLAY'] },
  { id: 'IPOD/USB', cmd: 'SIUSB/IPOD', aliases: ['USB/IPOD', 'USB', 'IPOD'] },
  { id: 'TUNER', cmd: 'SITUNER', aliases: [] },
  {
    id: 'NETWORK',
    cmd: 'SINET',
    aliases: ['NET', 'ONLINE MUSIC', 'PANDORA', 'SIRIUSXM', 'FLICKR', 'LASTFM', 'AIRPLAY'],
  },
  { id: 'TV AUDIO', cmd: 'SITV', aliases: ['TV'] },
  { id: 'BLUETOOTH', cmd: 'SIBT', aliases: ['BT'] },
]

/**
 * Diensten binnen de netwerkingang die een eigen knop krijgen. Ze staan niet in
 * de lijst van de receiver, maar hij meldt ze wel als huidige ingang.
 *
 * Favorieten speelt de app af via het menu van de receiver ("Favorites") of
 * via een eigen adres; dat laatste meldt de receiver als "Media Server".
 */
export const NET_SERVICES = [
  { id: 'IRADIO', name: 'Internet Radio', aliases: ['INTERNET RADIO', 'IRADIO'] },
  { id: 'SPOTIFY', name: 'Spotify', aliases: ['SPOTIFY', 'SPOTIFYCONNECT', 'SPOTIFY CONNECT'] },
  { id: 'FAVORITES', name: 'Favorieten', aliases: ['FAVORITES', 'MEDIA SERVER', 'SERVER'] },
]

/**
 * De geluidsstanden onder het tabblad Geluid. Film, muziek en game kiezen elk
 * de laatst gebruikte stand binnen die groep; zo doet de afstandsbediening van
 * de receiver het ook.
 */
export const SOUND_MODES = [
  { id: 'auto', cmd: 'MSAUTO', label: 'Automatisch', hint: 'De receiver kiest zelf, op basis van wat er binnenkomt' },
  { id: 'stereo', cmd: 'MSSTEREO', label: 'Stereo', hint: 'Links en rechts, zoals het is opgenomen' },
  { id: 'direct', cmd: 'MSDIRECT', label: 'Direct', hint: 'Zonder bewerking, met toon en Audyssey uit' },
  { id: 'movie', cmd: 'MSMOVIE', label: 'Film', hint: 'Surround voor films en series' },
  { id: 'music', cmd: 'MSMUSIC', label: 'Muziek', hint: 'Muziek uit alle luidsprekers' },
  { id: 'game', cmd: 'MSGAME', label: 'Game', hint: 'Surround voor spellen' },
]

const norm = s => s.trim().replace(/\s+/g, ' ').toUpperCase()

/** Het blok van één element, of null als het er niet is. */
function block(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? m[1] : null
}

/**
 * Alle teksten in <value>-elementen binnen een element. Neemt alleen de
 * binnenste, dus <value><value>Game</value></value> geeft "Game".
 */
function values(xml, tag) {
  const b = block(xml, tag)
  if (b === null) return null
  return [...b.matchAll(/<value>([^<]*)<\/value>/g)].map(m => decode(m[1]).trim())
}

function value(xml, tag) {
  const v = values(xml, tag)
  return v && v.length ? v[0] : null
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Zet het volume in dB, zoals de receiver het meldt, om naar de schaal op zijn
 * display: 0 tot 98, waarbij 80 gelijk is aan 0 dB. Het laagste volume meldt hij
 * als "--" of "---"; dat is 0.
 */
export function volumeFromDb(text) {
  if (text === null || text === undefined) return null
  const t = String(text).trim()
  if (/^-+$/.test(t)) return 0
  const db = Number(t)
  if (t === '' || !Number.isFinite(db)) return null
  return clampVolume(db + 80)
}

/** Rondt af op halve stappen, de kleinste stap van de receiver, binnen 0..98. */
export function clampVolume(v, max = VOLUME_MAX) {
  const top = Math.min(max, VOLUME_MAX)
  return Math.min(top, Math.max(0, Math.round(v * 2) / 2))
}

/**
 * Leest een van de twee statuspagina's. Wat in de pagina ontbreekt, staat in
 * het resultaat niet: de kleine pagina heeft bijvoorbeeld geen lijst ingangen.
 */
export function parseStatus(xml) {
  const out = {}

  const name = value(xml, 'FriendlyName')
  if (name) out.name = name

  const power = value(xml, 'Power')
  if (power !== null) out.power = norm(power) === 'ON'

  const input = value(xml, 'InputFuncSelect')
  if (input !== null) out.input = input

  const volume = value(xml, 'MasterVolume')
  if (volume !== null) out.volume = volumeFromDb(volume)

  const mute = value(xml, 'Mute')
  if (mute !== null) out.mute = norm(mute) === 'ON'

  const surround = value(xml, 'SurrMode')
  if (surround !== null) out.soundMode = surround.replace(/\s+/g, ' ')

  const list = values(xml, 'InputFuncList')
  if (list) {
    const names = values(xml, 'RenameSource') ?? []
    const deleted = values(xml, 'SourceDelete') ?? []
    out.sources = []
    list.forEach((id, i) => {
      const known = INPUTS.find(s => s.id === norm(id))
      // Een ingang die op de receiver verborgen is, staat er als DEL. Netwerk
      // heeft geen waarde: dat kun je niet verbergen.
      if (!known || norm(deleted[i] ?? '') === 'DEL') return
      out.sources.push({ id: known.id, name: names[i] || id, cmd: known.cmd })
    })
  }

  return out
}

/**
 * Bij welke ingang hoort de naam die de receiver als huidige ingang meldt?
 * Geeft het id, of null als het geen bekende ingang is.
 */
export function inputId(reported, sources = []) {
  if (!reported) return null
  const r = norm(reported)
  const byName = sources.find(s => norm(s.name) === r)
  if (byName) return byName.id
  const service = NET_SERVICES.find(s => s.aliases.includes(r))
  if (service) return service.id
  const known = INPUTS.find(s => s.id === r || s.aliases.includes(r))
  return known ? known.id : null
}

/** Welke knop onder Geluid hoort bij de stand die de receiver meldt? */
export function soundModeId(reported) {
  if (!reported) return null
  const r = norm(reported)
  if (r === 'STEREO') return 'stereo'
  if (r === 'DIRECT' || r === 'PURE DIRECT') return 'direct'
  if (r === 'AUTO') return 'auto'
  return null
}

/**
 * Is dit een IPv4-adres op een thuisnetwerk (10.x, 172.16-31.x, 192.168.x)?
 * De app praat alleen met zulke adressen; de Android-app en de testserver
 * controleren dat zelf nog eens.
 */
export function isLanAddress(host) {
  const parts = String(host).split('.')
  if (parts.length !== 4) return false
  const b = parts.map(p => (/^(0|[1-9]\d{0,2})$/.test(p) ? Number(p) : NaN))
  if (b.some(n => !(n >= 0 && n <= 255))) return false
  return b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168)
}

/** Het commando dat het volume op een vaste waarde zet: 25,5 wordt MV255. */
export function volumeCommand(v) {
  const c = clampVolume(v)
  const whole = String(Math.floor(c)).padStart(2, '0')
  return 'MV' + whole + (c % 1 ? '5' : '')
}

/** Het adres op de receiver dat een commando uitvoert. */
export function commandPath(cmd) {
  if (!/^[A-Z0-9/ ?.]+$/.test(cmd)) throw new Error(`Ongeldig commando: ${cmd}`)
  return 'goform/formiPhoneAppDirect.xml?' + cmd.replace(/ /g, '%20')
}

/** Zoals de receiver het volume toont, met een komma: 25,5. */
export function formatVolume(v) {
  if (v === null || v === undefined) return '--'
  return v % 1 ? v.toFixed(1).replace('.', ',') : String(v)
}

/** Volume als dB-tekst voor de kleine regel onder het getal: −54,5 dB. */
export function formatDb(v) {
  if (v === null || v === undefined) return ''
  if (v === 0) return 'stil'
  const db = v - 80
  const abs = Math.abs(db)
  const t = abs % 1 ? abs.toFixed(1).replace('.', ',') : String(abs)
  return (db < 0 ? '−' : db > 0 ? '+' : '') + t + ' dB'
}

/* ─── Het netwerkmenu ─────────────────────────────────────────────────────── */

// Favorieten en internetradio staan in het menu dat de receiver op de tv laat
// zien. Er is geen commando dat de favorieten als lijst teruggeeft; ook de
// eigen webpagina van de receiver leest het menu regel voor regel en loopt er
// met de cursor doorheen. De app doet dat net zo.

/** Wat het netwerkmenu nu laat zien. */
export const NET_STATUS = 'goform/formNetAudio_StatusXml.xml'

/** Knoppen van het netwerkmenu, zoals op de afstandsbediening. */
export const NAV = {
  up: 'NS90',
  down: 'NS91',
  back: 'NS92',
  enter: 'NS94',
}

/** Zoveel regels laat het menu per pagina zien. */
export const NET_PAGE = 7

/**
 * Leest het netwerkmenu. Regel 0 is de titel ("Favorites", "Now Playing"),
 * regels 1 tot en met 7 de inhoud. Bij elke regel hoort een vlag: 8 is de
 * cursor, 1 is iets dat je kunt afspelen.
 */
export function parseNetScreen(xml) {
  // De receiver codeert & in deze pagina dubbel: "&amp;amp;".
  const twice = list => (list ?? []).map(s => decode(s).trim())
  const lines = twice(values(xml, 'szLine'))
  const flags = (values(xml, 'chFlag') ?? []).map(f => Number.parseInt(f, 10) || 0)
  const items = []
  for (let i = 1; i <= NET_PAGE; i++) items.push(lines[i] ?? '')
  // "Now Playing" is geen lijst, ook al staat daar soms een vlag op een regel.
  let cursor = null
  if (!/now playing/i.test(lines[0] ?? '')) {
    for (let i = 1; i <= NET_PAGE; i++) if ((flags[i] ?? 0) & 8) cursor = i
  }
  // Regel 8 is "[ 17/27 ]": waar de cursor staat in de hele lijst, en hoe lang
  // die is. Na bladeren werkt de receiver dit niet bij; na een cursorstap wel.
  const pos = /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/.exec(lines[8] ?? '')
  return {
    title: lines[0] ?? '',
    items,
    cursor, // 1..7, of null als er geen lijst staat (zoals bij Now Playing)
    index: pos ? Number(pos[1]) : null,
    total: pos ? Number(pos[2]) : null,
    service: norm(value(xml, 'NetFuncSelect') ?? ''),
  }
}

/** Een plek in een ronde lijst van n, van 1 tot en met n. */
export function wrap(i, n) {
  return ((((i - 1) % n) + n) % n) + 1
}

/**
 * De zenders die op het scherm staan, met hun plek in de hele lijst. `start` is
 * de plek van de bovenste regel.
 */
export function visibleEntries(screen, start) {
  const out = []
  screen.items.forEach((name, i) => {
    if (name && i < screen.total) out.push({ index: wrap(start + i, screen.total), name })
  })
  return out
}

/**
 * Welke knoppen brengen de cursor van plek `from` naar plek `target`?
 *
 * Zo gedraagt het favorietenmenu van de receiver zich (gemeten op een
 * AVR-X1200W): de lijst is rond, en omlaag en omhoog verschuiven de cursor één
 * plek. Bladeren per pagina doet iets anders op de eerste pagina dan verderop,
 * en daarna negeert de receiver een paar knoppen; dat gebruikt de app niet.
 * Gekozen wordt de kortste kant.
 */
export function planMove(from, target, total) {
  const forward = (target - from + total) % total
  const backward = (from - target + total) % total
  return forward <= backward ? Array(forward).fill(NAV.down) : Array(backward).fill(NAV.up)
}

/** Een korte vingerafdruk van het scherm, om te zien of een knop iets deed. */
export function screenKey(s) {
  return [s.service, s.title, s.cursor, ...s.items].join('\u0001')
}

/**
 * Wat er nu speelt, als het netwerkmenu op "Now Playing" staat. Bij
 * internetradio staat de zender op regel 2 en het nummer op regel 1; bij een
 * eigen adres staat de titel op regel 1.
 */
export function nowPlaying(s) {
  if (!/now playing/i.test(s.title)) return null
  const [first, second] = s.items
  return { station: second || first || '', track: second ? first : '' }
}

/* ─── Afspelen via een adres ──────────────────────────────────────────────── */

/**
 * Controleert een stream-adres. De receiver speelt alleen http; een https-adres
 * weigert hij. Geeft een foutmelding, of null als het adres goed is.
 */
export function streamUrlProblem(url) {
  const u = String(url ?? '').trim()
  if (!u) return 'Vul het adres van de stream in.'
  let parsed
  try {
    parsed = new URL(u)
  } catch {
    return 'Dat is geen geldig adres. Het begint met http://'
  }
  if (parsed.protocol === 'https:') {
    return 'De receiver speelt geen https-adressen. Probeer hetzelfde adres met http:// ervoor.'
  }
  if (parsed.protocol !== 'http:') return 'Het adres moet met http:// beginnen.'
  if (u.length > 1500) return 'Dat adres is te lang.'
  return null
}

/** Het adres waarmee de app de receiver een stream laat afspelen. */
export function playUrlPath(url, title) {
  return `dlna/play?url=${encodeURIComponent(url.trim())}&title=${encodeURIComponent(title)}`
}

/* ─── De favorietenlijst van de app ───────────────────────────────────────── */

/**
 * Voegt de favorieten die net van de receiver zijn gelezen samen met de lijst
 * in de app. De volgorde, namen, adressen en verborgen zenders uit de app
 * blijven staan; alleen de plek in het menu van de receiver wordt bijgewerkt.
 * Nieuwe zenders komen onderaan. Zenders die niet meer op de receiver staan en
 * geen eigen adres hebben, vervallen.
 *
 * Twee zenders met dezelfde naam (de receiver kan "Radio 10" twee keer hebben)
 * worden op volgorde gekoppeld.
 *
 * @param list      [{ id, name, url?, hidden?, receiver?: { name, index, total } }]
 * @param receiver  [{ name, index, total }] in de volgorde van het menu
 * @param makeId    maakt een id voor een nieuwe zender
 */
export function mergeFavorites(list, receiver, makeId = newFavoriteId) {
  const pool = new Map()
  for (const r of receiver) {
    if (!pool.has(r.name)) pool.set(r.name, [])
    pool.get(r.name).push(r)
  }
  const used = new Set()
  const out = []
  for (const fav of list) {
    if (!fav.receiver) {
      out.push(fav)
      continue
    }
    const match = pool.get(fav.receiver.name)?.shift()
    if (match) {
      used.add(match)
      out.push({ ...fav, receiver: match })
    } else if (fav.url) {
      const { receiver: _gone, ...rest } = fav
      out.push(rest)
    }
  }
  for (const r of receiver) {
    if (!used.has(r)) out.push({ id: makeId(), name: r.name, receiver: r })
  }
  return out
}

export function newFavoriteId() {
  return 'f' + Math.random().toString(36).slice(2, 10)
}

/** Schuift een favoriet een plek op (-1 omhoog, +1 omlaag). */
export function moveFavorite(list, id, delta) {
  const i = list.findIndex(f => f.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return list
  const out = [...list]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}
