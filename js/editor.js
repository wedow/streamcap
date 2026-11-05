import {EXT, PW, PH} from './config.js'
import {$, h, fmt, fmtMB, stamp, sleep, ensurePerm, toast, tickers, fileWriter, recordStream} from './util.js'
import {ac, resumeAudio, stopLocalDevices} from './media.js'
import {LAYOUT_MODES, defaultLayout, composite, layoutControls} from './layout.js'

const ed = {open: false, t: 0, playing: false, segs: [], keys: new Map(), kfs: [], cuts: [], markers: [], states: {}, names: {}, inPt: null, rendering: null}
ed.canvas = $('#edCanvas'); ed.ctx = ed.canvas.getContext('2d')
ed.monitor = ac.createGain(); ed.monitor.connect(ac.destination)
ed.dest = ac.createMediaStreamDestination()

async function openEditor(dir) {
  resumeAudio()
  if (!dir) { try { dir = await window.showDirectoryPicker({id: 'p2pstudio', mode: 'readwrite'}) } catch { return } }
  if (!await ensurePerm(dir).catch(() => false)) return toast('Need read/write permission on the session folder')
  let text
  try { text = await (await (await dir.getFileHandle('events.jsonl')).getFile()).text() }
  catch { return toast('That folder has no events.jsonl. Pick a session folder (one per recording).', 7000) }
  const evs = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const startEv = evs.find(e => e.type === 'session-start'); if (!startEv) return toast('No session-start in events.jsonl')
  const start = startEv.t
  const stopEv = evs.find(e => e.type === 'session-stop')
  const end = stopEv?.t ?? Math.max(...evs.map(e => e.t))
  Object.assign(ed, {dir, start, dur: end - start, segs: [], keys: new Map(), kfs: [], cuts: [], markers: [], states: {}, names: {}, t: 0, playing: false, inPt: null, offsets: {}})
  for (const e of evs) {
    const rel = e.t - start
    if (e.name && e.pid) ed.names[e.pid] = e.name
    if (e.type === 'state') (ed.states[e.pid] ??= []).push({t: rel, mic: e.mic, cam: e.cam})
    else if (e.type === 'layout') ed.kfs.push({t: Math.max(0, rel), layout: e.layout})
    else if (e.type === 'marker') ed.markers.push({t: rel, label: e.label, by: e.by})
    else if (e.type === 'clock') ed.offsets[e.pid] = e.offset
    else if (e.type === 'feed-start') ed.segs.push({key: e.key, pid: e.pid, kind: e.kind, file: e.file, rs: rel, re: ed.dur, hq: e.source === 'local'})
    else if (e.type === 'feed-stop') { const s = ed.segs.find(s => s.file === e.file); if (s) s.re = e.t - start }
    else if (e.type === 'hq-file') ed.segs.push({key: e.key, pid: e.pid, kind: e.kind, file: e.file, rs: e.start - start, re: e.end - start, hq: true})
  }
  // full-quality files someone saved manually and dropped into this folder
  for await (const [name, hd] of dir.entries()) {
    if (!name.startsWith('hq-manifest') || !name.endsWith('.json')) continue
    try {
      const mf = JSON.parse(await (await hd.getFile()).text()), off = ed.offsets[mf.pid] || 0
      for (const s of mf.segs) if (!ed.segs.some(x => x.file === s.file)) ed.segs.push({key: s.key, pid: mf.pid, kind: s.kind, file: s.file, rs: s.start - off - start, re: s.end - off - start, hq: true})
      if (mf.name) ed.names[mf.pid] ??= mf.name
    } catch (e) { console.warn('manifest', name, e) }
  }
  for (const s of ed.segs) {
    if (!ed.keys.has(s.key)) ed.keys.set(s.key, {key: s.key, pid: s.pid, kind: s.kind})
    try {
      const file = await (await dir.getFileHandle(s.file)).getFile()
      const v = h('video', {playsinline: true, preload: 'auto'}); v.src = URL.createObjectURL(file)
      s.el = v; s.gain = ac.createGain()
      ac.createMediaElementSource(v).connect(s.gain); s.gain.connect(ed.monitor); s.gain.connect(ed.dest)
    } catch { s.missing = true }
  }
  if (!ed.kfs.length) ed.kfs.push({t: 0, layout: defaultLayout()})
  ed.kfs.sort((a, b) => a.t - b.t); ed.kfs[0].t = 0
  // saved edits
  try {
    const saved = JSON.parse(await (await (await dir.getFileHandle('edits.json')).getFile()).text())
    if (saved.kfs?.length) ed.kfs = saved.kfs
    if (saved.cuts) ed.cuts = saved.cuts
    if (saved.preferHQ != null) $('#edPreferHQ').checked = saved.preferHQ
    toast('Loaded your saved edits')
  } catch {}
  ed.open = true
  $('#lobby').classList.add('hidden'); $('#editor').classList.remove('hidden')
  $('#edTitle').textContent = dir.name
  const nHQ = ed.segs.filter(s => s.hq && !s.missing).length
  $('#edInfo').textContent = ` · ${fmt(ed.dur)} · ${ed.keys.size} feeds · ${nHQ} full-quality / ${ed.segs.length - nHQ} live-received files`
  stopLocalDevices()
  renderTimeline(); edLayoutCtl.render(); renderLists(); edSeek(0)
}
const keyName = k => (ed.names[k.pid] || 'Guest') + (k.kind === 'screen' ? ' (screen)' : '')
const layoutAt = t => { let L = ed.kfs[0] || {t: 0, layout: defaultLayout()}; for (const k of ed.kfs) if (k.t <= t) L = k; return L }
const stateAt = (pid, t) => { let s = {mic: true, cam: true}; for (const x of ed.states[pid] || []) if (x.t <= t) s = x; return s }
const cutAt = t => ed.cuts.find(c => t >= c.s && t < c.e)
function activeSegs(t) {
  const m = new Map(), pref = $('#edPreferHQ').checked
  for (const s of ed.segs) {
    if (s.missing || t < s.rs || t >= s.re) continue
    const cur = m.get(s.key)
    if (!cur || (pref && s.hq && !cur.hq) || (!pref && !s.hq && cur.hq)) m.set(s.key, s)
  }
  return m
}
function edSync() {
  const act = new Set(activeSegs(ed.t).values())
  let stalled = false
  for (const s of ed.segs) {
    if (!s.el) continue
    const v = s.el
    if (!act.has(s)) { if (!v.paused) v.pause(); s.gain.gain.value = 0; continue }
    s.gain.gain.value = 1
    const want = (ed.t - s.rs) / 1000
    const dur = isFinite(v.duration) ? v.duration : Infinity
    if (want >= dur - 0.05) { if (!v.paused) v.pause(); continue }
    const drift = v.currentTime - want
    if (Math.abs(drift) > 0.5 || (!ed.playing && Math.abs(drift) > 0.04)) { if (!v.seeking || Math.abs(drift) > 1) v.currentTime = want }
    else v.playbackRate = ed.playing ? Math.min(1.1, Math.max(0.9, 1 - drift * 0.5)) : 1
    if (ed.playing && v.paused) v.play().catch(() => {})
    if (!ed.playing && !v.paused) v.pause()
    if (ed.playing && (v.seeking || v.readyState < 3)) stalled = true
  }
  return stalled
}
function edItems(t) {
  return [...activeSegs(t).values()].map(s => ({key: s.key, name: keyName(s), kind: s.kind, el: s.el,
    camOff: s.kind === 'cam' && stateAt(s.pid, t).cam === false, micOff: s.kind === 'cam' && stateAt(s.pid, t).mic === false}))
}
let edLast = performance.now(), edUiAt = 0
tickers.add(() => {
  if (!ed.open) return
  const now = performance.now(), dt = now - edLast; edLast = now
  const stalled = edSync()
  const R = ed.rendering
  if (R) {
    if (stalled && R.rec.mr.state === 'recording') R.rec.mr.pause()
    if (!stalled && R.rec.mr.state === 'paused') R.rec.mr.resume()
  }
  if (ed.playing && !stalled) {
    ed.t += Math.min(dt, 200)
    const c = cutAt(ed.t); if (c) { ed.t = c.e; if (R) R.rec.mr.state === 'recording' && R.rec.mr.pause() }
    if (ed.t >= ed.dur) { ed.t = ed.dur; edPause(); if (R) finishRender() }
    if (R) R.done += Math.min(dt, 200)
  }
  composite(ed.ctx, PW, PH, layoutAt(ed.t).layout, edItems(ed.t))
  if (now - edUiAt > 100) { edUiAt = now; updatePlayhead() }
})
function edPlay() { if (ed.t >= ed.dur - 50) edSeek(0); ed.playing = true; $('#edPlay').textContent = '⏸' }
function edPause() { ed.playing = false; $('#edPlay').textContent = '▶' }
function edSeek(t) { ed.t = Math.max(0, Math.min(ed.dur, t)); edSync(); updatePlayhead(); edLayoutCtl.render() }
const pct = t => (t / ed.dur * 100) + '%'
function renderTimeline() {
  const tracks = $('#tlTracks'); tracks.innerHTML = ''
  for (const k of ed.keys.values()) {
    const row = h('div', {class: 'trk'}, h('div', {class: 'lbl', title: keyName(k)}, keyName(k)))
    for (const s of ed.segs.filter(s => s.key === k.key)) row.append(h('div', {class: `seg${s.hq ? ' hq' : ''}${s.missing ? ' missing' : ''}`, title: s.file + (s.missing ? ' (file missing)' : ''), style: `left:${pct(s.rs)};width:${pct(s.re - s.rs)};${s.hq ? 'top:2px;bottom:11px' : 'top:11px;bottom:2px'}`}))
    tracks.append(row)
  }
  const ru = $('#tlRuler'); ru.innerHTML = ''
  const step = [10, 30, 60, 120, 300, 600, 900, 1800].map(x => x * 1000).find(x => ed.dur / x <= 10) || 3600000
  for (let t = 0; t <= ed.dur; t += step) ru.append(h('span', {style: `left:${pct(t)}`}, fmt(t)))
  renderOverlay()
}
function renderOverlay() {
  const o = $('#tlOver'); o.innerHTML = ''
  for (const c of ed.cuts) o.append(h('div', {class: 'cut', style: `left:${pct(c.s)};width:${pct(c.e - c.s)}`}))
  for (const m of ed.markers) o.append(h('div', {class: 'mk', title: m.label, style: `left:${pct(m.t)}`}))
  for (const k of ed.kfs) o.append(h('div', {class: 'kf', style: `left:${pct(k.t)}`}))
  if (ed.inPt != null) o.append(h('div', {class: 'inpt', style: `left:${pct(ed.inPt)}`}))
  o.append(ed.ph = h('div', {class: 'ph'}))
  updatePlayhead()
}
function updatePlayhead() {
  if (ed.ph) ed.ph.style.left = pct(ed.t)
  const kept = ed.dur - ed.cuts.reduce((a, c) => a + c.e - c.s, 0)
  $('#edTime').textContent = `${fmt(ed.t)} / ${fmt(ed.dur)}  (final length ${fmt(kept)})`
  if (ed.rendering) {
    const R = ed.rendering; $('#edProg').value = Math.min(1, R.done / kept)
    $('#edGenTxt').textContent = `Rendering ${fmt(R.done)} / ${fmt(kept)} · ${fmtMB(R.rec.writer.bytes)}`
  }
}
$('#tl').addEventListener('pointerdown', e => {
  if (ed.rendering) return
  const r = $('#tlTracks').getBoundingClientRect()
  const go = ev => edSeek((ev.clientX - r.left) / r.width * ed.dur)
  go(e)
  const mv = ev => go(ev), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); edLayoutCtl.render() }
  addEventListener('pointermove', mv); addEventListener('pointerup', up)
})
function addCut(s, e) {
  if (e - s < 100) return
  const cuts = [...ed.cuts, {s: Math.max(0, s), e: Math.min(ed.dur, e)}].sort((a, b) => a.s - b.s), merged = []
  for (const c of cuts) { const l = merged.at(-1); if (l && c.s <= l.e) l.e = Math.max(l.e, c.e); else merged.push({...c}) }
  ed.cuts = merged; edChanged()
}
function edChanged() { renderOverlay(); renderLists(); saveEdits() }
let saveT
function saveEdits() {
  clearTimeout(saveT)
  saveT = setTimeout(async () => {
    try { const w = await (await ed.dir.getFileHandle('edits.json', {create: true})).createWritable(); await w.write(JSON.stringify({kfs: ed.kfs, cuts: ed.cuts, preferHQ: $('#edPreferHQ').checked}, null, 1)); await w.close() }
    catch (e) { console.warn('save edits', e) }
  }, 600)
}
function renderLists() {
  const kl = $('#edKfs'); kl.innerHTML = ''
  ed.kfs.forEach((k, i) => kl.append(h('li', {}, h('span', {onclick: () => edSeek(k.t)}, `◆ ${fmt(k.t)}: ${LAYOUT_MODES.find(m => m[0] === k.layout.mode)?.[1]}`),
    i ? h('button', {title: 'Remove', onclick: () => { ed.kfs.splice(i, 1); edChanged(); edLayoutCtl.render() }}, '×') : null)))
  const cl = $('#edCuts'); cl.innerHTML = ''
  if (!ed.cuts.length) cl.append(h('li', {class: 'dim'}, 'None. Use Mark in / Mark out, or the trim buttons.'))
  ed.cuts.forEach((c, i) => cl.append(h('li', {}, h('span', {onclick: () => edSeek(Math.max(0, c.s - 3000))}, `✂ ${fmt(c.s)} → ${fmt(c.e)} (${fmt(c.e - c.s)})`), h('button', {title: 'Remove cut', onclick: () => { ed.cuts.splice(i, 1); edChanged() }}, '×'))))
  const ml = $('#edMarks'); ml.innerHTML = ''
  if (!ed.markers.length) ml.append(h('li', {class: 'dim'}, 'None. Press K or 🚩 during a call to drop one.'))
  ed.markers.forEach(m => ml.append(h('li', {}, h('span', {onclick: () => edSeek(Math.max(0, m.t - 5000))}, `🚩 ${fmt(m.t)} ${m.by ? '· ' + m.by : ''}`))))
}
const edLayoutCtl = layoutControls($('#edLayout'), () => layoutAt(ed.t).layout, L => {
  const ex = ed.kfs.find(k => Math.abs(k.t - ed.t) < 300)
  if (ex) ex.layout = L; else { ed.kfs.push({t: ed.t, layout: L}); ed.kfs.sort((a, b) => a.t - b.t) }
  edChanged(); edLayoutCtl.render()
}, () => [...ed.keys.values()].map(k => ({key: k.key, kind: k.kind, name: keyName(k), present: activeSegs(ed.t).has(k.key)})))

async function startRender() {
  if (ed.rendering) return
  const name = `final-${stamp()}.${EXT}`
  const w = await fileWriter(ed.dir, name)
  edPause(); ed.t = 0; const c = cutAt(0); if (c) ed.t = c.e
  ed.monitor.gain.value = $('#edMonitor').checked ? 1 : 0
  const vt = ed.canvas.captureStream(30).getVideoTracks()[0]
  const rec = recordStream(new MediaStream([vt, ed.dest.stream.getAudioTracks()[0]]), w, {vbr: 10e6})
  rec.mr.pause()
  ed.rendering = {rec, name, done: 0, vt}
  $('#edGenInfo').classList.remove('hidden'); $('#edGen').disabled = true
  await sleep(300); edPlay()
}
async function finishRender(cancel) {
  const R = ed.rendering; if (!R) return
  ed.rendering = null; edPause()
  if (R.rec.mr.state === 'paused') R.rec.mr.resume()
  await R.rec.stop(); R.vt.stop()
  ed.monitor.gain.value = 1
  $('#edGenInfo').classList.add('hidden'); $('#edGen').disabled = false
  if (cancel) { await ed.dir.removeEntry(R.name).catch(() => {}); toast('Render cancelled') }
  else toast(`✅ Saved ${R.name} (${fmtMB(R.rec.writer.bytes)}) in the session folder`, 10000)
}
$('#edGen').onclick = startRender
$('#edCancel').onclick = () => finishRender(true)
$('#edPlay').onclick = () => ed.playing ? edPause() : edPlay()
$('#edBack5').onclick = () => edSeek(ed.t - 5000)
$('#edFwd5').onclick = () => edSeek(ed.t + 5000)
$('#edIn').onclick = () => { ed.inPt = ed.t; renderOverlay() }
$('#edOut').onclick = () => { if (ed.inPt == null) return toast('Set “Mark in” first'); addCut(Math.min(ed.inPt, ed.t), Math.max(ed.inPt, ed.t)); ed.inPt = null; renderOverlay() }
$('#edTrimStart').onclick = () => addCut(0, ed.t)
$('#edTrimEnd').onclick = () => addCut(ed.t, ed.dur)
$('#edApplyAll').onclick = () => { ed.kfs = [{t: 0, layout: layoutAt(ed.t).layout}]; edChanged(); edLayoutCtl.render() }
$('#edPreferHQ').onchange = () => { saveEdits(); edSync() }
$('#edBack').onclick = () => { if (ed.rendering) return toast('Cancel the render first'); location.href = location.pathname }

export {ed, openEditor, edPlay, edPause, edSeek}
