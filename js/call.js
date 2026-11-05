import {TRYSTERO_URL, APP_ID, ICE, PW, PH} from './config.js'
import {$, h, mkCanvas, initials, LS, PID, toast, tickers} from './util.js'
import {ac, resumeAudio, me, cam, mic, localStream, stopMeter, stopLocalDevices} from './media.js'
import {defaultLayout, composite, layoutControls} from './layout.js'

let room = null, A = {}, roomCode = ''
const peers = new Map()   // peerId -> {pid, name, mic, cam, helloed}
const feeds = new Map()   // key -> {key, pid, kind, stream, local, peerId, el, tile}
let screen = null
let liveLayout = {...defaultLayout(), ...LS.get('layout', {})}
const pidName = pid => pid === PID ? me.name : ([...peers.values()].find(p => p.pid === pid)?.name || 'Guest')
const feedName = f => pidName(f.pid) + (f.kind === 'screen' ? ' (screen)' : '')
const pidState = pid => pid === PID ? me : ([...peers.values()].find(p => p.pid === pid) || {mic: true, cam: true})
// recording hooks, supplied at join: joined(room), peerJoined(peerId), peerHello(peerId, hello, first, changed),
// peerLeft(peerId, peer), feedAdded(f), feedRemoved(f), stateChanged(), layoutChanged(layout)
let on = {}

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
  on.feedAdded?.(f)
}
function removeFeed(key) {
  const f = feeds.get(key); if (!f) return
  feeds.delete(key); f.tile.remove(); f.el.srcObject = null
  on.feedRemoved?.(f)
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
}
const liveItems = () => [...feeds.values()].map(f => ({key: f.key, name: feedName(f), kind: f.kind, el: f.el, camOff: f.kind === 'cam' && pidState(f.pid).cam === false, micOff: f.kind === 'cam' && pidState(f.pid).mic === false}))

// ======================= program output (live mix) =======================
const prog = {canvas: mkCanvas(PW, PH), sources: new Map(), dest: ac.createMediaStreamDestination(), users: new Set()}
prog.ctx = prog.canvas.getContext('2d')
const programStream = window.programStream = new MediaStream([prog.canvas.captureStream(30).getVideoTracks()[0], prog.dest.stream.getAudioTracks()[0]]) // window: hook for future live streaming (WHIP etc.)
// the program only renders while someone uses it; a user with a ctx gets each frame copied to it
const useProgram = (user, on) => on ? prog.users.add(user) : prog.users.delete(user)
tickers.add(() => {
  if (!room || !prog.users.size) return
  composite(prog.ctx, PW, PH, liveLayout, liveItems())
  for (const u of prog.users) u.ctx?.drawImage(prog.canvas, 0, 0)
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
  on.layoutChanged?.(L)
  liveCtl.render()
}
const liveCtl = layoutControls($('#liveLayout'), () => liveLayout, setLiveLayout, () => liveItems())

// ======================= joining =======================
async function joinCall(hooks) {
  me.name = $('#name').value.trim() || 'Guest'; LS.set('name', me.name)
  roomCode = $('#room').value.trim()
  if (!roomCode) { $('#room').focus(); return }
  history.replaceState(null, '', '#' + encodeURIComponent(roomCode))
  $('#joinBtn').disabled = true
  resumeAudio()
  let mod
  try { mod = await import(TRYSTERO_URL) } catch (e) { toast('Could not load Trystero: ' + e.message, 8000); $('#joinBtn').disabled = false; return }
  room = mod.joinRoom({appId: APP_ID, password: roomCode, rtcConfig: {iceServers: ICE}}, roomCode)

  on = hooks
  A.hello = room.makeAction('hello')
  A.feedEnd = room.makeAction('feedEnd')
  A.chat = room.makeAction('chat')
  on.joined(room)

  A.hello.onMessage = (d, {peerId}) => {
    const p = peers.get(peerId) || {}
    const first = !p.helloed
    const changed = p.mic !== d.mic || p.cam !== d.cam || p.name !== d.name
    Object.assign(p, {pid: d.pid, name: d.name, mic: d.mic, cam: d.cam, helloed: true}); peers.set(peerId, p)
    on.peerHello(peerId, d, first, changed)
    if (first) chatLine(null, `${d.name} joined`)
    updateTiles(); liveCtl.render()
  }
  A.feedEnd.onMessage = ({key}, {peerId}) => { if (feeds.get(key)?.peerId === peerId) removeFeed(key) }
  A.chat.onMessage = (text, {peerId}) => chatLine(peers.get(peerId)?.name || 'Guest', text)
  room.onPeerJoin = peerId => {
    if (!peers.has(peerId)) peers.set(peerId, {pid: null, name: 'Guest', mic: true, cam: true})
    sendHello(peerId)
    room.addStream(localStream, {target: peerId, metadata: {pid: PID, kind: 'cam'}})
    if (screen) room.addStream(screen.stream, {target: peerId, metadata: {pid: PID, kind: 'screen'}})
    on.peerJoined(peerId)
  }
  room.onPeerLeave = peerId => {
    const p = peers.get(peerId)
    for (const f of [...feeds.values()]) if (f.peerId === peerId) removeFeed(f.key)
    if (p?.helloed) chatLine(null, `${p.name} left`)
    peers.delete(peerId)
    on.peerLeft(peerId, p)
    updateTiles()
  }
  room.onPeerStream = (stream, peerId, md) => {
    const pid = peers.get(peerId)?.pid || md?.pid || peerId, kind = md?.kind === 'screen' ? 'screen' : 'cam'
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
function sendChat(text) {
  if (!A.chat) return false
  A.chat.send(text); chatLine('You', text)
  return true
}
function chatLine(who, text) {
  const d = h('div', {}, who ? h('b', {}, who + ': ') : h('i', {class: 'dim'}, ''), who ? text : h('span', {class: 'dim'}, text))
  $('#chatLog').append(d); $('#chatLog').scrollTop = 1e9
}

// ======================= controls =======================
function toggleMic(v = !me.mic) { me.mic = v; mic.track.enabled = v; stateChanged() }
function toggleCam(v = !me.cam) { me.cam = v; cam.track.enabled = v; stateChanged() }
function stateChanged() { sendHello(); on.stateChanged?.(); updateTiles() }
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
// stop sending media right away, but keep the room connection for transfers
function stopSending() {
  stopScreen()
  try { room.removeStream(localStream) } catch {}
  toggleCam(false); toggleMic(false); stopLocalDevices()
}

export {room, roomCode, peers, feeds, liveLayout, pidName, programStream, useProgram, joinCall, sendChat, toggleMic, toggleCam, toggleScreen, stopSending}
