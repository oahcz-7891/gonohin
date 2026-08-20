// 翻译结果缓存：localStorage + LRU 淘汰。
// 命中即跳过 API 调用；读写全程 try/catch，缓存不可用（配额满/数据损坏）时静默降级，不影响翻译功能。

const PREFIX = 'gonohin:trans:'
const MAX_ITEMS = 200 // 最多保留条目数，超限删最旧（保留 70% 余量）

// 修改 translate.js 里任一 prompt（DRAFT_SYSTEM / 验证 / 修正）后 +1，让旧缓存自动作废
const PROMPT_VERSION = 2

// FNV-1a 32bit：把多段内容压成短 key。
// 哈希有碰撞可能，所以原文（raw）随值一起存，读取时比对，碰撞时按未命中处理。
function hash(raw) {
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * 组装缓存 key。入参：
 *   mode: 'normal' | 'deep'（两条管线的输出不同，必须分开缓存）
 *   text / context：翻译输入
 *   model / baseURL：不同服务/模型结果不同
 * 返回 { key, raw }，raw 用于读取时校验防碰撞。
 */
export function makeCacheKey({ mode, text, context = '', model, baseURL }) {
  const raw = [PROMPT_VERSION, mode, text.trim(), (context || '').trim(), model, baseURL].join('')
  return { key: PREFIX + hash(raw), raw }
}

export function cacheGet(key, raw) {
  try {
    const item = JSON.parse(localStorage.getItem(key))
    return item && item.k === raw && typeof item.v === 'string' ? item.v : null
  } catch {
    return null // 存储不可用或数据损坏，视为未命中
  }
}

export function cacheSet(key, raw, value) {
  const write = () => localStorage.setItem(key, JSON.stringify({ k: raw, v: value, t: Date.now() }))
  try {
    write()
    prune(MAX_ITEMS)
  } catch {
    // 配额满：删掉一半最旧的再重试一次，仍失败则放弃（静默）
    try {
      prune(Math.max(1, Math.floor(MAX_ITEMS / 2)))
      write()
    } catch {
      // 放弃写入
    }
  }
}

// 条目数超过 keep 时删除最旧的，直到降到 keep * 0.7（留余量，避免每次写入都触发淘汰）
function prune(keep) {
  const items = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(PREFIX)) continue
    let t = 0
    try {
      t = JSON.parse(localStorage.getItem(k))?.t || 0
    } catch {
      // 损坏条目按最旧处理，随淘汰清理
    }
    items.push({ k, t })
  }
  if (items.length <= keep) return
  items.sort((a, b) => a.t - b.t)
  const drop = items.length - Math.floor(keep * 0.7)
  for (const it of items.slice(0, drop)) localStorage.removeItem(it.k)
}
