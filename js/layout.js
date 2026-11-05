import {$, h, initials} from './util.js'
import {drawFit} from './media.js'

const LAYOUT_MODES = [['auto', 'Auto (like Meet)'], ['side', 'Side by side'], ['grid', 'Grid'], ['focus', 'Focus + strip on right'], ['pip', 'Picture-in-picture'], ['solo', 'Single (first only)']]
const defaultLayout = () => ({mode: 'auto', order: [], labels: true, labelPos: 'bl', pipCorner: 'br', fill: false})

function orderItems(items, layout) {
  const ord = layout.order || []
  const rank = it => { const i = ord.indexOf(it.key); return i < 0 ? 1e6 + (it.kind === 'screen' ? 0 : 1) : i }
  return [...items].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
}
function resolveMode(layout, items) {
  if (layout.mode !== 'auto') return {mode: layout.mode, items}
  const scr = items.filter(i => i.kind === 'screen')
  if (scr.length) return {mode: 'focus', items: [...scr, ...items.filter(i => i.kind !== 'screen')]}
  return {mode: items.length <= 1 ? 'solo' : items.length === 2 ? 'side' : 'grid', items}
}
function computeRects(W, H, mode, items, layout) {
  const pad = Math.round(W * 0.0125), n = items.length, out = []
  if (!n) return out
  // largest centered 16:9 box inside the cell (or the whole cell when filling)
  const t16 = (x, y, w, hh) => {
    if (layout.fill) return [x, y, w, hh]
    let tw = w, th = tw * 9 / 16
    if (th > hh) { th = hh; tw = th * 16 / 9 }
    return [x + (w - tw) / 2, y + (hh - th) / 2, tw, th]
  }
  if (mode === 'solo' || n === 1) out.push({it: items[0], r: [0, 0, W, H], full: true})
  else if (mode === 'side' || mode === 'grid') {
    const cols = mode === 'side' ? n : Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols)
    const cw = (W - pad * (cols + 1)) / cols, ch = (H - pad * (rows + 1)) / rows
    items.forEach((it, i) => {
      const c = i % cols, r = Math.floor(i / cols), inRow = r === rows - 1 ? n - (rows - 1) * cols : cols
      const off = (cols - inRow) * (cw + pad) / 2
      out.push({it, r: t16(pad + off + c * (cw + pad), pad + r * (ch + pad), cw, ch)})
    })
  } else if (mode === 'focus') {
    const [main, ...rest] = items
    const colW = Math.round(W * 0.24), mainW = W - colW - pad * 3
    out.push({it: main, r: main.kind === 'screen' || layout.fill ? [pad, pad, mainW, H - 2 * pad] : t16(pad, pad, mainW, H - 2 * pad)})
    const k = rest.length
    let th = colW * 9 / 16
    if (k * th + (k - 1) * pad > H - 2 * pad) th = (H - 2 * pad - (k - 1) * pad) / k
    const tw = th * 16 / 9
    let y = (H - (k * th + (k - 1) * pad)) / 2
    for (const it of rest) { out.push({it, r: [W - pad - colW + (colW - tw) / 2, y, tw, th]}); y += th + pad }
  } else if (mode === 'pip') {
    const [main, ...rest] = items
    out.push({it: main, r: [0, 0, W, H], full: true})
    const tw = W * 0.2, th = tw * 9 / 16, c = layout.pipCorner || 'br'
    rest.forEach((it, i) => {
      const x = c.includes('r') ? W - pad * 2 - tw : pad * 2
      const y = c.includes('b') ? H - pad * 2 - th - i * (th + pad) : pad * 2 + i * (th + pad)
      out.push({it, r: [x, y, tw, th], shadow: true})
    })
  }
  return out
}
function composite(ctx, W, H, layout, items) {
  ctx.fillStyle = '#0e0f12'; ctx.fillRect(0, 0, W, H)
  const {mode, items: its} = resolveMode(layout, orderItems(items, layout))
  for (const t of computeRects(W, H, mode, its, layout)) drawTile(ctx, t, layout, W)
}
function drawTile(ctx, {it, r: [x, y, w, hh], full, shadow}, layout, W) {
  const rad = full ? 0 : Math.round(W * 0.008)
  ctx.save()
  if (shadow) { ctx.shadowColor = '#000a'; ctx.shadowBlur = 20; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(x, y, w, hh, rad); ctx.fill(); ctx.shadowColor = 'transparent' }
  ctx.beginPath(); ctx.roundRect(x, y, w, hh, rad); ctx.clip()
  ctx.fillStyle = it.kind === 'screen' ? '#000' : '#1c1e24'; ctx.fillRect(x, y, w, hh)
  const ok = !it.camOff && it.el && it.el.readyState >= 2 && drawFit(ctx, it.el, x, y, w, hh, it.kind === 'screen' ? 'contain' : 'cover')
  if (!ok && it.kind !== 'screen') {
    const rr = Math.min(w, hh) * 0.17
    ctx.fillStyle = '#3a4152'; ctx.beginPath(); ctx.arc(x + w / 2, y + hh / 2, rr, 0, 7); ctx.fill()
    ctx.fillStyle = '#e7e9ee'; ctx.font = `700 ${rr * 0.8}px system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(initials(it.name), x + w / 2, y + hh / 2 + rr * 0.04); ctx.textAlign = 'start'
  }
  ctx.restore()
  if (layout.labels !== false && it.name) {
    const fs = Math.max(14, Math.round(W * (w < W * 0.3 ? 0.0105 : 0.0135)))
    ctx.font = `600 ${fs}px system-ui,sans-serif`; ctx.textBaseline = 'middle'
    const label = it.name + (it.micOff ? '  🔇' : '')
    const pw = ctx.measureText(label).width + fs * 1.2, ph = fs * 1.8, m = fs * 0.7, pos = layout.labelPos || 'bl'
    const lx = pos.includes('r') ? x + w - m - pw : x + m, ly = pos.includes('t') ? y + m : y + hh - m - ph
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.roundRect(lx, ly, pw, ph, ph / 4); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.fillText(label, lx + fs * 0.6, ly + ph / 2)
  }
}

// layout controls UI (used live + in editor)
function layoutControls(host, get, set, keysFn) {
  const render = () => {
    const L = get(), keys = keysFn()
    const ordered = orderItems(keys, L)
    const resolved = resolveMode(L, ordered)
    host.innerHTML = ''
    const sel = h('select', {onchange: e => set({...get(), mode: e.target.value})}, LAYOUT_MODES.map(([v, l]) => h('option', {value: v}, l)))
    sel.value = L.mode
    const lp = h('select', {onchange: e => set({...get(), labelPos: e.target.value})}, [['bl', 'bottom left'], ['br', 'bottom right'], ['tl', 'top left'], ['tr', 'top right']].map(([v, l]) => h('option', {value: v}, l)))
    lp.value = L.labelPos || 'bl'
    const pc = h('select', {onchange: e => set({...get(), pipCorner: e.target.value})}, [['br', 'bottom right'], ['bl', 'bottom left'], ['tr', 'top right'], ['tl', 'top left']].map(([v, l]) => h('option', {value: v}, l)))
    pc.value = L.pipCorner || 'br'
    const move = (i, d) => {
      const ks = resolved.items.map(k => k.key), j = i + d
      if (j < 0 || j >= ks.length) return
      ;[ks[i], ks[j]] = [ks[j], ks[i]]
      set({...get(), order: ks})
    }
    host.append(...[
      h('div', {class: 'row'}, sel, L.mode === 'auto' ? h('small', {}, '→ ' + (LAYOUT_MODES.find(m => m[0] === resolved.mode)?.[1] || '')) : null),
      L.mode === 'pip' ? h('div', {class: 'row'}, h('span', {class: 'dim'}, 'Inset corner'), pc) : null,
      h('div', {class: 'row'}, h('label', {}, h('input', {type: 'checkbox', ...(L.labels !== false ? {checked: true} : {}), onchange: e => set({...get(), labels: e.target.checked})}), 'Name labels'), lp),
      h('div', {class: 'row'}, h('label', {}, h('input', {type: 'checkbox', ...(L.fill ? {checked: true} : {}), onchange: e => set({...get(), fill: e.target.checked})}), 'Fill tiles (crop instead of 16:9 boxes)')),
      h('small', {}, 'Order (first is the main tile in Focus, PiP and Single):'),
      h('ul', {class: 'order'}, resolved.items.map((k, i) => h('li', {}, h('span', {}, k.name + (k.present === false ? ' (not present here)' : '')),
        h('button', {onclick: () => move(i, -1), title: 'Move up'}, '↑'), h('button', {onclick: () => move(i, 1), title: 'Move down'}, '↓'))))
    ].filter(Boolean))
    if (!keys.length) host.append(h('small', {}, 'No feeds yet.'))
  }
  render()
  return {render}
}

export {LAYOUT_MODES, defaultLayout, composite, layoutControls}
