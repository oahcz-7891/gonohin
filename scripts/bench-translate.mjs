// 翻译耗时基准：绕过应用，纯测 OpenAI 兼容 /chat/completions 流式的分段耗时。
// 目的：区分「首字 40s」到底是 建连/排队（headers 就慢），还是 模型算完才吐（headers 快、首个 data 慢）。
//
// 运行方式（密钥只留在你本地，不经过任何第三方）：
//   GONOHIN_KEY=sk-xxx \
//   GONOHIN_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 \
//   GONOHIN_MODEL=qwen-plus \
//   node scripts/bench-translate.mjs
// 不加环境变量则用脚本里的默认值（对 qwen 预设），key 为空时跳过真实请求。

import process from 'node:process'

const KEY = process.env.GONOHIN_KEY || ''
const BASE = (process.env.GONOHIN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
const MODEL = process.env.GONOHIN_MODEL || 'qwen-plus'

const examples = [
  { label: '极简', user: '翻译成中文：你好' }, // 几乎无需思考，测纯 TTFT
  { label: '单词', user: '【待翻译】\n映画' },
  {
    label: '长句',
    user:
      '【待翻译】\n予想通り彼等は映画館でのアリバイを確認しにきたようだ' +
      '\n\n【上下文】（仅供理解语境，不要翻译）\n彼等は最終列車で東京へ向かった。',
  },
]

function now() {
  return Number(process.hrtime.bigint() / 1000000n) // ms
}

export async function benchOnce({ user }) {
  const t0 = now()
  let headersMs = null
  let firstTokenMs = null
  let lastTokenMs = null
  let totalMs = null
  let chars = 0
  let headersStatus = 0

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是日语翻译助手。用户给出【待翻译】的文本，可能附带【上下文】。只翻译【待翻译】。先输出中文翻译，再解释词汇。' },
        { role: 'user', content: user },
      ],
    }),
  })

  headersMs = now() - t0 // 收到响应头 = 建连 + 服务端开始响应
  headersStatus = res.status
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { msg += ' ' + (await res.json()).error?.message || '' } catch {}
    return { label: user, headersStatus, headersMs, error: msg }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = event.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content
        if (delta) {
          if (firstTokenMs == null) firstTokenMs = now() - t0
          lastTokenMs = now() - t0
          chars += delta.length
        }
      } catch {}
    }
  }
  totalMs = now() - t0
  return { label: user, headersStatus, headersMs, firstTokenMs, totalMs, chars }
}

// 直接运行
if (process.argv[1] && process.argv[1].endsWith('bench-translate.mjs')) {
  if (!KEY) {
    console.log('未设置 GONOHIN_KEY，跳过真实请求（只打印测试用例）。')
  }
  for (const ex of examples) {
    const r = await benchOnce({ user: ex.user })
    console.log(`\n【${ex.label}】`)
    if (r.error) {
      console.log('  出错:', r.error)
      continue
    }
    console.log(`  headers   ${r.headersMs}ms   (建连 + 服务端开始响应；HTTP ${r.headersStatus})`)
    console.log(`  首个 token ${r.firstTokenMs ?? '-'}ms   (从发出到第一个字；这才是你看到的“首字”)`)
    console.log(`  总耗时    ${r.totalMs ?? '-'}ms   生成 ${r.chars} 字`)
    if (r.headersMs != null && r.firstTokenMs != null) {
      const gap = r.firstTokenMs - r.headersMs
      console.log(`  解读: headers→首字差 ${gap}ms。headers 慢=网络/排队；差很大=模型算完才吐/思考`)
    }
  }
}
