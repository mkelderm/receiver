// De afstandsbediening: status ophalen, tekenen, en wat je aanraakt doorgeven.
//
// De receiver is de bron van de waarheid. Elke anderhalve seconde vraagt de app
// hoe hij erbij staat; zo klopt het scherm ook als iemand de gewone
// afstandsbediening pakt. Wat je zelf aanraakt, toont de app meteen, en de
// status van de receiver mag dat een paar seconden niet overschrijven: anders
// springt een knop even terug terwijl de receiver nog aan het omschakelen is.

import {
  STATUS_LITE, STATUS_FULL, STATUS_MAIN, VOLUME_MAX, SOUND_MODES, NET_STATUS, NET_SERVICES, NAV,
  parseStatus, inputId, soundModeId, clampVolume, volumeCommand, commandPath,
  formatVolume, formatDb, isLanAddress, parseNetScreen, screenKey, nowPlaying,
  streamUrlProblem, playUrlPath, mergeFavorites, moveFavorite, newFavoriteId,
  wrap, visibleEntries, planMove,
} from './denon.js'

const $ = id => document.getElementById(id)

/* ─── Bewaard op de telefoon ──────────────────────────────────────────────── */

const KEY = 'receiver.v1'

// Zonder eigen keuze: de ingangen die thuis niet gebruikt worden, uit.
const DEFAULT_HIDDEN = ['CBL/SAT', 'GAME', 'AUX', 'BLUETOOTH']

const settings = (() => {
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem(KEY)) ?? {}
  } catch {
    // Kapotte of lege opslag: dan beginnen we gewoon opnieuw.
  }
  return {
    host: typeof saved.host === 'string' && isLanAddress(saved.host) ? saved.host : '',
    name: typeof saved.name === 'string' ? saved.name : '',
    maxVolume: Number.isFinite(saved.maxVolume) ? saved.maxVolume : 70,
    // De ingangen van de vorige keer, zodat de knoppen er meteen staan.
    sources: Array.isArray(saved.sources) ? saved.sources : [],
    // Knoppen die je in de instellingen hebt uitgezet.
    hidden: Array.isArray(saved.hidden) ? saved.hidden : DEFAULT_HIDDEN,
    // De favorieten zoals je ze in de app hebt ingericht.
    favorites: Array.isArray(saved.favorites) ? saved.favorites : [],
  }
})()

function save() {
  localStorage.setItem(KEY, JSON.stringify(settings))
}

/* ─── Toestand ────────────────────────────────────────────────────────────── */

const state = {
  reachable: null, // null: nog niet geprobeerd
  power: null,
  input: null,
  volume: null,
  mute: false,
  soundMode: null,
  station: '', // de zender die speelt, als dat via het netwerk is
}

/** Wat de app zelf het laatst startte, om de zender te kunnen noemen. */
let lastPlayed = null // { id, name, viaUrl }

/** Tot wanneer de status van de receiver een waarde niet mag overschrijven. */
const hold = { power: 0, input: 0, volume: 0, mute: 0 }
const holdFor = (key, ms) => (hold[key] = Date.now() + ms)

const controllable = () => state.reachable === true && state.power === true

/* ─── Praten met de receiver ──────────────────────────────────────────────── */

// /denon/<ip>/... wordt in de Android-app door MainActivity doorgegeven, en op
// de pc door tools/dev-server.mjs. De browser zelf mag de receiver niet bereiken.
async function request(path, host = settings.host) {
  const res = await fetch(`/denon/${host}/${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

// Commando's één voor één: de receiver verwerkt ze niet tegelijk.
let chain = Promise.resolve(true)

/** Stuurt een commando; geeft true als de receiver het heeft aangenomen. */
function send(cmd) {
  const run = chain.then(() =>
    request(commandPath(cmd)).then(
      () => true,
      () => {
        showToast('De receiver reageert niet')
        return false
      },
    ),
  )
  chain = run
  return run
}

let pollTimer = 0
let polling = false
let fullDue = 0
let netDue = 0
let failures = 0

const NETWORK_IDS = ['NETWORK', ...NET_SERVICES.map(s => s.id)]
const onNetwork = () => state.power === true && NETWORK_IDS.includes(inputId(state.input, settings.sources))

function updateStation(screen) {
  const playing = nowPlaying(screen)
  if (!playing) return // in een menu: de vorige zender laten staan
  // Startte de app zelf een favoriet, dan die naam: de receiver laat soms nog de
  // vorige zender staan, en een stream meldt vaak reclame of het nummer als titel.
  const ours = lastPlayed && inputId(state.input, settings.sources) === 'FAVORITES'
  const station = ours ? lastPlayed.name : playing.station
  if (station !== state.station) {
    state.station = station
    render()
  }
}

function schedule(ms) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, ms)
}

/** Kort na een commando opnieuw kijken, met de volledige status. */
function refreshSoon(ms = 400) {
  fullDue = 0
  schedule(ms)
}

async function poll() {
  clearTimeout(pollTimer)
  if (!settings.host || document.hidden) return
  if (polling) return schedule(300)
  polling = true

  // Meestal de kleine statuspagina; elke tien seconden de grote, met de
  // ingangen en de geluidsstand.
  const full = Date.now() >= fullDue
  const host = settings.host
  try {
    const status = parseStatus(await request(full ? STATUS_FULL : STATUS_LITE, host))
    if (host === settings.host) {
      if (full) fullDue = Date.now() + 10_000
      failures = 0
      applyStatus(status)
    }
    // Speelt er iets via het netwerk, dan om de paar seconden de zender erbij.
    if (onNetwork() && Date.now() >= netDue && !nav.busy) {
      netDue = Date.now() + 4000
      updateStation(parseNetScreen(await request(NET_STATUS, host)))
    }
  } catch {
    failures++
    // Eén gemiste keer is nog geen storing, behalve bij het opstarten.
    if (failures >= 2 || state.reachable === null) {
      state.reachable = false
      render()
    }
  } finally {
    polling = false
  }
  schedule(state.reachable === false ? 4000 : 1500)
}

function applyStatus(s) {
  const now = Date.now()
  state.reachable = true
  if ('power' in s && now > hold.power) state.power = s.power
  if ('input' in s && now > hold.input) {
    if (s.input !== state.input) {
      // Andere ingang: de zender van daarnet hoort er niet meer bij.
      state.station = ''
      netDue = 0
      if (inputId(s.input, settings.sources) !== 'FAVORITES') lastPlayed = null
    }
    state.input = s.input
  }
  if ('volume' in s && now > hold.volume && !dial.dragging) state.volume = s.volume
  if ('mute' in s && now > hold.mute) state.mute = s.mute
  if ('soundMode' in s) state.soundMode = s.soundMode
  if (s.sources && s.sources.length && JSON.stringify(s.sources) !== JSON.stringify(settings.sources)) {
    settings.sources = s.sources
    save()
  }
  render()
}

/* ─── Volume ──────────────────────────────────────────────────────────────── */

let volumeTarget = null
let volumeBusy = false

/**
 * Zet het volume. Nooit hoger dan het maximum uit de instellingen, maar ook
 * nooit vanzelf omlaag: staat de receiver al harder (met de gewone
 * afstandsbediening), dan blijft dat zo tot je zelf zachter zet.
 */
function setVolume(v) {
  const current = state.volume ?? 0
  const limit = Math.max(settings.maxVolume, Math.min(current, VOLUME_MAX))
  let next = clampVolume(v, limit)
  if (next > current && next > settings.maxVolume) next = current
  holdFor('volume', 1500)
  if (next === state.volume) return
  state.volume = next
  render()
  volumeTarget = next
  pumpVolume()
}

// Tijdens draaien komen er veel meer waarden dan de receiver bijhoudt. Alleen
// de laatste telt; tussenliggende waarden vervallen.
async function pumpVolume() {
  if (volumeBusy) return
  volumeBusy = true
  while (volumeTarget !== null) {
    const v = volumeTarget
    volumeTarget = null
    await send(volumeCommand(v))
    holdFor('volume', 1200)
  }
  volumeBusy = false
  refreshSoon(1300)
}

function stepVolume(delta) {
  if (!controllable()) return
  const current = state.volume ?? 0
  if (delta > 0 && current >= settings.maxVolume) {
    showToast(`Het maximum is ${formatVolume(settings.maxVolume)}. Dat pas je aan bij Instellingen.`)
    return
  }
  setVolume(current + delta)
}

/* ─── De draaiknop ────────────────────────────────────────────────────────── */

const C = 120 //       middelpunt van de tekening (viewBox 240 x 240)
const R = 88 //        straal van de ring
const START = 135 //   0 staat links onder; graden met de klok mee vanaf 3 uur
const SWEEP = 270 //   tot rechts onder

const rad = deg => (deg * Math.PI) / 180
const point = (deg, r = R) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))]
const f2 = n => n.toFixed(2)

function arc(from, to) {
  if (to - from < 0.01) return ''
  const [x0, y0] = point(from)
  const [x1, y1] = point(to)
  return `M${f2(x0)} ${f2(y0)}A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${f2(x1)} ${f2(y1)}`
}

const dial = $('dial')
dial.dragging = false

function drawTicks() {
  const svg = 'http://www.w3.org/2000/svg'
  const g = $('ticks')
  g.replaceChildren()
  const max = settings.maxVolume
  for (let t = 0; t <= max; t += 10) {
    const deg = START + (SWEEP * t) / max
    const [x0, y0] = point(deg, R + 13)
    const [x1, y1] = point(deg, R + 19)
    const line = document.createElementNS(svg, 'line')
    line.setAttribute('class', 'dial-tick')
    line.setAttribute('x1', f2(x0))
    line.setAttribute('y1', f2(y0))
    line.setAttribute('x2', f2(x1))
    line.setAttribute('y2', f2(y1))
    g.append(line)
  }
  // Alleen de uiteinden krijgen een getal: 0 en het maximum.
  for (const t of [0, max]) {
    const [x, y] = point(START + (SWEEP * t) / max, R + 29)
    const label = document.createElementNS(svg, 'text')
    label.setAttribute('class', 'dial-tick-label')
    label.setAttribute('x', f2(x))
    label.setAttribute('y', f2(y))
    label.textContent = formatVolume(t)
    g.append(label)
  }
  $('track').setAttribute('d', arc(START, START + SWEEP))
}

function drawLevel(v) {
  const f = v === null ? 0 : Math.min(1, v / settings.maxVolume)
  $('level').setAttribute('d', arc(START, START + SWEEP * f))
  const handle = $('handle')
  const [x, y] = point(START + SWEEP * f)
  handle.setAttribute('cx', f2(x))
  handle.setAttribute('cy', f2(y))
  handle.style.display = v === null ? 'none' : ''
}

// Draaien gaat relatief: waar je de knop pakt maakt niet uit, alleen hoeveel je
// draait. Een tik op de ring laat het volume dus nooit verspringen.
{
  let lastAngle = 0
  let value = 0

  const geometry = e => {
    const r = dial.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    return { angle: (Math.atan2(dy, dx) * 180) / Math.PI, distance: Math.hypot(dx, dy) / r.width }
  }

  dial.addEventListener('pointerdown', e => {
    if (!controllable() || e.button !== 0) return
    dial.dragging = true
    dial.setPointerCapture(e.pointerId)
    lastAngle = geometry(e).angle
    value = state.volume ?? 0
  })

  dial.addEventListener('pointermove', e => {
    if (!dial.dragging) return
    const { angle, distance } = geometry(e)
    let delta = angle - lastAngle
    if (delta > 180) delta -= 360
    if (delta < -180) delta += 360
    lastAngle = angle
    // Vlak bij het midden zwiept de hoek bij elke kleine beweging rond.
    if (distance < 0.12) return
    const top = Math.max(settings.maxVolume, state.volume ?? 0)
    value = Math.min(top, Math.max(0, value + (delta / SWEEP) * settings.maxVolume))
    setVolume(value)
  })

  const stop = () => {
    if (!dial.dragging) return
    dial.dragging = false
    holdFor('volume', 1500)
  }
  dial.addEventListener('pointerup', stop)
  dial.addEventListener('pointercancel', stop)

  dial.addEventListener('keydown', e => {
    const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 5, PageDown: -5 }[e.key]
    if (step === undefined || !controllable()) return
    e.preventDefault()
    stepVolume(step)
  })
}

/* ─── De cijfers in het display ───────────────────────────────────────────── */

// Zeven segmenten per cijfer, zoals op een fluorescentiedisplay. De segmenten
// die uit staan zijn vaag zichtbaar; dat hoort bij zo'n display.
const SEGMENTS = (() => {
  const t = 9 // dikte
  const g = 1.5 // ruimte tussen twee segmenten
  const x0 = 5.5, x1 = 50.5, y0 = 5.5, y1 = 50, y2 = 94.5
  const h = (x, y, len) =>
    `${x},${y} ${x + t / 2},${y - t / 2} ${x + len - t / 2},${y - t / 2} ${x + len},${y} ${x + len - t / 2},${y + t / 2} ${x + t / 2},${y + t / 2}`
  const v = (x, y, len) =>
    `${x},${y} ${x + t / 2},${y + t / 2} ${x + t / 2},${y + len - t / 2} ${x},${y + len} ${x - t / 2},${y + len - t / 2} ${x - t / 2},${y + t / 2}`
  const across = x1 - x0 - 2 * g
  return {
    a: h(x0 + g, y0, across),
    b: v(x1, y0 + g, y1 - y0 - 2 * g),
    c: v(x1, y1 + g, y2 - y1 - 2 * g),
    d: h(x0 + g, y2, across),
    e: v(x0, y1 + g, y2 - y1 - 2 * g),
    f: v(x0, y0 + g, y1 - y0 - 2 * g),
    g: h(x0 + g, y1, across),
  }
})()

const GLYPHS = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg',
  6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '',
}

// Twee cijfers, de punt en het halve cijfer erachter: "25.5".
const CELLS = [0, 64, 138]

function buildDigits() {
  const parts = CELLS.map(
    (x, i) =>
      `<g transform="translate(${x} 0)">` +
      Object.entries(SEGMENTS)
        .map(([s, pts]) => `<polygon class="seg" data-cell="${i}" data-seg="${s}" points="${pts}"/>`)
        .join('') +
      '</g>',
  )
  $('digits').innerHTML =
    `<svg viewBox="0 -1 194 102">${parts.join('')}` +
    '<circle class="seg" id="dp" cx="126" cy="94.5" r="5.5"/></svg>'
}

function drawDigits(chars, point = false, dim = false) {
  const box = $('digits')
  box.classList.toggle('is-dim', dim)
  for (const el of box.querySelectorAll('polygon')) {
    const lit = GLYPHS[chars[el.dataset.cell]] ?? ''
    el.classList.toggle('on', lit.includes(el.dataset.seg))
  }
  $('dp').classList.toggle('on', point)
}

/* ─── Tekenen ─────────────────────────────────────────────────────────────── */

function render() {
  const ok = state.reachable === true
  const on = ok && state.power === true
  const can = controllable()

  $('name').textContent = settings.name || 'Receiver'
  $('state').textContent = !settings.host
    ? 'Nog geen receiver gekozen'
    : state.reachable === null
      ? 'Verbinden…'
      : !ok
        ? 'Geen verbinding'
        : on
          ? 'Aan'
          : 'Stand-by'

  const power = $('power')
  power.setAttribute('aria-pressed', String(on))
  power.setAttribute('aria-label', on ? 'Uitzetten' : 'Aanzetten')
  power.disabled = !ok

  // Draaiknop en display
  const v = can ? state.volume : null
  dial.setAttribute('aria-disabled', String(!can))
  dial.setAttribute('aria-valuemax', String(settings.maxVolume))
  dial.setAttribute('aria-valuenow', String(v ?? 0))
  dial.setAttribute('aria-valuetext', v === null ? 'niet beschikbaar' : formatVolume(v) + (state.mute ? ', geluid uit' : ''))
  dial.classList.toggle('is-muted', can && state.mute)
  drawLevel(v)

  $('source-line').textContent = !settings.host
    ? ''
    : state.reachable === null
      ? 'Verbinden'
      : !ok
        ? 'Geen verbinding'
        : !on
          ? 'Stand-by'
          : inputLabel()

  if (v !== null) {
    const whole = String(Math.floor(v)).padStart(2, ' ')
    drawDigits([whole[0], whole[1], v % 1 ? '5' : ' '], v % 1 !== 0, state.mute)
  } else {
    drawDigits(ok || state.reachable === null ? [' ', ' ', ' '] : ['-', '-', ' '])
  }

  const dbLine = $('db-line')
  dbLine.textContent = v === null ? '' : state.mute ? 'Geluid uit' : formatDb(v)
  dbLine.classList.toggle('is-amber', can && state.mute)

  $('vol-down').disabled = !can
  $('vol-up').disabled = !can
  const mute = $('mute')
  mute.disabled = !can
  mute.setAttribute('aria-pressed', String(can && state.mute))
  mute.setAttribute('aria-label', state.mute ? 'Geluid weer aan' : 'Geluid uit')

  renderNotice(ok, on)
  renderSources(can)
  renderModes(can, ok)
}

/**
 * Wat er in het display boven het volume staat. Meldt de receiver een dienst
 * ("Internet Radio"), dan die; meldt hij een kale code ("NET", "TV AUDIO"), dan
 * de naam op de knop, want die herken je.
 */
function inputLabel() {
  if (state.station && onNetwork()) return state.station
  const reported = state.input ?? ''
  const id = inputId(reported, settings.sources)
  const src = settings.sources.find(s => s.id === id)
  return src && reported === reported.toUpperCase() ? src.name : reported
}

function renderNotice(ok, on) {
  const notice = $('notice')
  if (settings.host && state.reachable === false) {
    $('notice-text').textContent = 'Geen verbinding met de receiver'
    $('notice-hint').textContent =
      `Zit je telefoon op de wifi thuis? De app zoekt hem op ${settings.host}. ` +
      'Staat de receiver op stand-by, dan moet op de receiver Netwerkbeheer aan staan.'
    $('notice-btn').textContent = 'Opnieuw zoeken'
    notice.dataset.action = 'search'
    notice.hidden = false
  } else if (ok && !on) {
    $('notice-text').textContent = 'De receiver staat op stand-by'
    $('notice-hint').textContent = ''
    $('notice-btn').textContent = 'Aanzetten'
    notice.dataset.action = 'power'
    notice.hidden = false
  } else {
    notice.hidden = true
  }
}

/**
 * De knoppen onder het volume: de ingangen van de receiver, met direct na de
 * netwerkingang Internet Radio en Spotify. Wat je in de instellingen uitzette,
 * staat er niet tussen. Favorieten heeft een eigen, brede knop.
 */
function sourceButtons() {
  const out = []
  for (const src of settings.sources) {
    out.push({ id: src.id, name: src.name, run: () => chooseSource(src) })
    if (src.id === 'NETWORK') {
      out.push({ id: 'IRADIO', name: 'Internet Radio', run: playInternetRadio })
      out.push({ id: 'SPOTIFY', name: 'Spotify', run: openSpotify })
    }
  }
  return out
}

const hasNetwork = () => settings.sources.some(s => s.id === 'NETWORK')

let sourcesKey = ''

function renderSources(can) {
  const box = $('sources')
  const buttons = sourceButtons().filter(b => !settings.hidden.includes(b.id))
  const key = JSON.stringify(buttons.map(b => [b.id, b.name]))
  if (key !== sourcesKey) {
    sourcesKey = key
    box.replaceChildren(
      ...buttons.map(model => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'source'
        b.textContent = model.name
        b.dataset.id = model.id
        b.addEventListener('click', () => {
          if (controllable() && !nav.busy) model.run()
        })
        return b
      }),
    )
    // Vier knoppen staan beter als twee rijen van twee dan als drie en één.
    box.classList.toggle('cols-2', buttons.length === 2 || buttons.length === 4)
  }
  const active = can ? inputId(state.input, settings.sources) : null
  for (const b of box.children) {
    b.setAttribute('aria-pressed', String(b.dataset.id === active))
    b.setAttribute('aria-busy', String(nav.busy === b.dataset.id))
    b.disabled = !can
  }

  const fav = $('fav-open')
  fav.hidden = !hasNetwork()
  fav.disabled = !can
  fav.setAttribute('aria-pressed', String(active === 'FAVORITES'))
  fav.setAttribute('aria-busy', String(nav.busy === 'FAVORITES'))
  const count = visibleFavorites().length
  $('fav-open-sub').textContent =
    active === 'FAVORITES' && state.station ? state.station : count ? `${count} zenders` : 'Je zenders van de receiver'
}

function chooseSource(src) {
  state.input = src.name
  holdFor('input', 3000)
  render()
  send(src.cmd).then(() => refreshSoon(800))
}

/* ─── Het netwerkmenu van de receiver ─────────────────────────────────────── */

// Favorieten en internetradio lopen via het menu dat de receiver op de tv
// toont: een knop indrukken, wachten tot het scherm verandert, de volgende. Zie
// denon.js. Een knop die te snel na de vorige komt, laat de receiver soms
// liggen; daarom wacht de app steeds tot het scherm echt veranderd is, en drukt
// hij nog eens als dat niet gebeurt.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Welke actie er loopt (de id van de knop), of false. */
const nav = { busy: false }

class NavError extends Error {}

async function netScreen() {
  return parseNetScreen(await request(NET_STATUS))
}

/**
 * Drukt een knop van het netwerkmenu en geeft het nieuwe scherm. `optional`:
 * als er niets verandert, is dat het antwoord (bijvoorbeeld bladeren voorbij de
 * laatste pagina); dan komt er null terug in plaats van een fout.
 *
 * Let op: de regel met de plek ([ 17/27 ]) loopt een stap achter op de cursor.
 * Het scherm dat hier terugkomt heeft dus nog de oude plek; wie de plek nodig
 * heeft, houdt hem zelf bij of wacht op settled().
 */
async function press(cmd, { optional = false } = {}) {
  const before = screenKey(await netScreen())
  // Net na het openen van een menu dat van internet komt (Internet Radio) negeert
  // de receiver knoppen een paar seconden. Daarom geduld, en een paar pogingen.
  for (let attempt = 0; attempt < (optional ? 2 : 4); attempt++) {
    await request(commandPath(cmd))
    const until = Date.now() + (optional ? 2000 : 3000)
    while (Date.now() < until) {
      await sleep(200)
      const after = await netScreen()
      if (screenKey(after) !== before) {
        await sleep(250)
        return after
      }
    }
  }
  if (optional) return null
  throw new NavError('De receiver reageert niet op het menu.')
}

/**
 * Wacht tot het scherm tot rust is gekomen, ook de plekaanduiding: minstens
 * een seconde, en twee keer achter elkaar hetzelfde.
 */
async function settled() {
  const start = Date.now()
  let prev = null
  for (let i = 0; i < 15; i++) {
    await sleep(300)
    const s = await netScreen()
    const same = prev && screenKey(s) === screenKey(prev) && s.index === prev.index
    if (same && Date.now() - start >= 1000) return s
    prev = s
  }
  return prev
}

/** Zet de cursor op een regel van de huidige pagina (1 tot en met 7). */
async function cursorTo(screen, line) {
  let s = screen
  for (let i = 0; i < 8 && s.cursor !== null && s.cursor !== line; i++) {
    s = await press(s.cursor < line ? NAV.down : NAV.up)
  }
  if (s.cursor !== line) throw new NavError('De cursor van de receiver staat niet waar hij moet staan.')
  return s
}

/**
 * Geeft een scherm met een betrouwbare plek. De receiver werkt de plek alleen
 * bij na een cursorstap, en pas even later; dus een stap omlaag (of omhoog, als
 * dat op de laatste plek niets doet), en dan wachten tot alles stilstaat.
 */
async function freshList() {
  if (!(await press(NAV.down, { optional: true }))) await press(NAV.up)
  const s = await settled()
  if (s.cursor === null || s.index === null || !s.total) {
    throw new NavError('De lijst op de receiver geeft niet aan waar de cursor staat.')
  }
  return s
}

// Cursorstappen gaan in een reeks, met deze tussenpoos. Sneller laat de
// receiver er soms een liggen, vooral waar de lijst rond gaat; daarom meet de
// app na elke reeks waar de cursor staat en stuurt hij zo nodig nog een reeks.
const STEP_MS = 300

async function steps(cmds) {
  for (const cmd of cmds) {
    await request(commandPath(cmd))
    await sleep(STEP_MS)
  }
  return settled()
}

/**
 * Brengt de cursor naar plek `target` in de lijst, langs de kortste kant, en
 * controleert de plek en (als die bekend is) de naam op de cursorregel.
 */
async function moveTo(screen, target, name) {
  let s = screen
  for (let round = 0; round < 6; round++) {
    const atName = s.cursor !== null ? s.items[s.cursor - 1] : null
    if (s.index === target) {
      if (name === undefined || atName === name) return s
      throw new NavError('De favorieten op de receiver zijn veranderd. Haal ze opnieuw op bij Aanpassen.')
    }
    s = await steps(planMove(s.index, target, s.total))
    if (s.index === null || s.cursor === null) break
  }
  throw new NavError('De cursor van de receiver staat niet waar hij moet staan.')
}

/** Zet de receiver aan en op de netwerkingang, als dat nog niet zo is. */
async function ensureNetwork() {
  if (!state.power) {
    await send('ZMON')
    state.power = true
    holdFor('power', 20_000)
    render()
    await sleep(5000)
  }
  if (!onNetwork()) {
    await request(commandPath('SINET'))
    await sleep(2500)
  }
}

/**
 * Loopt door het netwerkmenu tot `done(scherm)` klopt. In het bovenste menu van
 * Online Music ("Favorites", "Internet Radio") kiest hij de regel die bij `top`
 * past; `inner(scherm)` mag een tussenmenu afhandelen en geeft dan true. Verder
 * gaat hij steeds een menu terug, tot hij boven is.
 */
async function walk(done, top, inner = async () => false) {
  await ensureNetwork()
  for (let i = 0; i < 10; i++) {
    const s = await netScreen()
    if (s.cursor !== null && done(s)) return s
    if (s.cursor !== null && s.service === 'NET') {
      const line = s.items.findIndex(t => top.test(t)) + 1
      if (!line) throw new NavError('Dat staat niet in het menu van de receiver.')
      await cursorTo(s, line)
      await press(NAV.enter)
      // Een menu openen haalt soms iets van internet; zo lang negeert de receiver knoppen.
      await settled()
      continue
    }
    if (s.cursor !== null && (await inner(s))) {
      await settled()
      continue
    }
    // Terug doet niets bij een stream via een eigen adres; dan opnieuw de netwerkingang kiezen.
    if (!(await press(NAV.back, { optional: true }))) {
      await request(commandPath('SINET'))
      await sleep(2500)
    }
  }
  throw new NavError('De receiver komt niet in het goede menu.')
}

/** Opent het favorietenmenu van de receiver; geeft het scherm met een verse plek. */
async function openFavoritesMenu() {
  await walk(s => s.service === 'FAVORITES', /favou?rit/i)
  return freshList()
}

/**
 * Leest alle favorieten van de receiver. Het scherm toont zeven regels; de app
 * schuift telkens vijf plekken door de ronde lijst, zodat elke keer een stukje
 * overlapt, en leest na elke reeks de plek af. Tot elke plek een naam heeft.
 */
async function readReceiverFavorites(progress) {
  let s = await openFavoritesMenu()
  const total = s.total
  const found = new Map()
  for (let round = 0; round < Math.ceil(total / 5) + 6 && found.size < total; round++) {
    for (const { index, name } of visibleEntries(s, wrap(s.index - s.cursor + 1, total))) {
      if (found.has(index) && found.get(index) !== name) {
        throw new NavError('De lijst op de receiver veranderde tijdens het lezen. Probeer het opnieuw.')
      }
      found.set(index, name)
    }
    progress(`${found.size} van de ${total} gelezen…`)
    if (found.size < total) s = await steps(Array(5).fill(NAV.down))
    if (s.total !== total || s.index === null) {
      throw new NavError('De lijst op de receiver veranderde tijdens het lezen. Probeer het opnieuw.')
    }
  }
  if (found.size < total) throw new NavError('De favorieten konden niet allemaal gelezen worden.')
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([index, name]) => ({ index, total, name }))
}

async function playFromReceiverMenu(fav) {
  let s = await openFavoritesMenu()
  if (s.total !== fav.receiver.total) {
    throw new NavError('De favorieten op de receiver zijn veranderd. Haal ze opnieuw op bij Aanpassen.')
  }
  s = await moveTo(s, fav.receiver.index, fav.receiver.name).catch(() => null)
  if (!s || s.items[s.cursor - 1] !== fav.receiver.name) {
    throw new NavError('De favorieten op de receiver zijn veranderd. Haal ze opnieuw op bij Aanpassen.')
  }
  await press(NAV.enter)
  await expectPlaying(fav.name)
}

/**
 * Wacht tot de receiver "Now Playing" laat zien. Of het echt de gekozen zender
 * is, valt niet te zien: de regel met de zendernaam werkt de receiver niet
 * altijd bij (gemeten: na een zender uit Recently Played bleef de oude naam
 * staan terwijl de nieuwe speelde).
 */
async function expectPlaying(name) {
  for (let i = 0; i < 14; i++) {
    await sleep(700)
    if (nowPlaying(await netScreen())) return
  }
  throw new NavError(`${name} start niet. Is het adres van de zender veranderd? Geef hem een eigen adres bij Aanpassen.`)
}

async function playFromUrl(fav) {
  if (!state.power) {
    await send('ZMON')
    await sleep(5000)
  }
  const res = await fetch(`/denon/${settings.host}/${playUrlPath(fav.url, fav.name)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const reason = (await res.text()) || 'De receiver weigert het adres'
    throw new NavError(`${fav.name} speelt niet. ${reason}.`)
  }
}

/** Voert een actie op het menu uit, één tegelijk, met een lampje dat knippert. */
async function runNav(id, label, action) {
  if (nav.busy) return false
  nav.busy = id
  render()
  showToast(label)
  try {
    await action()
    return true
  } catch (err) {
    showToast(err instanceof NavError ? err.message : 'De receiver reageert niet')
    return false
  } finally {
    nav.busy = false
    refreshSoon(500)
  }
}

/* ─── Internet Radio en Spotify ───────────────────────────────────────────── */

// Alleen de ingang Internet Radio kiezen zet de receiver op een leeg "Now
// Playing". Daarom start de app de bovenste zender uit "Recently Played": de
// laatste die speelde.
function playInternetRadio() {
  return runNav('IRADIO', 'Internet Radio starten…', async () => {
    const recent = t => /recent/i.test(t)
    await walk(s => s.service === 'IRADIO' && recent(s.title), /internet radio/i, async s => {
      const line = s.service === 'IRADIO' ? s.items.findIndex(recent) + 1 : 0
      if (!line) return false
      await cursorTo(s, line)
      await press(NAV.enter)
      return true
    })
    await moveTo(await freshList(), 1)
    await press(NAV.enter)
    await expectPlaying('Internet Radio')
  }).then(ok => ok && showToast('Internet Radio speelt'))
}

// Spotify Connect: in de Spotify-app kies je de receiver als luidspreker, en de
// receiver schakelt dan zelf om. Vanuit deze app valt Spotify niet te starten.
function openSpotify() {
  showToast('Kies in Spotify de receiver als luidspreker')
  location.href = 'spotify:'
}

/* ─── Favorieten ──────────────────────────────────────────────────────────── */

const favSheet = $('favorites')
let favEditing = false
let favForm = null // { id } bij aanpassen, { id: null } bij toevoegen
let favPending = null // de favoriet die nu gestart wordt

const visibleFavorites = () => settings.favorites.filter(f => !f.hidden)

function openFavorites() {
  favEditing = false
  favForm = null
  $('fav-status').textContent = ''
  renderFavorites()
  if (!favSheet.open) favSheet.showModal()
  if (!settings.favorites.length) importFavorites()
}

function favText(fav) {
  const text = document.createElement('span')
  text.className = 'fav-text'
  const name = document.createElement('span')
  name.className = 'fav-name'
  name.textContent = fav.name
  text.append(name)
  if (fav.url) {
    const note = document.createElement('span')
    note.className = 'fav-note'
    note.textContent = 'Eigen adres'
    text.append(note)
  }
  return text
}

function renderFavorites() {
  const edit = $('fav-edit')
  edit.setAttribute('aria-pressed', String(favEditing))
  edit.textContent = favEditing ? 'Klaar' : 'Aanpassen'
  $('fav-tools').hidden = !favEditing || favForm !== null
  $('fav-form').hidden = favForm === null
  $('fav-close').hidden = favEditing

  const shown = favEditing ? settings.favorites : visibleFavorites()
  const playingId = inputId(state.input, settings.sources) === 'FAVORITES' ? lastPlayed?.id : null
  $('fav-list').replaceChildren(
    ...shown.map((fav, i) => {
      const li = document.createElement('li')
      if (!favEditing) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'fav'
        b.append(...favText(fav).childNodes)
        b.setAttribute('aria-current', String(fav.id === playingId))
        b.setAttribute('aria-busy', String(favPending === fav.id))
        b.disabled = Boolean(nav.busy)
        b.addEventListener('click', () => playFavorite(fav))
        li.append(b)
        return li
      }
      li.className = 'fav-row' + (fav.hidden ? ' is-hidden' : '')
      li.append(
        favText(fav),
        mini('up', `${fav.name} omhoog`, i === 0, () => moveFav(fav.id, -1)),
        mini('down', `${fav.name} omlaag`, i === shown.length - 1, () => moveFav(fav.id, 1)),
        mini('edit', `${fav.name} aanpassen`, false, () => editFavorite(fav.id)),
        mini(fav.hidden ? 'show' : 'hide', fav.hidden ? `${fav.name} weer tonen` : `${fav.name} verbergen`, false,
          () => toggleHidden(fav.id)),
      )
      return li
    }),
  )
}

const ICONS = {
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  hide: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/><path d="m4 4 16 16"/>',
  show: '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/>',
}

function mini(icon, label, disabled, onClick) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'mini'
  b.setAttribute('aria-label', label)
  b.disabled = disabled
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`
  b.addEventListener('click', onClick)
  return b
}

function saveFavorites(list) {
  settings.favorites = list
  save()
  renderFavorites()
  render()
}

function moveFav(id, delta) {
  saveFavorites(moveFavorite(settings.favorites, id, delta))
}

function toggleHidden(id) {
  saveFavorites(settings.favorites.map(f => (f.id === id ? { ...f, hidden: !f.hidden } : f)))
}

async function playFavorite(fav) {
  if (state.reachable !== true || nav.busy) return
  favPending = fav.id
  renderFavorites()
  const ok = await runNav('FAVORITES', `${fav.name} starten…`, () =>
    fav.url ? playFromUrl(fav) : playFromReceiverMenu(fav))
  favPending = null
  if (ok) {
    lastPlayed = { id: fav.id, name: fav.name, viaUrl: Boolean(fav.url) }
    state.station = fav.name
    netDue = Date.now() + 3000
    showToast(`${fav.name} speelt`)
    if (favSheet.open) favSheet.close()
  }
  renderFavorites()
  render()
}

async function importFavorites() {
  const status = $('fav-status')
  $('fav-import').disabled = true
  status.textContent = 'Favorieten ophalen van de receiver…'
  const ok = await runNav('FAVORITES', 'Favorieten ophalen…', async () => {
    const found = await readReceiverFavorites(text => (status.textContent = text))
    saveFavorites(mergeFavorites(settings.favorites, found))
    status.textContent = `${found.length} favorieten op de receiver.`
  })
  if (!ok) status.textContent = 'Ophalen lukte niet. Probeer het opnieuw bij Aanpassen.'
  $('fav-import').disabled = false
  renderFavorites()
}

function editFavorite(id) {
  const fav = id ? settings.favorites.find(f => f.id === id) : null
  favForm = { id }
  $('fav-form-title').textContent = fav ? 'Zender aanpassen' : 'Zender toevoegen'
  $('fav-name').value = fav?.name ?? ''
  $('fav-url').value = fav?.url ?? ''
  $('fav-url-hint').textContent = fav?.receiver
    ? 'Leeg laten: de receiver speelt de zender uit zijn eigen favorieten. Met een adres speelt hij dat ' +
      'adres, handig als de zender een nieuw adres heeft.'
    : 'Het adres van de stream, beginnend met http://. Https speelt de receiver niet.'
  $('fav-error').textContent = ''
  $('fav-delete').hidden = !fav || Boolean(fav.receiver)
  renderFavorites()
  $('fav-name').focus()
}

$('fav-form').addEventListener('submit', e => {
  e.preventDefault()
  const name = $('fav-name').value.trim()
  const url = $('fav-url').value.trim()
  const current = favForm?.id ? settings.favorites.find(f => f.id === favForm.id) : null
  const needsUrl = !current?.receiver
  const problem = !name ? 'Geef de zender een naam.' : url || needsUrl ? streamUrlProblem(url) : null
  if (problem) {
    $('fav-error').textContent = problem
    return
  }
  const list = current
    ? settings.favorites.map(f => {
      if (f.id !== current.id) return f
      const { url: _old, ...rest } = f
      return url ? { ...rest, name, url } : { ...rest, name }
    })
    : [...settings.favorites, { id: newFavoriteId(), name, url }]
  favForm = null
  saveFavorites(list)
})

$('fav-cancel').addEventListener('click', () => {
  favForm = null
  renderFavorites()
})

$('fav-delete').addEventListener('click', () => {
  const id = favForm?.id
  favForm = null
  saveFavorites(settings.favorites.filter(f => f.id !== id))
})

$('fav-edit').addEventListener('click', () => {
  favEditing = !favEditing
  favForm = null
  renderFavorites()
})

$('fav-add').addEventListener('click', () => editFavorite(null))
$('fav-import').addEventListener('click', importFavorites)
$('fav-close').addEventListener('click', () => favSheet.close())
$('fav-open').addEventListener('click', () => {
  if (controllable() && !nav.busy) openFavorites()
})

/* ─── Geluidsstand ────────────────────────────────────────────────────────── */

// Film, muziek en game zijn groepen: de receiver meldt daarna de stand binnen
// die groep ("DOLBY DIGITAL"), niet de groep. Daarom onthoudt de app welke knop
// je net koos, zolang de receiver op de stand blijft waar die knop hem heen zette.
let chosen = null // { id, from, to, at }

function activeModeId() {
  const sure = soundModeId(state.soundMode)
  if (!chosen) return sure
  if (chosen.to === undefined && state.soundMode !== chosen.from) chosen.to = state.soundMode
  if (chosen.to === undefined) return Date.now() - chosen.at < 4000 ? chosen.id : sure
  if (state.soundMode === chosen.to) return sure ?? chosen.id
  chosen = null
  return sure
}

function buildModes() {
  $('modes').replaceChildren(
    ...SOUND_MODES.map(mode => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mode'
      b.dataset.id = mode.id
      const label = document.createElement('span')
      label.className = 'mode-label'
      label.textContent = mode.label
      const hint = document.createElement('span')
      hint.className = 'mode-hint'
      hint.textContent = mode.hint
      b.append(label, hint)
      b.addEventListener('click', () => chooseMode(mode))
      return b
    }),
  )
}

function renderModes(can, ok) {
  $('mode-now').textContent = can ? state.soundMode || '--' : !ok ? 'Geen verbinding' : 'Stand-by'
  const active = can ? activeModeId() : null
  for (const b of $('modes').children) {
    b.setAttribute('aria-pressed', String(b.dataset.id === active))
    b.disabled = !can
  }
}

function chooseMode(mode) {
  if (!controllable()) return
  chosen = { id: mode.id, from: state.soundMode, at: Date.now() }
  render()
  send(mode.cmd).then(() => refreshSoon(900))
}

/* ─── Knoppen ─────────────────────────────────────────────────────────────── */

/** Tik is één stap; ingedrukt houden herhaalt. */
function repeatButton(btn, step) {
  let timer = 0
  let fromPointer = false
  const stop = () => clearTimeout(timer)
  btn.addEventListener('pointerdown', e => {
    if (btn.disabled || e.button !== 0) return
    fromPointer = true
    step()
    const again = delay => {
      timer = setTimeout(() => {
        step()
        again(160)
      }, delay)
    }
    again(450)
  })
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(type, stop)
  // Een klik die niet van een vinger of muis komt (Enter, spatie, schermlezer).
  btn.addEventListener('click', () => {
    if (fromPointer) fromPointer = false
    else step()
  })
}

repeatButton($('vol-up'), () => stepVolume(1))
repeatButton($('vol-down'), () => stepVolume(-1))

$('mute').addEventListener('click', () => {
  if (!controllable()) return
  state.mute = !state.mute
  holdFor('mute', 2500)
  render()
  send(state.mute ? 'MUON' : 'MUOFF').then(() => refreshSoon())
})

function togglePower() {
  if (state.reachable !== true) return
  const on = !state.power
  state.power = on
  // Na aan- of uitzetten meldt de statuspagina nog tot zo'n twintig seconden de
  // oude stand (gemeten); zo lang geldt wat je zelf koos.
  holdFor('power', 20_000)
  render()
  send(on ? 'ZMON' : 'ZMOFF').then(() => refreshSoon(2000))
}

$('power').addEventListener('click', togglePower)

$('notice-btn').addEventListener('click', () => {
  if ($('notice').dataset.action === 'power') togglePower()
  else openSettings({ search: true })
})

/* ─── Tabbladen ───────────────────────────────────────────────────────────── */

const TABS = [
  ['tabbtn-control', 'tab-control'],
  ['tabbtn-sound', 'tab-sound'],
]

function selectTab(index, focus = false) {
  TABS.forEach(([btn, panel], i) => {
    $(btn).setAttribute('aria-selected', String(i === index))
    $(btn).tabIndex = i === index ? 0 : -1
    $(panel).hidden = i !== index
  })
  if (focus) $(TABS[index][0]).focus()
  if (index === 1) refreshSoon(0)
}

TABS.forEach(([btn], i) => {
  $(btn).addEventListener('click', () => selectTab(i))
  $(btn).addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      selectTab((i + 1) % TABS.length, true)
    }
  })
})

/* ─── Melding onderin ─────────────────────────────────────────────────────── */

let toastTimer = 0

function showToast(text) {
  const toast = $('toast')
  toast.textContent = text
  toast.classList.add('is-shown')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('is-shown'), 2800)
}

/* ─── Instellingen ────────────────────────────────────────────────────────── */

const sheet = $('settings')

function renderCurrent() {
  $('current-receiver').textContent = settings.host
    ? `${settings.name || 'Receiver'} op ${settings.host}`
    : 'Nog geen receiver gekozen. Zoek hem op het netwerk, of vul zijn IP-adres in.'
  $('done-btn').hidden = !settings.host
}

function openSettings({ search = false } = {}) {
  renderCurrent()
  $('host-input').value = settings.host
  $('host-input').removeAttribute('aria-invalid')
  $('max-input').value = String(settings.maxVolume)
  $('max-value').value = String(settings.maxVolume)
  $('found').replaceChildren()
  $('search-status').textContent = ''
  renderChoices()
  if (!sheet.open) sheet.showModal()
  if (search) runSearch()
}

/** Een vinkje per knop: welke ingangen en diensten op het scherm staan. */
function renderChoices() {
  const box = $('button-choices')
  const buttons = sourceButtons()
  box.closest('.sheet-section').hidden = !buttons.length
  box.replaceChildren(
    ...buttons.map(b => {
      const label = document.createElement('label')
      label.className = 'choice'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = !settings.hidden.includes(b.id)
      input.addEventListener('change', () => {
        settings.hidden = input.checked
          ? settings.hidden.filter(id => id !== b.id)
          : [...settings.hidden, b.id]
        save()
        render()
      })
      label.append(input, b.name)
      return label
    }),
  )
}

// Zonder receiver valt er niets te bedienen; dan blijft dit vel open.
sheet.addEventListener('cancel', e => {
  if (!settings.host) e.preventDefault()
})

$('settings-btn').addEventListener('click', () => openSettings())

function useReceiver(host, name) {
  const changed = host !== settings.host
  settings.host = host
  settings.name = name
  if (changed) {
    // Ingangen en favorieten horen bij één receiver.
    settings.sources = []
    settings.favorites = []
    Object.assign(state, { reachable: null, power: null, input: null, volume: null, mute: false, soundMode: null })
    failures = 0
  }
  save()
  renderCurrent()
  render()
  refreshSoon(0)
  if (sheet.open && !$('done-btn').hidden && changed) sheet.close()
  showToast(`${name || 'Receiver'} gekozen`)
}

let searching = false

async function runSearch() {
  if (searching) return
  searching = true
  const btn = $('search-btn')
  const status = $('search-status')
  const list = $('found')
  btn.disabled = true
  status.textContent = 'Zoeken…'
  list.replaceChildren()

  let found = null
  try {
    const res = await fetch('/denon-discover', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (res.ok) found = await res.json()
  } catch {
    // Dan blijft found null.
  }
  searching = false
  btn.disabled = false

  if (!Array.isArray(found)) {
    status.textContent = 'Zoeken lukte niet. Vul het IP-adres hieronder in.'
    return
  }
  found = found.filter(r => r && isLanAddress(r.host))
  if (found.length === 0) {
    status.textContent =
      'Geen receiver gevonden. Staat hij aan, en zit je telefoon op dezelfde wifi? Vul anders het IP-adres in.'
    return
  }
  // Eén receiver en er was er nog geen: dan hoeft er niets gekozen te worden.
  if (found.length === 1 && !settings.host) {
    status.textContent = ''
    useReceiver(found[0].host, found[0].name)
    return
  }
  status.textContent = found.length === 1 ? 'Gevonden:' : 'Kies je receiver:'
  list.replaceChildren(
    ...found.map(r => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'found-btn'
      b.textContent = r.name || r.model || 'Receiver'
      const small = document.createElement('small')
      small.textContent = r.model && r.model !== r.name ? `${r.model}, ${r.host}` : r.host
      b.append(small)
      b.addEventListener('click', () => useReceiver(r.host, r.name || r.model))
      li.append(b)
      return li
    }),
  )
}

$('search-btn').addEventListener('click', runSearch)

$('host-btn').addEventListener('click', async () => {
  const input = $('host-input')
  const host = input.value.trim().replace(/,/g, '.')
  const status = $('search-status')
  if (!isLanAddress(host)) {
    input.setAttribute('aria-invalid', 'true')
    status.textContent = 'Dat is geen adres op een thuisnetwerk. Het lijkt op 10.0.0.54 of 192.168.1.20.'
    return
  }
  input.removeAttribute('aria-invalid')
  status.textContent = `Kijken op ${host}…`
  try {
    const s = parseStatus(await request(STATUS_MAIN, host))
    status.textContent = ''
    useReceiver(host, s.name || 'Receiver')
  } catch {
    input.setAttribute('aria-invalid', 'true')
    status.textContent = `Op ${host} antwoordt geen receiver.`
  }
})

$('max-input').addEventListener('input', e => {
  settings.maxVolume = Number(e.target.value)
  $('max-value').value = e.target.value
  save()
  drawTicks()
  render()
})

/* ─── Start ───────────────────────────────────────────────────────────────── */

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshSoon(0)
})

buildDigits()
buildModes()
drawTicks()
render()

if (settings.host) poll()
else openSettings({ search: true })
