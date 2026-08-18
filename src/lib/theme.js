// 主题：跟随系统 / 浅色（羊皮纸）/ 深色

import { getSettings } from './storage'

export function resolveTheme(theme = getSettings().theme) {
  if (theme === 'light' || theme === 'dark') return theme
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 把主题写到 <html data-theme>，所有组件通过 CSS 变量切换 */
export function applyTheme(theme = getSettings().theme) {
  const resolved = resolveTheme(theme)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
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
