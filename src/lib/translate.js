// 翻译：调用 OpenAI 兼容 /chat/completions（SSE 流式）
// 兼容 DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI 等所有 OpenAI 兼容服务

import { getSettings } from './storage'
import { parseSSE } from './sse'

export function normalizeBaseURL(url) {
  return (url || '').trim().replace(/\/+$/, '')
}

/**
 * 翻译文本，返回异步生成器逐段产出译文。
 * 需在「设置」页配置 apiKey / baseURL / model。
 */
export async function translateStream(text, settings = getSettings()) {
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
      messages: [
        {
          role: 'system',
          //content: '你是日语翻译。把用户提供的文本翻译成简体中文，只输出译文，不解释，不添加额外内容。',
          content: '你是日语翻译。把用户提供的文本翻译成简体中文，先输出一段翻译，再在下面解释词汇和语法，不做过多解释。',
        },
        { role: 'user', content: text },
      ],
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
