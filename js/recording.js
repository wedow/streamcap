import {MIME, EXT, FEED_MIME, PW, PH, CHUNK} from './config.js'
import {$, h, fmt, fmtMB, slug, stamp, rid, sleep, PID, idb, ensurePerm, toast, modal, fileWriter, recordStream, EventLog} from './util.js'
import {settings, me} from './media.js'
import {roomCode, peers, feeds, liveLayout, pidName, programStream, useProgram} from './call.js'

let session = null
const sessions = new Map() // recId -> session (kept after stop to receive HQ files)
let rootDir = null
const A = {} // room actions owned by recording, made on join
idb.get('root').then(d => { rootDir = d; $('#folderName').textContent = d ? d.name : '' })
async function pickRoot() {
  rootDir = await window.showDirectoryPicker({id: 'p2pstudio', mode: 'readwrite'})
  await idb.set('root', rootDir); $('#folderName').textContent = rootDir.name
}
async function startRecording() {
  if (session) return
  try {
    if (!rootDir || !(await ensurePerm(rootDir).catch(() => false))) await pickRoot()
  } catch { return }
  const dir = await rootDir.getDirectoryHandle(`${stamp()} ${slug(roomCode)}`, {create: true})
  const s = {recId: rid(), dir, log: new EventLog(dir), recs: new Map(), counters: {}, t0: Date.now(), offsets: {}, inFiles: new Map(), incoming: new Map()}
  session = s; useProgram(s, true); sessions.set(s.recId, s); idb.set('lastSession', dir)
  s.log.add('session-start', {room: roomCode, recorder: {pid: PID, name: me.name}, mime: MIME, program: {w: PW, h: PH, fps: 30}})
  s.log.add('peer-join', {pid: PID, name: me.name, self: true})
  logState(PID, me)
  for (const [peerId, p] of peers) if (p.helloed) {
    s.log.add('peer-join', {pid: p.pid, name: p.name}); logState(p.pid, p)
    clockSync(s, peerId)
  }
  s.log.add('layout', {layout: liveLayout})
  for (const f of feeds.values()) startFeedRec(f)
  const pf = `program-live.${EXT}`
  s.mix = recordStream(programStream, await fileWriter(dir, pf), {vbr: 8e6})
  s.mix.started.then(t => s.log.add('program-start', {file: pf, t}))
  A.rec.send({on: true, recId: s.recId, name: me.name})
  s.timer = setInterval(updateRecUI, 1000)
  await s.log.flush()
  updateRecUI(); toast(`⏺ Recording to “${rootDir.name}/${dir.name}”`)
}
async function startFeedRec(f) {
  const s = session; if (!s || s.recs.has(f.key)) return
  const n = s.counters[f.key] = (s.counters[f.key] || 0) + 1
  const src = f.local ? 'local' : 'live'
  const file = `${src}-${slug(pidName(f.pid))}-${f.kind}-${n}.${EXT}`
  const p = (async () => {
    const rec = recordStream(f.stream, await fileWriter(s.dir, file), {
      vbr: f.local ? (f.kind === 'screen' ? 6e6 : 8e6) : 5e6, mime: FEED_MIME,
      onerror: () => { if (session === s && feeds.get(f.key) === f) stopFeedRec(s, f.key).then(() => startFeedRec(f)) }
    })
    rec.started.then(t => s.log.add('feed-start', {t, key: f.key, pid: f.pid, name: pidName(f.pid), kind: f.kind, file, source: src}))
    return {rec, file}
  })()
  s.recs.set(f.key, p)
}
async function stopFeedRec(s, key) {
  const p = s.recs.get(key); if (!p) return
  s.recs.delete(key)
  const {rec, file} = await p
  const t = await rec.stop()
  s.log.add('feed-stop', {t, key, file, bytes: rec.writer.bytes})
}
async function stopRecording() {
  const s = session; if (!s) return
  session = null; useProgram(s, false)
  A.rec.send({on: false, recId: s.recId, name: me.name})
  clearInterval(s.timer)
  await Promise.all([...s.recs.keys()].map(k => stopFeedRec(s, k)))
  const t = await s.mix.stop(); s.log.add('program-stop', {t, file: `program-live.${EXT}`})
  s.log.add('session-stop')
  await s.log.flush()
  updateRecUI()
  toast(`Saved “${s.dir.name}”`, 10000, h('button', {onclick: () => window.open(location.pathname + '?editor=last', '_blank')}, 'Open in editor'))
}
async function clockSync(s, peerId) {
  let best = null
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    const rt = await A.clock.request(0, {target: peerId, timeoutMs: 3000}).catch(() => null)
    const t1 = Date.now()
    if (typeof rt !== 'number') continue
    const off = rt - (t0 + (t1 - t0) / 2)
    if (!best || t1 - t0 < best.rtt) best = {rtt: t1 - t0, off}
    await sleep(100)
  }
  const pid = peers.get(peerId)?.pid
  if (best && pid) { s.offsets[pid] = best.off; s.log.add('clock', {pid, offset: Math.round(best.off), rtt: best.rtt}) }
}
function updateRecUI() {
  const others = liveRecs().map(r => r.name)
  const parts = []
  if (session) parts.push('You')
  parts.push(...others)
  $('#recBadge').classList.toggle('hidden', !parts.length)
  $('#recBadge').textContent = parts.length ? `● REC — ${parts.join(', ')}` : ''
  $('#recBtn').textContent = session ? `⏹ Stop recording (${fmt(Date.now() - session.t0)})` : '⏺ Record'
  $('#recBtn').classList.toggle('on', !!session)
  $('#markBtn').classList.toggle('hidden', !parts.length)
  if (session) {
    $('#recInfo').textContent = `Recording ${fmt(Date.now() - session.t0)} · ${session.recs.size} feeds + program`
  } else $('#recInfo').textContent = 'Not recording'
  const hqOn = hq.active
  $('#hqBadge').classList.toggle('hidden', !hqOn)
  $('#hqBadge').textContent = hqOn ? '● Full-quality local copy' : ''
}

function addMarker() {
  const label = 'Marker ' + new Date().toLocaleTimeString()
  if (session) { session.log.add('marker', {label, by: me.name}); toast('🚩 Marker added') }
  const recs = liveRecs()
  for (const r of recs) A.marker.send({label}, {target: r.peerId})
  if (recs.length && !session) toast('🚩 Marker sent to recorder')
}

// ======================= call hooks (see joinCall) =======================
const logState = (pid, {name, mic, cam}) => session?.log.add('state', {pid, name, mic, cam})
const callHooks = {
  joined(room) {
    A.rec = room.makeAction('rec')
    A.marker = room.makeAction('marker')
    A.hqPlan = room.makeAction('hqPlan')
    A.clock = room.makeAction('clock', {kind: 'request', onRequest: () => Date.now()})
    A.hq = room.makeAction('hq', {kind: 'request', onRequest: onHQChunk})
    A.marker.onMessage = (d, {peerId}) => { if (session) { session.log.add('marker', {label: d.label, by: peers.get(peerId)?.name}); toast(`🚩 Marker from ${peers.get(peerId)?.name}`) } }
    A.rec.onMessage = onRecMessage
    A.hqPlan.onMessage = onHQPlan
  },
  peerJoined(peerId) {
    if (session) A.rec.send({on: true, recId: session.recId, name: me.name}, {target: peerId})
  },
  peerHello(peerId, d, first, changed) {
    if (!session) return
    if (first) { session.log.add('peer-join', {pid: d.pid, name: d.name}); clockSync(session, peerId) }
    if (first || changed) logState(d.pid, d)
  },
  peerLeft(peerId, p) {
    if (p?.helloed) session?.log.add('peer-leave', {pid: p.pid, name: p.name})
    for (const r of hq.recs.values()) if (r.peerId === peerId) {
      if (r.live) { r.live = false; r.stop = Date.now() }
      r.gone = true
    }
    for (const s of sessions.values()) { const inc = s.incoming.get(peerId); if (inc && !inc.done) { inc.failed = true; updateIncomingUI() } }
    hqUpdate(); updateRecUI()
  },
  feedAdded(f) {
    if (session) startFeedRec(f)
    if (f.local) hqStartSeg(f)
  },
  feedRemoved(f) {
    if (session) stopFeedRec(session, f.key)
    if (f.local) hqStopSeg(f.key)
  },
  stateChanged: () => logState(PID, me),
  layoutChanged: layout => session?.log.add('layout', {layout})
}
function onRecMessage(d, {peerId}) {
  if (d.on) {
    hq.recs.set(d.recId, {peerId, name: d.name, start: Date.now(), live: true})
    toast(`⏺ ${d.name} started recording`)
  } else {
    const r = hq.recs.get(d.recId); if (r) { r.live = false; r.stop = Date.now() }
    toast(`${d.name} stopped recording`)
    hqUpdate().then(() => offerHQ(d.recId))
  }
  hqUpdate(); updateRecUI()
}
function onHQPlan(d, {peerId}) {
  const s = sessions.get(d.recId); if (!s) return
  const name = peers.get(peerId)?.name
  if (d.deciding) { if (!s.incoming.has(peerId)) s.incoming.set(peerId, {name, bytes: 0, got: 0, done: false, deciding: true}) }
  else {
    s.incoming.set(peerId, {name, bytes: d.bytes, got: 0, done: d.bytes === 0, declined: d.bytes === 0})
    if (d.bytes) toast(`Receiving full-quality files from ${name} (${fmtMB(d.bytes)})`)
  }
  updateIncomingUI()
}

// ======================= receiving full-quality files (recorder side) =======================
async function onHQChunk(data, {peerId, metadata: m}) {
  const s = sessions.get(m?.recId); if (!s) return {ok: false, err: 'unknown session'}
  let f = s.inFiles.get(m.fileId)
  if (!f) { f = {w: await fileWriter(s.dir, m.info.file), info: m.info, pid: m.pid}; s.inFiles.set(m.fileId, f) }
  await f.w.write(new Blob([data]))
  const inc = s.incoming.get(peerId); if (inc) { inc.got += data.byteLength ?? data.size; updateIncomingUI() }
  if (m.last) {
    await f.w.close()
    const off = s.offsets[m.pid] || 0
    s.log.add('hq-file', {key: m.info.key, pid: m.pid, name: m.info.name, kind: m.info.kind, file: m.info.file, start: Math.round(m.info.start - off), end: Math.round(m.info.end - off), source: 'hq'})
    await s.log.flush()
    if (m.final && inc) { inc.done = true; updateIncomingUI(); toast(`✅ Received full-quality files from ${inc.name}`) }
  }
  return {ok: true}
}
function updateIncomingUI() {
  const bg = modal.current
  if (bg?.dataset.kind === 'incoming') bg.querySelector('.incBody').replaceWith(incomingBody())
}
function incomingBody() {
  const rows = []
  for (const s of sessions.values()) for (const [, inc] of s.incoming) {
    rows.push(h('div', {class: 'row'}, h('span', {style: 'width:110px'}, inc.name),
      inc.declined ? h('span', {class: 'dim'}, 'declined') : inc.deciding ? h('span', {class: 'dim'}, 'deciding…') : inc.failed ? h('span', {style: 'color:var(--red)'}, 'disconnected') :
        h('progress', {max: inc.bytes || 1, value: inc.got, style: 'flex:1'}), inc.done && !inc.declined ? '✅' : ''))
  }
  return h('div', {class: 'incBody'}, rows.length ? rows : h('p', {class: 'dim'}, 'Waiting for participants to decide whether to send full-quality files…'))
}

// ======================= full-quality local copy (participant side) =======================
const hq = {active: false, segs: [], cur: new Map(), recs: new Map(), dir: null}
const hqDir = async () => hq.dir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle('hq', {create: true})
const liveRecs = () => [...hq.recs.values()].filter(r => r.live)
const hqWanted = () => settings.hq !== 'never' && liveRecs().length > 0
async function hqSaveManifest() {
  try {
    const w = await (await (await hqDir()).getFileHandle('manifest.json', {create: true})).createWritable()
    await w.write(JSON.stringify({pid: PID, name: me.name, segs: hq.segs.filter(s => s.end).map(({id, key, pid, kind, name, file, start, end, sentTo}) => ({id, key, pid, kind, name, file, start, end, sentTo: [...sentTo]}))}))
    await w.close()
  } catch (e) { console.warn(e) }
}
async function hqUpdate() {
  if (hqWanted() && !hq.active) { hq.active = true; for (const f of feeds.values()) if (f.local) hqStartSeg(f) }
  else if (!hqWanted() && hq.active) { hq.active = false; await Promise.all([...hq.cur.keys()].map(hqStopSeg)) }
  updateRecUI()
}
function hqStartSeg(f) {
  if (!hq.active || hq.cur.has(f.key)) return
  const seg = {id: rid(), key: f.key, pid: PID, kind: f.kind, name: me.name, file: `hq-${slug(me.name)}-${f.kind}-${PID}-${hq.segs.length + 1}.${EXT}`, start: null, end: null, sentTo: new Set()}
  hq.segs.push(seg)
  const p = (async () => {
    const w = await fileWriter(await hqDir(), seg.file)
    seg.rec = recordStream(f.stream, w, {vbr: f.kind === 'screen' ? 6e6 : 8e6, mime: FEED_MIME})
    seg.start = await seg.rec.started
  })()
  hq.cur.set(f.key, {seg, p})
}
async function hqStopSeg(key) {
  const c = hq.cur.get(key); if (!c) return
  hq.cur.delete(key); await c.p
  c.seg.end = await c.seg.rec.stop(); c.seg.size = c.seg.rec.writer.bytes
  await hqSaveManifest()
}
function hqPendingFor(recId) {
  const r = hq.recs.get(recId); if (!r) return []
  return hq.segs.filter(s => s.end && !s.sentTo.has(recId) && s.end > r.start && s.start < (r.stop || Infinity))
}
const offering = new Set()
async function offerHQ(recId) {
  const r = hq.recs.get(recId)
  if (!r || r.gone || settings.hq === 'never' || offering.has(recId)) return
  const segs = hqPendingFor(recId); if (!segs.length) return
  offering.add(recId)
  A.hqPlan.send({recId, deciding: true}, {target: r.peerId})
  const bytes = segs.reduce((a, s) => a + (s.size || 0), 0)
  let ok = settings.hq === 'always'
  if (!ok) ok = await modal('Send full-quality recording?', `${r.name} stopped recording. Send them your full-quality local copy (${segs.length} file${segs.length > 1 ? 's' : ''}, ${fmtMB(bytes)}) so their final video uses it instead of what came over the call?`, [['Not now', false], ['Send', true, 'primary']])
  if (!ok) { A.hqPlan.send({recId, bytes: 0}, {target: r.peerId}); offering.delete(recId); return }
  await sendHQ(recId, segs, bytes)
  offering.delete(recId)
}
async function sendHQ(recId, segs, bytes) {
  const r = hq.recs.get(recId)
  A.hqPlan.send({recId, bytes}, {target: r.peerId})
  const bar = h('progress', {max: bytes || 1, value: 0, style: 'width:180px'})
  const t = toast(`Sending full-quality files to ${r.name}…`, 0, bar)
  let sent = 0
  try {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const file = await (await (await hqDir()).getFileHandle(seg.file)).getFile()
      const fileId = rid(), total = Math.max(1, Math.ceil(file.size / CHUNK))
      for (let c = 0; c < total; c++) {
        const buf = await file.slice(c * CHUNK, (c + 1) * CHUNK).arrayBuffer()
        const last = c === total - 1
        const md = {recId, fileId, pid: PID, seq: c, last, final: last && i === segs.length - 1, info: {key: seg.key, kind: seg.kind, name: seg.name, file: seg.file, start: seg.start, end: seg.end}}
        let tries = 0
        while (true) {
          try { const res = await A.hq.request(buf, {target: r.peerId, metadata: md, timeoutMs: 60000}); if (res?.ok) break; throw new Error(res?.err || 'rejected') }
          catch (e) { if (++tries >= 3 || !peers.has(r.peerId)) throw e; await sleep(1000) }
        }
        sent += buf.byteLength; bar.value = sent
      }
      seg.sentTo.add(recId)
    }
    await hqSaveManifest()
    t.remove(); toast(`✅ Sent full-quality files to ${r.name}`)
    return true
  } catch (e) {
    t.remove(); toast(`Sending to ${r.name} failed: ${e.message}. Your files are kept; you can save them to a folder when you leave.`, 9000)
    return false
  }
}
async function saveHQToFolder(segs) {
  let dir
  try { dir = await window.showDirectoryPicker({id: 'p2pstudio-hq', mode: 'readwrite'}) } catch { return false }
  const src = await hqDir()
  const t = toast('Saving full-quality files…', 0)
  for (const s of segs) {
    const f = await (await src.getFileHandle(s.file)).getFile()
    const w = await (await dir.getFileHandle(s.file, {create: true})).createWritable()
    await f.stream().pipeTo(w)
  }
  const mf = await (await dir.getFileHandle(`hq-manifest-${slug(me.name)}-${PID}.json`, {create: true})).createWritable()
  await mf.write(JSON.stringify({pid: segs[0]?.pid || PID, name: segs[0]?.name || me.name, segs: segs.map(({key, kind, name, file, start, end}) => ({key, kind, name, file, start, end}))}, null, 1)); await mf.close()
  t.remove(); toast('Saved. Give these files to whoever recorded, and have them drop the files into their session folder. The editor picks them up automatically.', 10000)
  return true
}
async function clearHQ(segs) {
  const d = await hqDir(), ids = new Set(segs.map(s => s.id))
  for (const s of segs) await d.removeEntry(s.file).catch(() => {})
  hq.segs = hq.segs.filter(s => !ids.has(s.id)); await hqSaveManifest()
}
// unsent full-quality files from an earlier call in this browser
async function checkLeftovers() {
  try {
    const mf = JSON.parse(await (await (await (await hqDir()).getFileHandle('manifest.json')).getFile()).text())
    hq.segs = (mf.segs || []).map(s => ({pid: mf.pid, ...s, sentTo: new Set(s.sentTo)}))
  } catch { return }
  const segs = hq.segs.filter(s => !s.sentTo.size)
  if (!segs.length) return
  const box = $('#leftoverHQ'), done = () => box.classList.add('hidden')
  box.classList.remove('hidden')
  box.replaceChildren(h('hr'), h('div', {}, `⚠️ ${segs.length} unsent full-quality file(s) from an earlier call.`),
    h('div', {class: 'row'},
      h('button', {onclick: async () => { if (await saveHQToFolder(segs)) { await clearHQ(segs); done() } }}, 'Save to folder…'),
      h('button', {onclick: async () => { await clearHQ(segs); done() }}, 'Delete')))
}

// ======================= leaving =======================
// false if the user cancelled
async function stopRecordingForLeave() {
  if (!session) return true
  if (!await modal('Stop recording and leave?', 'Your recording will be finalized first.', [['Cancel', false], ['Stop & leave', true, 'danger']])) return false
  await stopRecording()
  return true
}
const pendingIncoming = () => [...sessions.values()].some(s => [...s.incoming.values()].some(i => !i.done && !i.failed))
// offer/send full-quality copies, then wait for incoming transfers
async function finishTransfers() {
  for (const r of hq.recs.values()) if (r.live) { r.live = false; r.stop = Date.now() }
  await hqUpdate()
  // participant: send full-quality copies
  for (const [recId, r] of hq.recs) {
    if (r.gone || !peers.has(r.peerId)) continue
    await offerHQ(recId)
  }
  // anything unsent left over?
  const unsent = hq.segs.filter(s => s.end && !s.sentTo.size)
  if (unsent.length && settings.hq !== 'never') {
    const c = await modal('Unsent full-quality files', `You have ${unsent.length} full-quality file(s) that weren't sent to anyone.`, [['Delete them', 'del'], ['Keep for later', 'keep'], ['Save to folder…', 'save', 'primary']])
    if (c === 'save') { if (await saveHQToFolder(unsent)) await clearHQ(unsent) } else if (c === 'del') await clearHQ(unsent)
  }
  const sent = hq.segs.filter(s => s.end && s.sentTo.size); if (sent.length) await clearHQ(sent)
  // recorder: wait for incoming transfers
  if (sessions.size) await sleep(1500) // give participants a moment to announce transfers
  if (pendingIncoming()) {
    const p = modal('Receiving full-quality files…', incomingBody(), [['Leave anyway', 'leave', 'danger']])
    modal.current.dataset.kind = 'incoming'
    const iv = setInterval(() => { if (!pendingIncoming()) modal.current?.close('done') }, 500)
    await p; clearInterval(iv)
  }
}
const flushLogs = () => Promise.all([...sessions.values()].map(s => s.log.flush()))
addEventListener('beforeunload', e => {
  if (session || offering.size || pendingIncoming()) { e.preventDefault(); e.returnValue = '' }
})

export {session, pickRoot, startRecording, stopRecording, addMarker, callHooks, hqUpdate, checkLeftovers, stopRecordingForLeave, finishTransfers, flushLogs}
