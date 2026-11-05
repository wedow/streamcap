import {MP_URL, MP_WASM, MP_MODEL, CW, CH} from './config.js'
import {$, h, mkCanvas, LS, toast, tickers} from './util.js'

const ac = new AudioContext()
const resumeAudio = () => ac.state !== 'running' && ac.resume()
addEventListener('pointerdown', resumeAudio, true); addEventListener('keydown', resumeAudio, true)

// ======================= local media =======================
const settings = {camId: LS.get('camId', ''), micId: LS.get('micId', ''), blur: +LS.get('blur', 0), hq: LS.get('hqMode', 'ask')}
const me = {name: LS.get('name', ''), mic: true, cam: true}

// camera goes through a canvas so the outgoing/recorded track never changes
// (device switches and blur toggles happen underneath it)
const cam = {raw: null, src: h('video', {muted: true, playsinline: true, autoplay: true}), out: mkCanvas(CW, CH), frame: mkCanvas(CW, CH), small: mkCanvas(320, 180), mask: mkCanvas(320, 180), tmp: mkCanvas(CW, CH), seg: null, segP: null}
cam.src.muted = true
cam.o = cam.out.getContext('2d'); cam.f = cam.frame.getContext('2d'); cam.s = cam.small.getContext('2d', {willReadFrequently: true}); cam.m = cam.mask.getContext('2d'); cam.t = cam.tmp.getContext('2d')
cam.o.fillStyle = '#000'; cam.o.fillRect(0, 0, CW, CH)
cam.track = cam.out.captureStream(30).getVideoTracks()[0]
const mic = {raw: null, node: null, dest: ac.createMediaStreamDestination(), an: ac.createAnalyser()}
mic.an.fftSize = 512
mic.track = mic.dest.stream.getAudioTracks()[0]
const localStream = new MediaStream([cam.track, mic.track])

function drawFit(ctx, el, x, y, w, hh, mode) {
  const sw = el.videoWidth || el.width, sh = el.videoHeight || el.height
  if (!sw || !sh) return false
  const s = mode === 'contain' ? Math.min(w / sw, hh / sh) : Math.max(w / sw, hh / sh)
  const dw = sw * s, dh = sh * s
  ctx.drawImage(el, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh)
  return true
}
function camTick() {
  const v = cam.src
  if (!cam.raw || v.readyState < 2) return
  if (settings.blur > 0 && cam.seg) {
    drawFit(cam.f, v, 0, 0, CW, CH, 'cover')
    cam.s.drawImage(cam.frame, 0, 0, 320, 180)
    try {
      cam.seg.segmentForVideo(cam.small, performance.now(), r => {
        const m = r.confidenceMasks?.[0]; if (!m) return
        const a = m.getAsFloat32Array()
        if (!cam.img || cam.img.width !== m.width || cam.img.height !== m.height) {
          cam.mask.width = m.width; cam.mask.height = m.height
          cam.img = new ImageData(m.width, m.height); cam.img.data.fill(255)
        }
        const d = cam.img.data
        for (let i = 0; i < a.length; i++) d[i * 4 + 3] = a[i] * 255
        cam.m.putImageData(cam.img, 0, 0)
      })
    } catch (e) { console.warn('segment', e) }
    const px = settings.blur === 1 ? 7 : 18
    cam.o.filter = `blur(${px}px)`
    cam.o.drawImage(cam.frame, -px * 2, -px * 2, CW + px * 4, CH + px * 4)
    cam.o.filter = 'none'
    const t = cam.t
    t.globalCompositeOperation = 'copy'; t.filter = 'blur(3px)'
    t.drawImage(cam.mask, 0, 0, CW, CH)
    t.filter = 'none'; t.globalCompositeOperation = 'source-in'
    t.drawImage(cam.frame, 0, 0)
    t.globalCompositeOperation = 'source-over'
    cam.o.drawImage(cam.tmp, 0, 0)
  } else {
    drawFit(cam.o, v, 0, 0, CW, CH, 'cover')
  }
}
tickers.add(camTick)

async function loadSegmenter() {
  if (cam.seg) return cam.seg
  return cam.segP ??= (async () => {
    const t = toast('Loading background blur…', 0)
    try {
      const mp = await import(MP_URL)
      const fs = await mp.FilesetResolver.forVisionTasks(MP_WASM)
      const mk = delegate => mp.ImageSegmenter.createFromOptions(fs, {baseOptions: {modelAssetPath: MP_MODEL, delegate}, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true})
      cam.seg = await mk('GPU').catch(() => mk('CPU'))
      return cam.seg
    } catch (e) { cam.segP = null; toast('Background blur failed to load: ' + e.message, 6000); throw e }
    finally { t.remove() }
  })()
}
async function setBlur(n) {
  settings.blur = +n; LS.set('blur', settings.blur); $('#blurSel').value = settings.blur
  if (settings.blur) loadSegmenter().catch(() => {})
}

// each open/stop bumps req; a getUserMedia result that arrives after a newer request is stopped
const req = {cam: 0, mic: 0}
function stale(kind, n, stream) {
  if (n === req[kind]) return false
  stream.getTracks().forEach(t => t.stop())
  return true
}
async function openCam(id) {
  const n = ++req.cam
  cam.raw?.getTracks().forEach(t => t.stop()); cam.raw = null
  try {
    const raw = await navigator.mediaDevices.getUserMedia({video: {deviceId: id ? {exact: id} : undefined, width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}}})
    if (stale('cam', n, raw)) return
    cam.raw = raw
    cam.src.srcObject = cam.raw; await cam.src.play().catch(() => {})
    settings.camId = cam.raw.getVideoTracks()[0].getSettings().deviceId || id || ''
    LS.set('camId', settings.camId)
  } catch (e) { if (n !== req.cam) return; if (id) return openCam(''); toast('Camera unavailable: ' + e.name, 6000) }
}
async function openMic(id) {
  const n = ++req.mic
  mic.raw?.getTracks().forEach(t => t.stop()); mic.node?.disconnect(); mic.raw = null
  try {
    const raw = await navigator.mediaDevices.getUserMedia({audio: {deviceId: id ? {exact: id} : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true}})
    if (stale('mic', n, raw)) return
    mic.raw = raw
    mic.node = ac.createMediaStreamSource(mic.raw)
    mic.node.connect(mic.an); mic.node.connect(mic.dest)
    settings.micId = mic.raw.getAudioTracks()[0].getSettings().deviceId || id || ''
    LS.set('micId', settings.micId)
  } catch (e) { if (n !== req.mic) return; if (id) return openMic(''); toast('Microphone unavailable: ' + e.name, 6000) }
}
function stopLocalDevices() {
  req.cam++; req.mic++
  cam.raw?.getTracks().forEach(t => t.stop()); cam.raw = null
  mic.raw?.getTracks().forEach(t => t.stop()); mic.node?.disconnect(); mic.raw = null
}
async function refreshDevices() {
  const ds = await navigator.mediaDevices.enumerateDevices()
  const fill = (sel, field, list, cur) => {
    sel.innerHTML = ''
    list.forEach((d, i) => sel.append(h('option', {value: d.deviceId}, d.label || `Device ${i + 1}`)))
    sel.value = cur
    field.classList.toggle('hidden', list.length < 2)
  }
  fill($('#camSel'), $('#camField'), ds.filter(d => d.kind === 'videoinput'), settings.camId)
  fill($('#micSel'), $('#micField'), ds.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications'), settings.micId)
}
navigator.mediaDevices.addEventListener('devicechange', refreshDevices)

// mic level meter
const meterBuf = new Uint8Array(512)
let meterEl = $('#lobbyMeter')
const stopMeter = () => { meterEl = null }
setInterval(() => {
  if (!meterEl || !mic.raw) return
  mic.an.getByteTimeDomainData(meterBuf)
  let pk = 0; for (const v of meterBuf) pk = Math.max(pk, Math.abs(v - 128))
  meterEl.style.width = Math.min(100, pk / 128 * 180) + '%'
}, 80)

export {ac, resumeAudio, settings, me, cam, mic, localStream, drawFit, loadSegmenter, setBlur, openCam, openMic, stopLocalDevices, refreshDevices, stopMeter}
