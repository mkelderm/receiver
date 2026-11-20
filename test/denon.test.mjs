// Tests voor web/denon.js. Draaien met:  node test/denon.test.mjs
//
// status-on.xml en status-lite-on.xml zijn onbewerkt opgehaald van de Denon
// AVR-X1200W thuis (1 november 2026). status-lite-standby.xml is met de hand
// gemaakt: de receiver stond aan, en de stand-bywaarden komen uit het protocol.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseStatus, inputId, soundModeId, volumeFromDb, clampVolume, volumeCommand,
  commandPath, formatVolume, formatDb, isLanAddress, SOUND_MODES,
  parseNetScreen, screenKey, nowPlaying, streamUrlProblem, playUrlPath, mergeFavorites, moveFavorite,
  wrap, visibleEntries, planMove, NAV,
  parseLevels, sideOf, levelCommand, balanceLevels, balanceFrom, formatBalance,
} from '../web/denon.js'

const fixture = name => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')

test('kleine status van een receiver die aan staat', () => {
  assert.deepEqual(parseStatus(fixture('status-lite-on.xml')), {
    power: true,
    input: 'Internet Radio',
    volume: 25.5,
    mute: false,
  })
})

test('kleine status in stand-by', () => {
  assert.deepEqual(parseStatus(fixture('status-lite-standby.xml')), {
    power: false,
    input: 'TV AUDIO',
    volume: 0,
    mute: true,
  })
})

test('volledige status: alleen de ingangen die in gebruik zijn, met hun eigen naam', () => {
  const s = parseStatus(fixture('status-on.xml'))
  assert.equal(s.soundMode, 'Stereo')
  assert.deepEqual(s.sources, [
    { id: 'CBL/SAT', name: 'CBL/SAT', cmd: 'SISAT/CBL' },
    { id: 'GAME', name: 'Game', cmd: 'SIGAME' },
    { id: 'AUX', name: 'AUX', cmd: 'SIAUX1' },
    { id: 'NETWORK', name: 'Online Music', cmd: 'SINET' },
    { id: 'TV AUDIO', name: 'TV Audio', cmd: 'SITV' },
    { id: 'BLUETOOTH', name: 'Bluetooth', cmd: 'SIBT' },
  ])
})

test('huidige ingang herkennen, ook als de receiver een andere naam meldt', () => {
  const { sources } = parseStatus(fixture('status-on.xml'))
  assert.equal(inputId('Online Music', sources), 'NETWORK')
  assert.equal(inputId('TV AUDIO', sources), 'TV AUDIO')
  assert.equal(inputId('TV', sources), 'TV AUDIO')
  assert.equal(inputId('Game', sources), 'GAME')
  assert.equal(inputId('SAT/CBL', sources), 'CBL/SAT')
  assert.equal(inputId('bt', sources), 'BLUETOOTH')
  assert.equal(inputId('Phono', sources), null)
  assert.equal(inputId('', sources), null)
})

test('een hernoemde ingang wordt op zijn nieuwe naam herkend', () => {
  const sources = [{ id: 'GAME', name: 'Streamer', cmd: 'SIGAME' }]
  assert.equal(inputId('Streamer', sources), 'GAME')
})

test('geluidsstand bij een knop', () => {
  assert.equal(soundModeId('Stereo'), 'stereo')
  assert.equal(soundModeId('PURE DIRECT'), 'direct')
  assert.equal(soundModeId('Direct'), 'direct')
  assert.equal(soundModeId('AUTO'), 'auto')
  // Film, muziek en game zijn groepen; de receiver meldt de stand daarbinnen.
  assert.equal(soundModeId('DOLBY DIGITAL'), null)
  assert.equal(soundModeId(null), null)
  assert.equal(new Set(SOUND_MODES.map(m => m.id)).size, SOUND_MODES.length)
})

test('volume in dB naar de schaal van het display', () => {
  assert.equal(volumeFromDb('-54.5'), 25.5)
  assert.equal(volumeFromDb('0.0'), 80)
  assert.equal(volumeFromDb('18.0'), 98)
  assert.equal(volumeFromDb('-80.0'), 0)
  assert.equal(volumeFromDb('--'), 0)
  assert.equal(volumeFromDb('---'), 0)
  assert.equal(volumeFromDb(''), null)
  assert.equal(volumeFromDb('abc'), null)
  assert.equal(volumeFromDb(null), null)
})

test('volume afronden en begrenzen', () => {
  assert.equal(clampVolume(25.3), 25.5)
  assert.equal(clampVolume(25.2), 25)
  assert.equal(clampVolume(-3), 0)
  assert.equal(clampVolume(120), 98)
  assert.equal(clampVolume(75, 70), 70)
})

test('volumecommando', () => {
  assert.equal(volumeCommand(25.5), 'MV255')
  assert.equal(volumeCommand(25), 'MV25')
  assert.equal(volumeCommand(5), 'MV05')
  assert.equal(volumeCommand(5.5), 'MV055')
  assert.equal(volumeCommand(0), 'MV00')
  assert.equal(volumeCommand(98), 'MV98')
  assert.equal(volumeCommand(200), 'MV98')
})

test('commando-adres', () => {
  assert.equal(commandPath('MVUP'), 'goform/formiPhoneAppDirect.xml?MVUP')
  assert.equal(commandPath('SISAT/CBL'), 'goform/formiPhoneAppDirect.xml?SISAT/CBL')
  assert.equal(commandPath('MSPURE DIRECT'), 'goform/formiPhoneAppDirect.xml?MSPURE%20DIRECT')
  assert.throws(() => commandPath('MV25&x=1'))
  assert.throws(() => commandPath('mvup'))
})

test('volume en dB als tekst', () => {
  assert.equal(formatVolume(25.5), '25,5')
  assert.equal(formatVolume(40), '40')
  assert.equal(formatVolume(null), '--')
  assert.equal(formatDb(25.5), '−54,5 dB')
  assert.equal(formatDb(80), '0 dB')
  assert.equal(formatDb(85), '+5 dB')
  assert.equal(formatDb(0), 'stil')
})

test('naam van de receiver uit de hoofdpagina', () => {
  const s = parseStatus(fixture('main-on.xml'))
  assert.equal(s.name, 'Denon AVR-X1200W')
  assert.equal(s.power, true)
})

test('alleen adressen op het thuisnetwerk', () => {
  for (const ok of ['10.0.0.54', '192.168.1.20', '172.16.0.1', '172.31.255.255']) {
    assert.equal(isLanAddress(ok), true, ok)
  }
  for (const bad of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '10.0.0', '10.0.0.256',
    '10.0.0.054', '10.0.0.5a', 'denon.local', '', '10.0.0.1:8080', ' 10.0.0.1']) {
    assert.equal(isLanAddress(bad), false, bad)
  }
})

test('netwerkdiensten krijgen hun eigen knop', () => {
  const { sources } = parseStatus(fixture('status-on.xml'))
  assert.equal(inputId('Internet Radio', sources), 'IRADIO')
  assert.equal(inputId('Spotify', sources), 'SPOTIFY')
  assert.equal(inputId('Favorites', sources), 'FAVORITES')
  assert.equal(inputId('Media Server', sources), 'FAVORITES')
  assert.equal(inputId('NET', sources), 'NETWORK')
  assert.equal(inputId('Online Music', sources), 'NETWORK')
})

test('netwerkmenu: favorietenlijst', () => {
  const s = parseNetScreen(fixture('net-favorites.xml'))
  assert.equal(s.title, 'Favorites')
  assert.equal(s.service, 'FAVORITES')
  assert.equal(s.cursor, 2)
  assert.deepEqual(s.items, [
    'Qmusic', '538 Radio 102.1 FM', 'SLAM!', 'NPO Radio 2', 'NPO Soul & Jazz', 'Sky Radio 101 FM', 'Arrow Classic Rock',
  ])
  assert.equal(nowPlaying(s), null)
})

test('netwerkmenu: internetradio die speelt (onbewerkt van de receiver)', () => {
  const s = parseNetScreen(fixture('net-playing-iradio.xml'))
  assert.equal(s.title, 'Now Playing')
  assert.equal(s.cursor, null)
  assert.equal(s.service, 'IRADIO')
  assert.deepEqual(nowPlaying(s), { station: 'Qmusic', track: 'Sorry Papi - TOPIC & BECKY G' })
  assert.notEqual(screenKey(s), screenKey(parseNetScreen(fixture('net-favorites.xml'))))
})

test('stream-adres controleren', () => {
  assert.equal(streamUrlProblem('http://icecast.omroep.nl/radio2-bb-mp3'), null)
  assert.match(streamUrlProblem('https://icecast.omroep.nl/radio2-bb-mp3'), /https/)
  assert.match(streamUrlProblem(''), /Vul/)
  assert.match(streamUrlProblem('icecast.omroep.nl'), /geen geldig/)
  assert.match(streamUrlProblem('ftp://x/y'), /http:\/\//)
  assert.equal(
    playUrlPath(' http://a.b/c?d=1&e=2 ', 'NPO Radio 2'),
    'dlna/play?url=http%3A%2F%2Fa.b%2Fc%3Fd%3D1%26e%3D2&title=NPO%20Radio%202',
  )
})

test('favorieten samenvoegen: volgorde en aanpassingen uit de app blijven', () => {
  let n = 0
  const id = () => `n${n++}`
  const receiver = [
    { name: 'Qmusic', index: 1, total: 4 },
    { name: 'Radio 10', index: 2, total: 4 },
    { name: 'Radio 10', index: 3, total: 4 },
    { name: 'SLAM!', index: 4, total: 4 },
  ]
  // Eerste keer: alles nieuw, in de volgorde van het menu.
  const first = mergeFavorites([], receiver, id)
  assert.deepEqual(first.map(f => [f.id, f.name, f.receiver.index]), [
    ['n0', 'Qmusic', 1], ['n1', 'Radio 10', 2], ['n2', 'Radio 10', 3], ['n3', 'SLAM!', 4],
  ])

  // In de app: SLAM! bovenaan, Qmusic hernoemd met een eigen adres, één Radio 10 verborgen,
  // en een eigen zender erbij.
  const edited = [
    first[3],
    { ...first[0], name: 'Q', url: 'http://q/mp3' },
    { ...first[1], hidden: true },
    first[2],
    { id: 'u1', name: 'Eigen', url: 'http://e/mp3' },
  ]

  // Op de receiver is SLAM! naar voren geschoven, één Radio 10 en Qmusic zijn weg,
  // en er is een nieuwe zender.
  const later = [
    { name: 'SLAM!', index: 1, total: 3 },
    { name: 'Radio 10', index: 2, total: 3 },
    { name: 'Sublime', index: 3, total: 3 },
  ]
  const merged = mergeFavorites(edited, later, id)
  assert.deepEqual(
    merged.map(f => [f.id, f.name, f.receiver ? `${f.receiver.index}/${f.receiver.total}` : '-', !!f.hidden, f.url ?? '']),
    [
      ['n3', 'SLAM!', '1/3', false, ''],
      ['n0', 'Q', '-', false, 'http://q/mp3'], //  niet meer op de receiver, wel een eigen adres
      ['n1', 'Radio 10', '2/3', true, ''], //    blijft verborgen
      //                                            de tweede Radio 10 is weg
      ['u1', 'Eigen', '-', false, 'http://e/mp3'],
      ['n4', 'Sublime', '3/3', false, ''],
    ],
  )
})

test('favoriet verschuiven', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(moveFavorite(list, 'b', -1).map(f => f.id), ['b', 'a', 'c'])
  assert.deepEqual(moveFavorite(list, 'b', 1).map(f => f.id), ['a', 'c', 'b'])
  assert.deepEqual(moveFavorite(list, 'a', -1).map(f => f.id), ['a', 'b', 'c'])
  assert.deepEqual(moveFavorite(list, 'c', 1).map(f => f.id), ['a', 'b', 'c'])
})

test('plek in een ronde lijst', () => {
  assert.equal(wrap(1, 27), 1)
  assert.equal(wrap(28, 27), 1)
  assert.equal(wrap(0, 27), 27)
  assert.equal(wrap(-6, 27), 21)
  const s = { ...parseNetScreen(fixture('net-favorites.xml')), total: 27 }
  assert.deepEqual(visibleEntries(s, 26).slice(0, 3), [
    { index: 26, name: 'Qmusic' }, { index: 27, name: '538 Radio 102.1 FM' }, { index: 1, name: 'SLAM!' },
  ])
  assert.equal(parseNetScreen(fixture('net-favorites.xml')).index, 1)
  assert.equal(parseNetScreen(fixture('net-favorites.xml')).total, 27)
})

test('route naar elke favoriet: de kortste kant, en de lijst is rond', () => {
  for (const total of [1, 2, 5, 27, 50]) {
    for (let from = 1; from <= total; from++) {
      for (let target = 1; target <= total; target++) {
        const plan = planMove(from, target, total)
        // Narekenen: omlaag is +1, omhoog -1, rond.
        const end = plan.reduce((i, cmd) => wrap(i + (cmd === NAV.down ? 1 : -1), total), from)
        assert.equal(end, target, `${total}: ${from} -> ${target} via ${plan}`)
        assert.ok(plan.length <= Math.floor(total / 2), `${total}: ${from} -> ${target} duurt ${plan.length}`)
      }
    }
  }
  assert.deepEqual(planMove(2, 23, 27), Array(6).fill(NAV.up)) //  rond, achteruit
  assert.deepEqual(planMove(17, 18, 27), [NAV.down])
  assert.deepEqual(planMove(5, 5, 27), [])
})

test('luidsprekerniveaus lezen (onbewerkt van de receiver)', () => {
  assert.deepEqual(parseLevels(fixture('speaker-levels.html')), { FL: 0, C: 0, FR: 0, SR: 0, SL: 0 })
  assert.deepEqual(parseLevels("<input id='RangeCVFL' type='range' value='-1.5' min='-12'>"), { FL: -1.5 })
})

test('kanten en commando', () => {
  assert.deepEqual(['FL', 'SL', 'SBL', 'FHL', 'FR', 'SR', 'SBR', 'C', 'SW', 'SW2', 'SB'].map(sideOf),
    ['L', 'L', 'L', 'L', 'R', 'R', 'R', null, null, null, null])
  assert.equal(levelCommand('FL', -1.5), 'SSLEVFL 485')
  assert.equal(levelCommand('SR', 0), 'SSLEVSR 50')
  assert.equal(levelCommand('FL', -12), 'SSLEVFL 38')
  assert.equal(levelCommand('FL', -20), 'SSLEVFL 38')
  assert.equal(levelCommand('FR', 12), 'SSLEVFR 62')
  assert.equal(levelCommand('C', -0.5), 'SSLEVC 495')
})

test('balans: alleen de andere kant zachter, en terug te lezen', () => {
  // Een receiver die met Audyssey is ingemeten: niet alles op 0.
  const base = { FL: -1.5, C: 0, FR: -2, SR: -3, SL: -2.5, SW: 1 }
  const right = balanceLevels(base, 1.5)
  assert.deepEqual(right, { FL: -3, C: 0, FR: -2, SR: -3, SL: -4, SW: 1 })
  assert.equal(balanceFrom(right, base), 1.5)
  const left = balanceLevels(base, -2)
  assert.deepEqual(left, { FL: -1.5, C: 0, FR: -4, SR: -5, SL: -2.5, SW: 1 })
  assert.equal(balanceFrom(left, base), -2)
  assert.deepEqual(balanceLevels(base, 0), base)
  assert.equal(balanceFrom(base, base), 0)
  // Nooit lager dan -12.
  assert.equal(balanceLevels({ FL: -11, FR: 0 }, 3).FL, -12)
})

test('balans past niet: dan begint de app opnieuw vanaf wat er staat', () => {
  const base = { FL: 0, C: 0, FR: 0, SL: 0, SR: 0 }
  assert.equal(balanceFrom({ FL: -1, C: -1, FR: 0, SL: -1, SR: 0 }, base), null) //  midden ook veranderd
  assert.equal(balanceFrom({ FL: -1, C: 0, FR: 0, SL: -2, SR: 0 }, base), null) //   links ongelijk
  assert.equal(balanceFrom({ FL: -1, C: 0, FR: -1, SL: -1, SR: -1 }, base), null) // beide kanten zachter
  assert.equal(balanceFrom({ FL: 1, C: 0, FR: 0, SL: 1, SR: 0 }, base), null) //     harder dan de basis
  assert.equal(balanceFrom({ FL: 0, FR: 0 }, base), null) //                         andere luidsprekers
  assert.equal(balanceFrom({ FL: 0, FR: 0 }, null), null)
})

test('balans als tekst', () => {
  assert.equal(formatBalance(0), 'Midden')
  assert.equal(formatBalance(1.5), 'Links 1,5 dB zachter')
  assert.equal(formatBalance(-2), 'Rechts 2 dB zachter')
})
