import {TRYSTERO_URL, APP_ID, ICE, PW, PH} from './config.js'
import {$, h, mkCanvas, fmtMB, initials, LS, PID, toast, tickers} from './util.js'
import {ac, resumeAudio, me, cam, mic, localStream, stopMeter} from './media.js'
import {defaultLayout, composite, layoutControls} from './layout.js'
import {session, sessions, startFeedRec, stopFeedRec, clockSync, updateRecUI, onHQChunk, updateIncomingUI, hq, hqUpdate, hqStartSeg, hqStopSeg, offerHQ} from './recording.js'

let room = null, A = {}, roomCode = ''
const peers = new Map()   // peerId -> {pid, name, mic, cam, helloed}
const feeds = new Map()   // key -> {key, pid, kind, stream, local, peerId, el, tile}
let screen = null
let liveLayout = {...defaultLayout(), ...LS.get('layout', {})}
const pidName = pid => pid === PID ? me.name : ([...peers.values()].find(p => p.pid === pid)?.name || 'Guest')
const feedName = f => pidName(f.pid) + (f.kind === 'screen' ? ' (screen)' : '')
const pidState = pid => pid === PID ? me : ([...peers.values()].find(p => p.pid === pid) || {mic: true, cam: true})
const remoteRecorders = new Map() // recId -> {peerId, name}

function addFeed(f) {
  if (feeds.has(f.key)) removeFeed(f.key)
  const v = h('video', {autoplay: true, playsinline: true}); v.muted = !!f.local; v.srcObject = f.stream
  f.el = v
  f.tile = h('div', {class: `tile ${f.kind}${f.local ? ' local' : ''}`}, v, h('div', {class: 'off'}), h('div', {class: 'nm'}), h('div', {class: 'mut'}, 'muted'))
  $('#stage').append(f.tile)
  feeds.set(f.key, f)
  v.play().catch(() => {})
  f.stream.addEventListener('addtrack', () => syncProgAudio())
  updateTiles(); syncProgAudio(); liveCtl?.render()
  if (session) startFeedRec(f)
  if (hq.active && f.local) hqStartSeg(f)
}
function removeFeed(key) {
  const f = feeds.get(key); if (!f) return
  feeds.delete(key); f.tile.remove(); f.el.srcObject = null
  if (session) stopFeedRec(session, key)
  if (f.local) hqStopSeg(key)
  updateTiles(); syncProgAudio(); liveCtl?.render()
}
function updateTiles() {
  let scr = false
  for (const f of feeds.values()) {
    const st = pidState(f.pid)
    f.tile.querySelector('.nm').textContent = feedName(f) + (f.local ? ' (you)' : '')
    f.tile.querySelector('.off').textContent = initials(pidName(f.pid))
    f.tile.classList.toggle('camoff', f.kind === 'cam' && st.cam === false)
    f.tile.classList.toggle('micoff', f.kind === 'cam' && st.mic === false)
    if (f.kind === 'screen') scr = true
  }
  $('#stage').classList.toggle('has-screen', scr)
  $('#micBtn').classList.toggle('on', !me.mic); $('#micBtn').textContent = me.mic ? '🎙 Mic' : '🔇 Unmute'
  $('#camBtn').classList.toggle('on', !me.cam); $('#camBtn').textContent = me.cam ? '📷 Camera' : '🚫 Camera off'
  $('#scrBtn').classList.toggle('on', !!screen); $('#scrBtn').textContent = screen ? '🖥 Stop sharing' : '🖥 Share screen'
  updateRecUI()
}
const liveItems = () => [...feeds.values()].map(f => ({key: f.key, name: feedName(f), kind: f.kind, el: f.el, camOff: f.kind === 'cam' && pidState(f.pid).cam === false, micOff: f.kind === 'cam' && pidState(f.pid).mic === false}))

// ======================= program output (live mix) =======================
const prog = {canvas: mkCanvas(PW, PH), sources: new Map(), dest: ac.createMediaStreamDestination(), showPreview: false, clean: false}
prog.ctx = prog.canvas.getContext('2d')
prog.stream = new MediaStream([prog.canvas.captureStream(30).getVideoTracks()[0], prog.dest.stream.getAudioTracks()[0]])
window.programStream = prog.stream // hook for future live streaming (WHIP etc.)
const progPrev = $('#progPreview').getContext('2d')
tickers.add(() => {
  if (!room || !(session || prog.showPreview || prog.clean)) return
  composite(prog.ctx, PW, PH, liveLayout, liveItems())
  if (prog.showPreview) progPrev.drawImage(prog.canvas, 0, 0)
  if (prog.clean) prog.cleanCtx.drawImage(prog.canvas, 0, 0)
})
function syncProgAudio() {
  const want = new Map()
  for (const f of feeds.values()) for (const t of f.stream.getAudioTracks()) want.set(t.id, t)
  for (const [id, n] of prog.sources) if (!want.has(id)) { n.disconnect(); prog.sources.delete(id) }
  for (const [id, t] of want) if (!prog.sources.has(id)) {
    const n = ac.createMediaStreamSource(new MediaStream([t])); n.connect(prog.dest); prog.sources.set(id, n)
  }
}
function setLiveLayout(L) {
  liveLayout = L; LS.set('layout', {...L, order: []})
  session?.log.add('layout', {layout: L})
  liveCtl.render()
}
const liveCtl = layoutControls($('#liveLayout'), () => liveLayout, setLiveLayout, () => liveItems())

// ======================= joining =======================
async function joinCall() {
  me.name = $('#name').value.trim() || 'Guest'; LS.set('name', me.name)
  roomCode = $('#room').value.trim()
  if (!roomCode) { $('#room').focus(); return }
  history.replaceState(null, '', '#' + encodeURIComponent(roomCode))
  $('#joinBtn').disabled = true
  resumeAudio()
  let mod
  try { mod = await import(TRYSTERO_URL) } catch (e) { toast('Could not load Trystero: ' + e.message, 8000); $('#joinBtn').disabled = false; return }
  room = mod.joinRoom({appId: APP_ID, password: roomCode, rtcConfig: {iceServers: ICE}}, roomCode)

  A.hello = room.makeAction('hello')
  A.feedEnd = room.makeAction('feedEnd')
  A.rec = room.makeAction('rec')
  A.chat = room.makeAction('chat')
  A.marker = room.makeAction('marker')
  A.hqPlan = room.makeAction('hqPlan')
  A.clock = room.makeAction('clock', {kind: 'request', onRequest: () => Date.now()})
  A.hq = room.makeAction('hq', {kind: 'request', onRequest: onHQChunk})

  A.hello.onMessage = (d, {peerId}) => {
    const p = peers.get(peerId) || {}
    const first = !p.helloed
    const changed = p.mic !== d.mic || p.cam !== d.cam || p.name !== d.name
    Object.assign(p, {pid: d.pid, name: d.name, mic: d.mic, cam: d.cam, helloed: true}); peers.set(peerId, p)
    if (session) {
      if (first) { session.log.add('peer-join', {pid: d.pid, name: d.name}); clockSync(session, peerId) }
      if (first || changed) session.log.add('state', {pid: d.pid, name: d.name, mic: d.mic, cam: d.cam})
    }
    if (first) chatLine(null, `${d.name} joined`)
    updateTiles(); liveCtl.render()
  }
  A.feedEnd.onMessage = ({key}) => removeFeed(key)
  A.chat.onMessage = (text, {peerId}) => chatLine(peers.get(peerId)?.name || 'Guest', text)
  A.marker.onMessage = (d, {peerId}) => { if (session) { session.log.add('marker', {label: d.label, by: peers.get(peerId)?.name}); toast(`🚩 Marker from ${peers.get(peerId)?.name}`) } }
  A.rec.onMessage = (d, {peerId}) => {
    if (d.on) { remoteRecorders.set(d.recId, {peerId, name: d.name}); hq.recs.set(d.recId, {peerId, name: d.name, start: Date.now(), live: true}); toast(`⏺ ${d.name} started recording`) }
    else { remoteRecorders.delete(d.recId); const r = hq.recs.get(d.recId); if (r) { r.live = false; r.stop = Date.now() } toast(`${d.name} stopped recording`) ; hqUpdate().then(() => offerHQ(d.recId)) }
    hqUpdate(); updateRecUI()
  }
  A.hqPlan.onMessage = (d, {peerId}) => {
    const s = sessions.get(d.recId); if (!s) return
    const name = peers.get(peerId)?.name
    if (d.deciding) { if (!s.incoming.has(peerId)) s.incoming.set(peerId, {name, bytes: 0, got: 0, done: false, deciding: true}) }
    else {
      s.incoming.set(peerId, {name, bytes: d.bytes, got: 0, done: d.bytes === 0, declined: d.bytes === 0})
      if (d.bytes) toast(`Receiving full-quality files from ${name} (${fmtMB(d.bytes)})`)
    }
    updateIncomingUI()
  }
  room.onPeerJoin = peerId => {
    if (!peers.has(peerId)) peers.set(peerId, {pid: null, name: 'Guest', mic: true, cam: true})
    sendHello(peerId)
    room.addStream(localStream, {target: peerId, metadata: {pid: PID, kind: 'cam'}})
    if (screen) room.addStream(screen.stream, {target: peerId, metadata: {pid: PID, kind: 'screen'}})
    if (session) A.rec.send({on: true, recId: session.recId, name: me.name}, {target: peerId})
  }
  room.onPeerLeave = peerId => {
    const p = peers.get(peerId)
    for (const f of [...feeds.values()]) if (f.peerId === peerId) removeFeed(f.key)
    if (p?.helloed) { chatLine(null, `${p.name} left`); session?.log.add('peer-leave', {pid: p.pid, name: p.name}) }
    peers.delete(peerId)
    for (const [id, r] of [...remoteRecorders]) if (r.peerId === peerId) { remoteRecorders.delete(id); const x = hq.recs.get(id); if (x) { x.live = false; x.stop = Date.now(); x.gone = true } }
    for (const s of sessions.values()) { const inc = s.incoming.get(peerId); if (inc && !inc.done) { inc.failed = true; updateIncomingUI() } }
    hqUpdate(); updateTiles(); updateRecUI()
  }
  room.onPeerStream = (stream, peerId, md) => {
    const pid = md?.pid || peers.get(peerId)?.pid || peerId, kind = md?.kind || 'cam'
    addFeed({key: `${pid}:${kind}`, pid, kind, stream, local: false, peerId})
  }

  addFeed({key: `${PID}:cam`, pid: PID, kind: 'cam', stream: localStream, local: true})
  $('#settingsHost').firstElementChild && $('#setPane').append($('#settings'))
  $('#lobby').classList.add('hidden'); $('#call').classList.remove('hidden')
  $('#hdrRoom').textContent = `Room: ${roomCode}`
  stopMeter()
  chatLine(null, 'Joined. Waiting for others… share the invite link or room code.')
}
function sendHello(target) { A.hello?.send({pid: PID, name: me.name, mic: me.mic, cam: me.cam}, target ? {target} : undefined) }
function chatLine(who, text) {
  const d = h('div', {}, who ? h('b', {}, who + ': ') : h('i', {class: 'dim'}, ''), who ? text : h('span', {class: 'dim'}, text))
  $('#chatLog').append(d); $('#chatLog').scrollTop = 1e9
}

// ======================= controls =======================
function toggleMic(v = !me.mic) { me.mic = v; mic.track.enabled = v; sendHello(); session?.log.add('state', {pid: PID, name: me.name, mic: me.mic, cam: me.cam}); updateTiles() }
function toggleCam(v = !me.cam) { me.cam = v; cam.track.enabled = v; sendHello(); session?.log.add('state', {pid: PID, name: me.name, mic: me.mic, cam: me.cam}); updateTiles() }
async function toggleScreen() {
  if (screen) return stopScreen()
  let s
  try { s = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: {ideal: 30}}, audio: true, systemAudio: 'include', surfaceSwitching: 'include', selfBrowserSurface: 'exclude'}) }
  catch { return }
  screen = {stream: s}
  s.getVideoTracks()[0].addEventListener('ended', stopScreen)
  room.addStream(s, {metadata: {pid: PID, kind: 'screen'}})
  addFeed({key: `${PID}:screen`, pid: PID, kind: 'screen', stream: s, local: true})
}
function stopScreen() {
  if (!screen) return
  const s = screen.stream; screen = null
  try { room.removeStream(s) } catch {}
  s.getTracks().forEach(t => t.stop())
  A.feedEnd.send({key: `${PID}:screen`})
  removeFeed(`${PID}:screen`)
}
function addMarker() {
  const label = 'Marker ' + new Date().toLocaleTimeString()
  if (session) { session.log.add('marker', {label, by: me.name}); toast('🚩 Marker added') }
  for (const [, r] of remoteRecorders) A.marker.send({label}, {target: r.peerId})
  if (remoteRecorders.size && !session) toast('🚩 Marker sent to recorder')
}

// ======================= recording (any participant can record) =======================

export {room, A, roomCode, peers, feeds, screen, liveLayout, pidName, feedName, pidState, remoteRecorders, addFeed, removeFeed, updateTiles, liveItems, prog, progPrev, syncProgAudio, setLiveLayout, liveCtl, joinCall, sendHello, chatLine, toggleMic, toggleCam, toggleScreen, stopScreen, addMarker}
