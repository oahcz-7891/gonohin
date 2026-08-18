// 手写 SSE 解析器：把 fetch 的 ReadableStream 逐段 yield 出文本增量
// 不引库；OpenAI 兼容 /chat/completions 的流式响应格式：
//   data: {"choices":[{"delta":{"content":"..."}}]}
//   data: [DONE]

export async function* parseSSE(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      const data = dataLine.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        const delta = json.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // 忽略无法解析的中间事件（如心跳/注释行）
      }
    }
  }
}
