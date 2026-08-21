// 翻译：调用 OpenAI 兼容 /chat/completions（SSE 流式）
// 兼容 DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI 等所有 OpenAI 兼容服务
// 两种能力：
//   1. translateStream  ：上下文注入的单次流式翻译（普通「翻译」）
//   2. translateDeep    ：agent loop（初译 → 文章内验证 → 修正 → 再验证），任何选区都可用
// 两者都会把最终结果缓存到 localStorage（LRU），重复翻译同一选区直接重放，0 次 API 调用；
// 传 { fresh: true } 可跳过缓存读取（「重新翻译」用），新结果仍会写回缓存。

import { getSettings } from './storage'
import { parseSSE } from './sse'
import { makeCacheKey, cacheGet, cacheSet } from './cache'

export function normalizeBaseURL(url) {
  return (url || '').trim().replace(/\/+$/, '')
}

// 深度翻译的文本长度上限（超过直接拒绝，避免多轮调用过于耗时/烧钱）
export const MAX_DEEP_LEN = 100

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
  '然后逐词输出：<原文（读音）> <词性> <中文释义>' +
  '最后简要说明语法，不扩展，不翻译或解释【上下文】。' +
  '语法解释规则:' +
  '1.只划词了单词的，不需要解释语法' +
  '2.划词了句子或句子的一部分的，需要解释语法。' +
  '结果显示示例：' +
  '待翻译：今日はいい天気ですね。' +
  '输出：' +
  '翻译：今天天气真好啊。' +
  '词汇：'+
  '今日（きょう） 名词 今天' +
  'は 助词 主题' +
  'いい 形容词 好的' +
  '天気（てんき） 名词 天气' +
  'です 助动词 礼貌体' +
  'ね 助词 确认/感叹' +
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

// 非流式单次对话，返回完整 content（用于验证 / 修正轮）
async function chatOnce(messages, settings = getSettings(), signal) {
  const res = await fetch(`${normalizeBaseURL(settings.baseURL)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      temperature: 0.2,
      messages,
    }),
    signal,
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const err = await res.json()
      message = err?.error?.message || message
    } catch {
      // 非 JSON 错误体，保留状态码信息
    }
    throw new Error(message)
  }
  const json = await res.json()
  return (json?.choices?.[0]?.message?.content || '').trim()
}

// 从模型输出中稳健提取 JSON：兼容纯 JSON / markdown 代码块包裹 / 前后带说明文字
function extractJSON(raw) {
  const r = (raw || '').trim()
  if (!r) return null
  const fenced = r.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : r
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

// 不查缓存的原始流式请求（被 translateStream 包装；深度翻译的初译草稿也用它）
// 必须是 async generator（而非返回 Promise<generator>）：for await 不会自动 await 表达式
async function* streamChat(text, context, settings, signal) {
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
 * opts.cache=false：不读也不写（深度翻译的初译草稿用，保证整条 agent loop 重跑）。
 */
export async function* translateStream(text, context = '', settings = getSettings(), signal, opts = {}) {
  const { fresh = false, cache = true } = opts
  const t = (text || '').trim()
  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')
  if (!t) throw new Error('没有可翻译的文本')

  // 命中缓存直接重放，0 次 API 调用
  const ck = cache
    ? makeCacheKey({ mode: 'normal', text: t, context, model: settings.model, baseURL: normalizeBaseURL(settings.baseURL) })
    : null
  if (ck && !fresh) {
    const hit = cacheGet(ck.key, ck.raw)
    if (hit) {
      yield hit
      return
    }
  }

  let acc = ''
  for await (const delta of streamChat(t, context, settings, signal)) {
    acc += delta
    yield delta
  }
  // 流正常结束才写缓存（中途 abort/出错会抛错，走不到这里）
  if (ck && acc.trim()) cacheSet(ck.key, ck.raw, acc)
}

/**
 * 深度翻译（agent loop）：对任意选区执行
 *   初译（流式，带上下文）→ 文章内验证（非流式 JSON，含汉字词平假名读音校验）→ 若 fail 修正（流式）→ 再验证
 * 最多 4 次 API 调用（初译 1 + 验证 2 + 修正 1）。
 * onStage 回调进度：'translating' | 'verifying' | 'fixing'
 * signal 用于中途取消（AbortController）：任一阶段进行中 abort 都会中止对应请求。
 * opts.fresh：跳过缓存读取（「重新翻译」用），新结果仍会写回缓存。
 */
export async function* translateDeep(text, context = '', settings = getSettings(), onStage, signal, opts = {}) {
  const { fresh = false } = opts
  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')
  const t = (text || '').trim()
  if (!t) throw new Error('没有可翻译的文本')
  if (t.length > MAX_DEEP_LEN) {
    throw new Error(`文本超过 ${MAX_DEEP_LEN} 字，请用「翻译」或精简选区`)
  }

  // 命中缓存直接重放整个 loop 的最终结果，0 次 API 调用
  const ck = makeCacheKey({
    mode: 'deep',
    text: t,
    context,
    model: settings.model,
    baseURL: normalizeBaseURL(settings.baseURL),
  })
  if (!fresh) {
    const hit = cacheGet(ck.key, ck.raw)
    if (hit) {
      yield hit
      return
    }
  }

  const buildUserMsg = (t2, extra = '') =>
    [
      context ? `【上下文】\n${context}\n\n` : '',
      `【待翻译】\n${t2}`,
      extra || '',
    ]
      .filter(Boolean)
      .join('\n\n')

  // 1. 初译（流式，收集完整草稿）
  onStage?.('translating')
  let draft = ''
  // 初译不走缓存：「重新翻译」时保证整条 agent loop 重跑
  const draftStream = await translateStream(t, context, settings, signal, { cache: false })
  for await (const delta of draftStream) draft += delta
  if (!draft.trim()) throw new Error('初译结果为空，请重试')

  // 2. 文章内验证
  const verify = async (candidate, label) => {
    onStage?.('verifying')
    const raw = await chatOnce(
      [
        {
          role: 'system',
          content:
            '你是严谨的翻译审校。对照【上下文】与【待翻译】检查【译文】：' +
            '1) 是否错译、漏译、过度意译；2) 专有名词/人名/术语是否与上下文一致；' +
            '3) 与前后文逻辑、时态、语气、人物关系是否衔接；4) 中文是否通顺；' +
            '5) 词汇解释中每个汉字词的平假名读音是否正确' +
            '读音错误要在 issues 中写明词与正确读音。' +
            '只用 JSON 输出，格式：{"pass": true或false, "issues": "问题简述，无则留空", "final": "若 pass 为 false 则给出修正后的完整译文，否则留空"}',
        },
        { role: 'user', content: `${buildUserMsg(t, `【译文】\n${candidate}`)}\n\n（本次为第 ${label} 次验证）` },
      ],
      settings,
      signal,
    )
    const json = extractJSON(raw)
    if (!json) return { pass: false, issues: '验证结果无法解析，视为未通过', final: candidate }
    // 模型输出未必规范：pass 可能是字符串，issues/final 可能是数组/对象，逐项容错
    const issues = typeof json.issues === 'string' ? json.issues.trim() : ''
    const final = typeof json.final === 'string' ? json.final.trim() : ''
    return {
      pass: json.pass === true || json.pass === 'true',
      issues,
      final: final || candidate,
    }
  }

  let first = await verify(draft, 1)

  let final
  if (first.pass) {
    final = first.final && first.final !== draft ? first.final : draft
  } else {
    // 3. 修正（按审校意见重译，流式收集）
    onStage?.('fixing')
    let fixed = ''
    const fixRes = await fetch(`${normalizeBaseURL(settings.baseURL)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        temperature: 0.2,
        messages: [
          { role: 'system', content: DRAFT_SYSTEM },
          {
            role: 'user',
            content: `${buildUserMsg(t, `【初译草稿】\n${draft}\n\n【审校意见】\n${first.issues}`)}\n\n请根据审校意见修正后重新翻译，只输出译文、词汇和语法解释。`,
          },
        ],
      }),
      signal,
    })
    if (!fixRes.ok) {
      let message = `HTTP ${fixRes.status}`
      try {
        const err = await fixRes.json()
        message = err?.error?.message || message
      } catch {
        // 非 JSON 错误体，保留状态码信息
      }
      throw new Error(message)
    }
    for await (const delta of parseSSE(fixRes)) fixed += delta
    fixed = fixed.trim()
    if (!fixed) fixed = first.final

    // 4. 修正后再验证一次（最多 2 轮验证）
    const second = await verify(fixed, 2)
    final = second.pass ? (second.final && second.final !== fixed ? second.final : fixed) : fixed
  }

  cacheSet(ck.key, ck.raw, final) // loop 正常跑完才写缓存（中途 abort/出错会抛错，走不到这里）
  yield final
}