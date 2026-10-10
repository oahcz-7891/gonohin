// UI 诊断：翻页可靠性的真机排障 —— 页面内日志 + 可单独开关的候选修复。
//
// 为什么需要它：有些失败只在 iOS 上出现（滚动惯性吞手势、抬起事件不派发、点击被延迟……），
// 桌面浏览器无论怎么点都是绿的。所以把「每次触摸」记成一条流水：落点元素、派发了哪些事件、
// 位移/时长、有没有浮层挡着、发了翻页指令没有、页码到底变没变。
//
// 一次触摸 = 一条记录（不是一次「点击」）：因为「点下去没反应」有可能是这一下压根没落到热区里。
// 只在 debug 打开时记录；默认开关值就是线上行为。

const KEY = 'gonohin:uitest'

export const STRATEGIES = [
  { key: 'tapByGesture', label: '① 手势判定代替 click', hint: 'touchstart/touchend + pointerup（线上行为；关掉＝纯 click 对照组）' },
  { key: 'turnOnPointerDown', label: '② pointerdown 立即翻页', hint: '不等抬起 → 验证抬起事件是否丢了' },
  { key: 'instantScroll', label: '③ 瞬时跳页（关平滑动画）', hint: '验证动画/滚动惯性是否吞掉手势' },
  { key: 'navTouchActionNone', label: '④ 热区 touch-action:none', hint: '验证浏览器是否把手势判成滚动' },
  { key: 'clearSelectionOnTurn', label: '⑤ 翻页时清残留选区', hint: '防旧选区被轮询重新上报、拉起遮罩' },
  { key: 'skipPollOnNav', label: '⑥ 热区触摸不启动选区轮询', hint: '掐断 tap → 轮询 → 遮罩 这条链' },
]

const DEFAULTS = {
  debug: false, // 总开关：日志 + 面板。关掉 = 完全线上行为
  topScale: 1.56, // 工具行下移倍率（乘在 env(safe-area-inset-top) 上）——真机调准用
  capH: 40, // 顶部蓝帽高度 px（蓝铺到这里，下面是工具行底色）——真机调准用
  tapByGesture: true,
  turnOnPointerDown: false,
  instantScroll: false,
  navTouchActionNone: false,
  clearSelectionOnTurn: false,
  skipPollOnNav: false,
}

let flags = { ...DEFAULTS }
try {
  const raw = localStorage.getItem(KEY)
  if (raw) flags = { ...DEFAULTS, ...JSON.parse(raw) }
} catch {
  /* 读不出来就用默认值 */
}

const listeners = new Set()
const emit = () => listeners.forEach((f) => f())

// 把两个高度写成内联变量：样式表里的值是默认值，滑条一拖就盖住它
function applyLayout() {
  const root = document.documentElement
  if (flags.topScale == null) root.style.removeProperty('--top-scale')
  else root.style.setProperty('--top-scale', String(flags.topScale))
  if (flags.capH == null) root.style.removeProperty('--cap-h')
  else root.style.setProperty('--cap-h', `${flags.capH}px`)
}
applyLayout()

/** 当前 --safe-top / --chrome-h 的实际值（面板上显示，方便对着真机说「就是 125」） */
export function topMetrics() {
  const cs = getComputedStyle(document.documentElement)
  return {
    inset: cs.getPropertyValue('--safe-top').trim(),
    chrome: cs.getPropertyValue('--chrome-h').trim(),
  }
}

/** 实际让位多少 px：直接量顶栏盒子（自定义属性里的 max()/calc() 读不出来，只能量）
    顶栏高度 = 让位 + 图标 38 + 下内边距 8 */
export function safeTopPx() {
  const el = document.querySelector('.reader-topbar, .topbar')
  if (!el) return null
  const h = Math.round(el.getBoundingClientRect().height)
  return { pad: h - 46, total: h }
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getFlags() {
  return flags
}
export function setFlag(key, value) {
  flags = { ...flags, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(flags))
  } catch {
    /* 隐私模式写不进去，只影响下次启动 */
  }
  if (key === 'topScale' || key === 'capH') applyLayout()
  emit()
}
export function resetFlags() {
  flags = { ...DEFAULTS }
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 同上 */
  }
  applyLayout()
  emit()
}

// ---------------------------------------------------------------- 事件缩写
// 一行要放得下手机屏，所以事件全用两字母缩写
export const EV_NAME = {
  ts: 'touchstart',
  te: 'touchend',
  tc: 'touchcancel',
  pd: 'pointerdown',
  pu: 'pointerup',
  pc: 'pointercancel',
  ck: 'click',
  cm: 'contextmenu',
  mv: 'touchmove',
}

// ---------------------------------------------------------------- 记录

let records = []
let seq = 0
let cur = null // 正在进行的触摸（按下 → 抬起）
let last = null // 刚抬起的触摸：touchend 之后还会到 click，还挂在它上面
let pending = [] // 已抬起、等动画结束补页码的记录（连点时会有多条堆着）

export function getRecords() {
  return records
}
export function clearRecords() {
  records = []
  cur = null
  last = null
  pending = []
  emit()
}
function push(rec) {
  records = [rec, ...records].slice(0, 40)
  emit()
}

/** 触摸开始（在 .reader-body 上用 capture 监听，保证比热区按钮先拿到）
    zone = 几何上落在热区内（按按钮实际包围盒算），inZone = 事件真的到了按钮 */
export function diagTouchStart(pt, hit, overlay, zone) {
  if (!flags.debug) {
    cur = null
    last = null
    return
  }
  // 同一次触摸会先后走 pointerdown 与 touchstart，只建一条记录（第二条合并进来），
  // 否则序号跳号，而且 pd 会被后到的 ts 覆盖掉
  if (cur && !cur.up) {
    cur.x = Math.round(pt.x)
    cur.y = Math.round(pt.y)
    cur.x2 = cur.x
    cur.y2 = cur.y
    cur.zone = cur.zone || !!zone
    return
  }
  last = null // 新的触摸开始，上一条不再接收事件
  cur = {
    n: ++seq,
    t0: performance.now(),
    x: Math.round(pt.x),
    y: Math.round(pt.y),
    x2: Math.round(pt.x),
    y2: Math.round(pt.y),
    hit,
    overlay0: overlay,
    overlay1: overlay,
    zone: !!zone,
    inZone: false,
    ev: [],
    moved: 0,
    dur: 0,
    requested: false,
    page0: null,
    page1: null,
  }
}

export function diagEvent(code) {
  // 抬起之后还会来事件（click / contextmenu），记在刚抬起那一条上
  const target = cur || last
  if (!target || target.ev.includes(code)) return
  target.ev.push(code)
  emit() // 事件是事后到的，要让它显示出来
}
export function diagMove(x, y) {
  if (cur) {
    cur.x2 = Math.round(x)
    cur.y2 = Math.round(y)
  }
}
/** 这一下触摸落在了翻页热区里 */
export function diagInZone(dir) {
  if (cur) {
    cur.inZone = true
    cur.dir = dir
  }
}
export function diagRequest() {
  if (cur) cur.requested = true
}
/** 抬起：记下当时的页码与浮层情况（页码要等动画结束才最终确定）。幂等：
    pointerup / touchend / click 都会调它，只算第一次 */
export function diagUp(page0, overlay) {
  if (!cur || cur.up) return
  cur.page0 = page0 ?? null
  cur.overlay1 = overlay
  cur.dur = Math.round(performance.now() - cur.t0)
  cur.moved = Math.round(Math.hypot(cur.x2 - cur.x, cur.y2 - cur.y))
  cur.up = true
  last = cur
  cur = null // 立即释放：紧接着的下一次触摸要开新记录（连点不会互相覆盖）
  pending.push(last)
  push(last)
}
/** 动画结束后补最终页码（抬手 900ms 后调）。连点时多次调用，按抬起顺序逐条结算 */
export function diagSettle(page1) {
  const target = pending.shift()
  if (!target) return
  // 必须换一个新的对象：同一个引用改字段，useSyncExternalStore 不会重渲染
  records = records.map((r) => (r === target ? { ...r, page1: page1 ?? null } : r))
  emit()
}

// ---------------------------------------------------------------- 结论

export const VERDICT_LABEL = {
  turned: '✅ 翻页',
  miss: '落点不在热区',
  blocked: '热区被挡',
  overlay: '被浮层拦',
  cancel: '抬起被取消',
  noEnd: '抬起事件没派发',
  moved: '被判成滑动',
  longpress: '被判成长按',
  noScroll: '发了指令没动',
  clickOnly: '走 click 兜底',
  unknown: '待结算',
}

export function verdict(r) {
  if (!r.up || r.page1 == null) return 'unknown'
  if (r.page1 !== r.page0) return 'turned'
  if (!r.zone) return 'miss'
  if (!r.inZone) return 'blocked'
  if (r.overlay0 || r.overlay1) return 'overlay'
  if (r.ev.includes('tc') || r.ev.includes('pc')) return 'cancel'
  if (!r.ev.includes('te') && !r.ev.includes('pu')) return 'noEnd'
  if (r.moved > 10) return 'moved'
  if (r.dur > 500) return 'longpress'
  if (r.requested) return 'noScroll'
  if (r.ev.includes('ck')) return 'clickOnly'
  return 'unknown'
}

const ADVICE = {
  miss: '主因：落点不在热区 → 看日志里的 hit 与坐标，热区要放宽或改判定方式',
  blocked: '主因：落点在热区但事件没到按钮 → 看 hit 是哪个元素挡的（多半是遮罩）',
  overlay: '主因：浮层拦截 → 打开 ⑤（清残留选区）与 ⑥（热区不启动轮询）',
  cancel: '主因：抬起被系统取消 → 打开 ②（pointerdown 立即翻页）',
  noEnd: '主因：抬起事件没派发 → 打开 ②（pointerdown 立即翻页）',
  noScroll: '主因：发了翻页指令但容器没动 → 打开 ③（瞬时跳页）',
  moved: '被当成滑动（位移 >10px）→ 阈值问题，不是吞手势',
  longpress: '被当成触长按（>500ms）→ 正常，按住太久了',
  clickOnly: 'click 兜底可用 → ① 不必要，但无害',
}

export function summarize(recs) {
  const settled = recs.filter((r) => r.up && r.page1 != null)
  const counts = {}
  for (const r of settled) {
    const v = verdict(r)
    counts[v] = (counts[v] || 0) + 1
  }
  const failed = (counts.turned || 0) < settled.length
  const top = Object.entries(counts)
    .filter(([k]) => k !== 'turned' && k !== 'unknown')
    .sort((a, b) => b[1] - a[1])[0]?.[0]
  return {
    total: settled.length,
    turned: counts.turned || 0,
    failed: settled.length - (counts.turned || 0),
    counts,
    advice: !failed ? '目前没有失败样本' : ADVICE[top] || '样本不足，再多点几次',
  }
}

/** 环境信息：截图时一并带上，省得来回问 */
export function envInfo() {
  const standalone =
    window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua)
  const m = ua.match(/OS (\d+[_.]\d+)/)
  return {
    runtime: ios ? `iOS ${m ? m[1].replace('_', '.') : '?'}` : ua.slice(0, 60),
    mode: standalone ? '独立窗口' : '浏览器',
    viewport: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}`,
    safeTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim() || '-',
    touch: navigator.maxTouchPoints,
    scrollend: 'onscrollend' in window ? '✓' : '✗',
    hoverNone: window.matchMedia('(hover: none)').matches ? '✓' : '✗',
  }
}
