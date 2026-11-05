import {qs, PW, PH} from './config.js'
import {$, h, mkCanvas, LS, idb, toast} from './util.js'
import {settings, me, cam, loadSegmenter, setBlur, openCam, openMic, refreshDevices} from './media.js'
import {room, A, roomCode, prog, joinCall, chatLine, toggleMic, toggleCam, toggleScreen, stopSending} from './call.js'
import {session, pickRoot, startRecording, stopRecording, addMarker, callHooks, hq, hqDir, hqUpdate, saveHQToFolder, clearHQ, stopRecordingForLeave, finishTransfers, flushLogs} from './recording.js'
import {ed, openEditor, edPlay, edPause, edSeek} from './editor.js'

$('#name').value = me.name
$('#room').value = decodeURIComponent(location.hash.slice(1))
$('#blurSel').value = settings.blur; $('#hqSel').value = settings.hq
$('#randBtn').onclick = () => {
  const w = ['amber', 'brisk', 'cedar', 'delta', 'ember', 'frost', 'gleam', 'harbor', 'ivory', 'juniper', 'koala', 'lunar', 'maple', 'nova', 'otter', 'pixel', 'quartz', 'river', 'sable', 'tidal']
  const r = () => w[Math.floor(Math.random() * w.length)]
  $('#room').value = `${r()}-${r()}-${Math.floor(Math.random() * 100)}`
}
const join = () => joinCall(callHooks)
$('#joinBtn').onclick = join
$('#room').onkeydown = e => { if (e.key === 'Enter') join() }
$('#camSel').onchange = e => openCam(e.target.value)
$('#micSel').onchange = e => openMic(e.target.value)
$('#blurSel').onchange = e => setBlur(e.target.value)
$('#hqSel').onchange = e => { settings.hq = e.target.value; LS.set('hqMode', settings.hq); hqUpdate() }
$('#openEdBtn').onclick = () => openEditor()
$('#micBtn').onclick = () => toggleMic()
$('#camBtn').onclick = () => toggleCam()
$('#scrBtn').onclick = toggleScreen
$('#recBtn').onclick = () => session ? stopRecording() : startRecording()
$('#markBtn').onclick = addMarker
$('#leaveBtn').onclick = leaveCall
$('#folderBtn').onclick = () => pickRoot().catch(() => {})
$('#inviteBtn').onclick = () => { navigator.clipboard.writeText(location.origin + location.pathname + '#' + encodeURIComponent(roomCode)); toast('Invite link copied') }
function sendChat() {
  const v = $('#chatIn').value.trim()
  if (!v || !A.chat) return
  A.chat.send(v); chatLine('You', v); $('#chatIn').value = ''
}
$('#chatSend').onclick = sendChat
$('#chatIn').onkeydown = e => { if (e.key === 'Enter') sendChat() }
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b))
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab))
  prog.showPreview = b.dataset.tab === 'prod'
})
$('#cleanBtn').onclick = () => {
  const c = mkCanvas(PW, PH); prog.cleanCtx = c.getContext('2d')
  $('#clean').replaceChildren(c); $('#clean').classList.remove('hidden'); prog.clean = true
  toast('Clean output. Press Esc to exit. In OBS, add a Window Capture of this window.', 5000)
}
const exitClean = () => { prog.clean = false; $('#clean').classList.add('hidden') }
$('#clean').ondblclick = exitClean
addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  if (k === 'escape') exitClean()
  if (ed.open) {
    if (k === ' ') { e.preventDefault(); ed.playing ? edPause() : edPlay() }
    else if (k === 'arrowleft') edSeek(ed.t - (e.shiftKey ? 1000 : 5000))
    else if (k === 'arrowright') edSeek(ed.t + (e.shiftKey ? 1000 : 5000))
    else if (k === 'i') $('#edIn').click()
    else if (k === 'o') $('#edOut').click()
  } else if (room) {
    if (k === 'm') toggleMic(); else if (k === 'v') toggleCam(); else if (k === 'k') addMarker()
  }
})

async function leaveCall() {
  if (!await stopRecordingForLeave()) return
  stopSending()
  await finishTransfers()
  room.leave()
  await flushLogs()
  location.hash = roomCode; location.reload()
}

async function checkLeftovers() {
  try {
    const d = await hqDir()
    const mf = JSON.parse(await (await (await d.getFileHandle('manifest.json')).getFile()).text())
    const segs = (mf.segs || []).filter(s => !s.sentTo?.length)
    if (!segs.length) return
    const box = $('#leftoverHQ'); box.classList.remove('hidden')
    box.replaceChildren(h('hr'), h('div', {}, `⚠️ ${segs.length} unsent full-quality file(s) from an earlier call.`),
      h('div', {class: 'row'}, h('button', {onclick: async () => { if (await saveHQToFolder(segs.map(s => ({...s, pid: mf.pid})))) { await clearHQ(segs); box.classList.add('hidden') } }}, 'Save to folder…'),
        h('button', {onclick: async () => { hq.segs = mf.segs; await clearHQ(segs); box.classList.add('hidden') }}, 'Delete')))
    hq.segs = mf.segs.map(s => ({...s, sentTo: new Set(s.sentTo || [])}))
  } catch {}
}

async function boot() {
  if (!window.showDirectoryPicker) toast('This browser lacks the File System Access API. Use desktop Chrome.', 0)
  if (qs.get('editor') === 'last') {
    const d = await idb.get('lastSession')
    if (d) {
      const b = h('button', {class: 'primary', onclick: () => { b.remove(); openEditor(d) }}, `Open “${d.name}” in the editor`)
      $('#openEdBtn').before(b); b.focus()
    }
  }
  checkLeftovers()
  await Promise.all([openCam(settings.camId), openMic(settings.micId)])
  $('#lobbyVideo').srcObject = new MediaStream([cam.track])
  await refreshDevices()
  if (settings.blur) loadSegmenter().catch(() => {})
}
boot()
