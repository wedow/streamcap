const qs = new URLSearchParams(location.search)
const TRYSTERO_URL = qs.get('trystero') || 'https://esm.sh/trystero@0.26.0'
const MP_VER = '1.2.2'
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'
const APP_ID = 'gw-p2p-studio-v1-8c41'
const ICE = [{urls: 'stun:stun.l.google.com:19302'}, {urls: 'stun:stun.cloudflare.com:3478'}]
// add TURN here if needed: {urls:'turn:host:3478', username:'', credential:''}
const MIME = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
  .find(t => MediaRecorder.isTypeSupported(t))
const EXT = MIME.startsWith('video/mp4') ? 'mp4' : 'webm'
// raw feeds can change resolution mid-stream (network adaptation, window resizes), which
// avc1 can't represent; avc3 carries the parameters in-band. Fixed-size outputs use MIME.
const FEED_MIME = (EXT === 'mp4' && ['video/mp4;codecs=avc3,mp4a.40.2', 'video/mp4;codecs=avc3,opus'].find(t => MediaRecorder.isTypeSupported(t))) || MIME
const PW = 1920, PH = 1080, CW = 1280, CH = 720
const CHUNK = 512 * 1024

export {qs, TRYSTERO_URL, MP_URL, MP_WASM, MP_MODEL, APP_ID, ICE, MIME, EXT, FEED_MIME, PW, PH, CW, CH, CHUNK}
