// 翻译：调用 OpenAI 兼容 /chat/completions（SSE 流式）
// 兼容 DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI 等所有 OpenAI 兼容服务
// 两种能力：
//   1. translateStream  ：上下文注入的单次流式翻译（普通「翻译」）
//   2. translateDeep    ：agent loop（初译 → 文章内验证 → 修正 → 再验证），任何选区都可用

import { getSettings } from './storage'
import { parseSSE } from './sse'

export function normalizeBaseURL(url) {
  return (url || '').trim().replace(/\/+$/, '')
}

// 深度翻译的文本长度上限（超过直接拒绝，避免多轮调用过于耗时/烧钱）
export const MAX_DEEP_LEN = 100

const DRAFT_SYSTEM =
  '你是日语翻译。把用户提供的文本翻译成简体中文，先输出一段翻译，再在下面解释词汇和语法。' +
  '解释词汇时，每个日语汉字词必须用括号标注平假名读音，格式：学校（がっこう）——学校；' +
  '若原文还有未解释的汉字词，也要一并逐个标注读音。不做过多解释。'

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
async function chatOnce(messages, settings) {
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

/**
 * 普通翻译（上下文注入）：返回异步 generator 逐段产出译文。
 * context 为选区所在段落文本（可为空）。
 */
export async function translateStream(text, context = '', settings = getSettings()) {
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

  return parseSSE(res)
}

/**
 * 深度翻译（agent loop）：对任意选区执行
 *   初译（流式，带上下文）→ 文章内验证（非流式 JSON）→ 若 fail 修正（流式）→ 再验证
 * 最多 4 次 API 调用（初译 1 + 验证 2 + 修正 1）。
 * onStage 回调进度：'translating' | 'verifying' | 'fixing'
 */
export async function* translateDeep(text, context = '', settings = getSettings(), onStage) {
  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')
  const t = (text || '').trim()
  if (!t) throw new Error('没有可翻译的文本')
  if (t.length > MAX_DEEP_LEN) {
    throw new Error(`文本超过 ${MAX_DEEP_LEN} 字，请用「翻译」或精简选区`)
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
  const draftStream = await translateStream(t, context, settings)
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
            '3) 与前后文逻辑、时态、语气、人物关系是否衔接；4) 中文是否通顺。' +
            '只用 JSON 输出，格式：{"pass": true或false, "issues": "问题简述，无则留空", "final": "若 pass 为 false 则给出修正后的完整译文，否则留空"}',
        },
        { role: 'user', content: `${buildUserMsg(t, `【译文】\n${candidate}`)}\n\n（本次为第 ${label} 次验证）` },
      ],
      settings,
    )
    const json = extractJSON(raw)
    if (!json) return { pass: false, issues: '验证结果无法解析，视为未通过', final: candidate }
    return {
      pass: !!json.pass,
      issues: (json.issues || '').trim(),
      final: (json.final || '').trim() || candidate,
    }
  }

  let first = await verify(draft, 1)
  if (first.pass) {
    yield first.final && first.final !== draft ? first.final : draft
    return
  }

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
  if (second.pass) {
    yield second.final && second.final !== fixed ? second.final : fixed
    return
  }
  // 仍不过（或解析失败）：按最后一次修改后的结果输出
  yield fixed
}