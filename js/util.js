import {MIME} from './config.js'

const $ = s => document.querySelector(s)
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'class') e.className = v
    else if (v === true) e.setAttribute(k, '')
    else if (v !== false && v != null) e.setAttribute(k, v)
  }
  for (const k of kids.flat()) if (k != null) e.append(k)
  return e
}
const mkCanvas = (w, hh) => Object.assign(document.createElement('canvas'), {width: w, height: hh})
const pad2 = n => String(n).padStart(2, '0')
function fmt(ms) {
  const s = Math.floor(Math.max(0, ms | 0) / 1000), hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60
  return (hh ? hh + ':' + pad2(m) : m) + ':' + pad2(s % 60)
}
const fmtMB = b => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB'
const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guest'
function stamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`
}
const rid = () => crypto.randomUUID().slice(0, 8)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
const LS = {
  get(k, d) { try { const v = localStorage.getItem('p2ps.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('p2ps.' + k, JSON.stringify(v)) } catch {} }
}
// participant id: stable across reloads of this tab
const PID = (() => {
  try {
    let p = sessionStorage.getItem('p2ps.pid')
    if (!p) { p = rid(); sessionStorage.setItem('p2ps.pid', p) }
    return p
  } catch { return rid() }
})()
const idb = (() => {
  let dbp
  const db = () => dbp ??= new Promise((res, rej) => { const r = indexedDB.open('p2pstudio', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  return {
    async get(k) { try { const d = await db(); return await new Promise(r => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r() }) } catch {} },
    async set(k, v) { try { const d = await db(); await new Promise(r => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = r; tx.onerror = r }) } catch {} }
  }
})()
async function ensurePerm(hd) {
  if (!hd) return false
  if (await hd.queryPermission({mode: 'readwrite'}) === 'granted') return true
  return await hd.requestPermission({mode: 'readwrite'}) === 'granted'
}
function toast(msg, ms = 4000, ...extra) {
  const t = h('div', {class: 'toast'}, h('span', {}, msg), ...extra)
  $('#toasts').append(t); if (ms) setTimeout(() => t.remove(), ms); return t
}
function modal(title, body, buttons) { // buttons: [[label, value, cls]]
  return new Promise(res => {
    const bg = h('div', {class: 'modalBg'})
    const close = v => { bg.remove(); res(v) }
    const m = h('div', {class: 'modal'}, h('h3', {}, title), typeof body === 'string' ? h('p', {}, body) : body,
      h('div', {class: 'row', style: 'justify-content:flex-end;margin-top:14px'}, buttons.map(([l, v, c]) => h('button', {class: c || '', onclick: () => close(v)}, l))))
    bg.append(m); document.body.append(bg); bg.close = close
    modal.current = bg
  })
}
// frame clock that keeps running in background tabs (main-thread timers get throttled).
// Self-pacing: the worker only schedules the next tick after the page finished the last
// one, so a slow machine drops frames instead of building an ever-growing backlog.
const ticker = new Worker(URL.createObjectURL(new Blob([`
  const P = 1000 / 30; let last = 0
  const fire = () => { last = performance.now(); postMessage(0) }
  onmessage = () => setTimeout(fire, Math.max(0, P - (performance.now() - last)))
  fire()`])))
const tickers = new Set()
const stats = window.__studioStats = {frameMs: 0}
ticker.onmessage = () => {
  const t = performance.now()
  for (const f of tickers) { try { f() } catch (e) { console.error(e) } }
  stats.frameMs = stats.frameMs * 0.9 + (performance.now() - t) * 0.1
  ticker.postMessage(0)
}

// files
async function fileWriter(dir, name) {
  const fh = await dir.getFileHandle(name, {create: true})
  const w = await fh.createWritable()
  let chain = Promise.resolve(), bytes = 0, error = null
  const fail = e => {
    if (error) return
    error = e; console.error('write failed', name, e)
    toast(`Writing “${name}” failed: ${e.message}`, 0)
  }
  return {
    name, fh, get bytes() { return bytes }, get error() { return error },
    write(data) {
      const n = data.size ?? data.byteLength
      chain = chain.then(() => error || w.write(data).then(() => { bytes += n }, fail))
      return chain
    },
    async close() { await chain; await w.close().catch(fail) }
  }
}
function recordStream(stream, writer, opts = {}) {
  const mr = new MediaRecorder(stream, {mimeType: opts.mime || MIME, videoBitsPerSecond: opts.vbr || 4e6, audioBitsPerSecond: 160000})
  let startedAt = null, stopping
  const started = new Promise(r => mr.addEventListener('start', () => { startedAt = Date.now(); r(startedAt) }))
  const stopped = new Promise(r => mr.addEventListener('stop', r))
  const stop = () => stopping ??= (async () => {
    if (mr.state !== 'inactive') mr.stop()
    await stopped; await writer.close()
    return Date.now()
  })()
  mr.ondataavailable = e => {
    if (writer.error) stop()
    else if (e.data.size) writer.write(e.data)
  }
  mr.onerror = e => { console.warn('MediaRecorder error', e.error || e); opts.onerror?.(e) }
  mr.start(1000)
  return {mr, writer, started, stop, get startedAt() { return startedAt }}
}
class EventLog {
  constructor(dir) { this.dir = dir; this.lines = []; this.dirty = false; this.chain = Promise.resolve(); this.iv = setInterval(() => this.flush(), 2000) }
  add(type, data = {}) { const e = {t: Date.now(), type, ...data}; this.lines.push(JSON.stringify(e)); this.dirty = true; return e }
  // queued after any in-flight write, so it always covers lines added before the call
  flush() {
    return this.chain = this.chain.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      try { const w = await (await this.dir.getFileHandle('events.jsonl', {create: true})).createWritable(); await w.write(this.lines.join('\n') + '\n'); await w.close() }
      catch (e) { this.dirty = true; console.error('events flush', e) }
    })
  }
}

export {$, h, mkCanvas, fmt, fmtMB, slug, stamp, rid, sleep, initials, LS, PID, idb, ensurePerm, toast, modal, tickers, fileWriter, recordStream, EventLog}
