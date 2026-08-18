// localStorage 封装：设置 / 阅读进度

import { STORE_KEYS, DEFAULT_SETTINGS } from './constants'

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

/** 读设置，与默认值深度合并（容忍缺字段） */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(STORE_KEYS.settings, {}) }
}

/** 保存设置（合并写入） */
export function setSettings(partial) {
  const next = { ...getSettings(), ...partial }
  write(STORE_KEYS.settings, next)
  return next
}

function progressKey(bookId) {
  return STORE_KEYS.progressPrefix + bookId
}

/** 读某本书的进度，没有返回 null */
export function getProgress(bookId) {
  return read(progressKey(bookId), null)
}

/** 保存进度，自动带 updatedAt 时间戳 */
export function saveProgress(bookId, progress) {
  const next = { ...progress, updatedAt: Date.now() }
  write(progressKey(bookId), next)
  return next
}
