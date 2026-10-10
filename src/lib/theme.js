// 主题：跟随系统 / 浅色（羊皮纸）/ 深色

import { getSettings } from './storage'

export function resolveTheme(theme = getSettings().theme) {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 把 --bg 同步到 <meta name="theme-color">。
 * 手机浏览器在视口下面还有一条底带（Safari 底栏 / 手势条区域），它用的就是这个色；
 * 阅读页状态栏的渐变末端也是 --bg（见 .reader-statusbar），
 * 二者同值，屏幕最底部才不会露出一道色差。浅色主题同理。
 */
export function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  const bg = cssVar('--bg')
  if (meta && bg) meta.setAttribute('content', bg)
}

/** 把主题写到 <html data-theme>，所有组件通过 CSS 变量切换 */
export function applyTheme(theme = getSettings().theme) {
  const resolved = resolveTheme(theme)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  syncThemeColor()
  return resolved
}

/** 应用当前主题，并在“跟随系统”时监听系统切换 */
export function initTheme() {
  applyTheme()
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (getSettings().theme === 'system') applyTheme('system')
  }
  mq.addEventListener?.('change', onChange)
  return () => mq.removeEventListener?.('change', onChange)
}

/** 读一个 CSS 变量的当前值（已 trim）。取不到返回空串。 */
export function cssVar(name, el = document.documentElement) {
  try {
    return getComputedStyle(el).getPropertyValue(name).trim()
  } catch {
    return ''
  }
}

/**
 * 沉浸模式探测：页面是否铺到了状态栏/灵动岛下面（iOS 独立窗口 + viewport-fit=cover）。
 * CSS 无法判断 env(safe-area-inset-top) 是否 > 0（自定义属性里算不出条件），
 * 但顶栏要不要改成「蓝帽 + 工具行底色」完全取决于这一点，所以用探针量一次写到 <html data-immersive>。
 * 桌面浏览器 env() = 0 → data-immersive="0" → 顶栏维持整条蓝带。
 */
export function initImmersive() {
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top)'
  document.body.appendChild(probe)
  const apply = () => {
    const px = parseFloat(getComputedStyle(probe).paddingTop) || 0
    document.documentElement.dataset.immersive = px > 0 ? '1' : '0'
  }
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
  return apply
}

/**
 * 阅读纸面色。
 * MOBI 的 iframe srcdoc 与 EPUB 的 rendition.themes 都跑在独立文档里，拿不到父页的 CSS 变量，
 * 所以必须把值算好再注入 —— 让 styles/global.css 保持唯一真源，别在渲染器里再写死颜色。
 * 注意 accent 取 --primary-bright：藏青（--primary）在纸面上只有 ~2.9:1，当文字色会看不见。
 */
export function paperColors() {
  return {
    bg: cssVar('--paper') || '#161616',
    fg: cssVar('--fg') || '#ededed',
    accent: cssVar('--primary-bright') || cssVar('--primary') || '#6b9bd8',
  }
}

/** #rrggbb → rgba(r,g,b,a)。用于把主色降透明度后注入 iframe（iframe 里看不到父页变量）。 */
export function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || '').trim())
  if (!m) return hex
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
