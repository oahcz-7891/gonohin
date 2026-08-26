// 翻译：调用 OpenAI 兼容 /chat/completions（SSE 流式）
// 兼容 DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI 等所有 OpenAI 兼容服务
// 两种能力：
//   1. translateStream  ：上下文注入的单次流式翻译（普通「翻译」）
//   2. translateDeep    ：同一条单次流式翻译管线，但思考强度走「深度翻译」档（agent loop 已移除）
// 两者都会把最终结果缓存到 localStorage（LRU），重复翻译同一选区直接重放，0 次 API 调用；
// 传 { fresh: true } 可跳过缓存读取（「重新翻译」用），新结果仍会写回缓存。

import { getSettings } from './storage'
import { parseSSE } from './sse'
import { makeCacheKey, cacheGet, cacheSet } from './cache'
import { buildThinkingParams } from './thinking'

export function normalizeBaseURL(url) {
  return (url || '').trim().replace(/\/+$/, '')
}

const DRAFT_SYSTEM =
  '你是日语翻译助手。用户会提供【待翻译】文本，可能附带【上下文】。' +
  '你的任务：只翻译【待翻译】部分，并解释语法和词汇，标注读音。' +
  '【上下文】仅用于理解语境、专有名词和正确读音，绝不能翻译或解释【上下文】。' +
  '读音标注规则：' +
  '1. 读音一律用平假名标注在对应【词语】后的括号内，格式为：词语(读音)。' +
  '标注单位是“单词”，不是“单个汉字”。' +
  '对于由多个汉字组成的词（如复合词、数词+量词、派生词等），必须合并标注，不要逐字拆分。' +
  '例如：一課（いっか）、二回（にかい）、三階（さんがい）、八百屋（やおや）。' +
  '2. 不要使用罗马字或片假名标注读音。' +
  '3. 必须根据语境选择正确读音，尤其是多音字、音读/训读、人名、地名等。' +
  '4. 如果【上下文】中已有假名注音，以该注音为准。' +
  '5. 特别注意数词与量词组合时的音便（促音、连浊、音读变化等），' +
  '例如「一課」读「いっか」，不要拆成「一（いち）課（か）」；' +
  '「一回」读「いっかい」，不要拆成「一（いち）回（かい）」。' +
  '6. 如果不确定读音，不要编造。给出最可能的读音，并在该词后标注“[读音需人工核对]”。' +
  '输出格式：' +
  '先输出：中文翻译：<整句中文翻译>' +
  '然后逐词输出：<原文（读音）> 【<词性>】<动词原形><中文释义>' +
  '最后简要说明语法，不扩展，不翻译或解释【上下文】。' +
  '单词解释规则:' +
  '必须解释词性和中文释义，如果不是原形，需标注原形' +
  '语法解释规则:' +
  '1.只划词了单词的，不需要解释语法' +
  '2.划词了句子或句子的一部分的，需要解释语法。' +
  '结果显示示例：' +
  '待翻译：今日はいい天気ですね。' +
  '输出：' +
  '翻译：今天天气真好啊。' +
  '词汇：'+
  '今日（きょう） 【名词】今天' +
  'は 【助词】 主题' +
  'いい 【形容词】 好的' +
  '天気（てんき） 【名词】 天气' +
  'です 【助动词】 礼貌体' +
  'ね 【助词】 确认/感叹' +
  '语法：～は～です 表示主题判断；ね 表示确认或感叹。'

// 把 context 与待翻译文本一起放进 user 消息的长 prompt
function buildMessages(text, context) {
  const user = context
    ? `【上下文】\n${context}\n\n【待翻译】\n${text}`
    : text
  return [
    { role: 'system', content: DRAFT_SYSTEM },
    { role: 'user', content: user },
  ]
}

// 依据档位生成要追加进请求体的思考参数（null 表示不传，跟随模型默认）
function thinkingBody(settings, level) {
  const params = buildThinkingParams(settings.baseURL, level)
  return params || {}
}

// 不查缓存的原始流式请求（被 translateStream 包装；深度翻译也复用同一条管线）
// 必须是 async generator（而非返回 Promise<generator>）：for await 不会自动 await 表达式
async function* streamChat(text, context, settings, signal, level) {
  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')
  if (!text.trim()) throw new Error('没有可翻译的文本')

  const res = await fetch(`${normalizeBaseURL(settings.baseURL)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      temperature: 0.2,
      messages: buildMessages(text, context),
      ...thinkingBody(settings, level),
    }),
    signal,
  })

  if (!res.ok) {
    // 非 2xx：尝试解析 JSON 错误体
    let message = `HTTP ${res.status}`
    try {
      const err = await res.json()
      message = err?.error?.message || message
    } catch {
      // 非 JSON 错误体，保留状态码信息
    }
    throw new Error(message)
  }

  yield* parseSSE(res)
}

/**
 * 普通翻译（上下文注入）：返回异步 generator 逐段产出译文。
 * context 为选区所在段落文本（可为空）。
 * opts.fresh：跳过缓存读取（「重新翻译」用），结果仍会写回缓存；
 * opts.thinking：思考强度档位；默认 settings.thinkingNormal（深度翻译会传 thinkingDeep）。
 */
export async function* translateStream(text, context = '', settings = getSettings(), signal, opts = {}) {
  const { fresh = false, cache = true } = opts
  // 思考强度：默认用「普通翻译」档；深度翻译初译草稿会经 opts.thinking 覆盖
  const level = opts.thinking ?? settings.thinkingNormal
  const t = (text || '').trim()
  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')
  if (!t) throw new Error('没有可翻译的文本')

  // 命中缓存直接重放，0 次 API 调用
  const ck = cache
    ? makeCacheKey({ mode: 'normal', text: t, context, model: settings.model, baseURL: normalizeBaseURL(settings.baseURL), thinking: level })
    : null
  if (ck && !fresh) {
    const hit = cacheGet(ck.key, ck.raw)
    if (hit) {
      yield hit
      return
    }
  }

  let acc = ''
  for await (const delta of streamChat(t, context, settings, signal, level)) {
    acc += delta
    yield delta
  }
  // 流正常结束才写缓存（中途 abort/出错会抛错，走不到这里）
  if (ck && acc.trim()) cacheSet(ck.key, ck.raw, acc)
}

/**
 * 深度翻译：单次流式翻译（与「普通翻译」同一条管线），
 * 但思考强度走 settings.thinkingDeep，缓存走同一套 LRU。agent loop 已移除。
 * opts.fresh：跳过缓存读取（「重新翻译」用），新结果仍会写回缓存。
 */
export async function* translateDeep(text, context = '', settings = getSettings(), signal, opts = {}) {
  const { fresh = false } = opts
  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')
  const t = (text || '').trim()
  if (!t) throw new Error('没有可翻译的文本')
  // 单次流式翻译，思考强度用「深度翻译」档；不再有多轮 验证 → 修正 → 再验证
  yield* translateStream(t, context, settings, signal, { fresh, thinking: settings.thinkingDeep })
}