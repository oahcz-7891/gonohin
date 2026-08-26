// 思考强度（thinking）供应商适配层
// 各家的参数名/取值/默认行为都不同，这里做统一：
//   - 用户视角只用一套档位（auto/off/low/medium/high/max）
//   - 依据 baseURL 识别供应商，翻译时把档位映射成该供应商认识的请求体字段
//   - auto = 不传思考参数 = 跟随模型自身默认（保持旧行为，最稳）
//
// 注意：各家「强度档位」并不完全等价，映射按官方文档取近似值：
//   DeepSeek / Kimi 的 medium≈high；OpenAI 无真正「关闭」，off 落到 low。

// 识别供应商（按 baseURL 关键字，找不到时按通用 OpenAI 兼容处理）
export function detectProvider(baseURL) {
  const b = (baseURL || '').toLowerCase()
  if (b.includes('deepseek')) return 'deepseek'
  if (b.includes('aliyuncs') || b.includes('dashscope')) return 'qwen'
  if (b.includes('moonshot') || b.includes('kimi')) return 'kimi'
  if (b.includes('bigmodel')) return 'glm'
  if (b.includes('openai')) return 'openai'
  return 'generic'
}

// 各供应商：可用档位（供设置页展示）+ 档位 → 请求体字段 的映射
// map 返回 null 表示「不传思考参数」（auto，跟随模型默认）。
export const PROVIDER_THINKING = {
  deepseek: {
    label: 'DeepSeek',
    // 思考需显式开启；medium≈high
    options: [
      { value: 'auto', label: '跟随模型默认' },
      { value: 'off', label: '关闭思考' },
      { value: 'low', label: '低' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最大' },
    ],
    map: {
      auto: null,
      off: { thinking: { type: 'disabled' } },
      low: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
      medium: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      max: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    },
    hint: 'DeepSeek 的「中」等同「高」；思考内容不计入译文，只影响速度与 token 消耗。',
  },
  qwen: {
    label: '通义千问',
    // 只区分「开/关」，无强度档位（其余档位等价于开启）
    options: [
      { value: 'auto', label: '跟随模型默认' },
      { value: 'off', label: '关闭思考' },
      { value: 'high', label: '开启思考' },
    ],
    map: {
      auto: null,
      off: { enable_thinking: false },
      low: { enable_thinking: true },
      medium: { enable_thinking: true },
      high: { enable_thinking: true },
      max: { enable_thinking: true },
    },
    hint: '通义千问只区分「开/关」思考，其余档位等价于「开启」。',
  },
  kimi: {
    label: 'Kimi',
    // 新模型走 reasoning_effort；旧模型用 thinking 对象开关
    options: [
      { value: 'auto', label: '跟随模型默认' },
      { value: 'off', label: '关闭思考' },
      { value: 'low', label: '低' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最大' },
    ],
    map: {
      auto: null,
      off: { thinking: { type: 'disabled' } },
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'high' },
      high: { reasoning_effort: 'high' },
      max: { reasoning_effort: 'max' },
    },
    hint: 'Kimi 的「中」等同「高」；部分老模型用 thinking 对象开关思考。',
  },
  glm: {
    label: '智谱 GLM',
    options: [
      { value: 'auto', label: '跟随模型默认' },
      { value: 'off', label: '关闭思考' },
      { value: 'low', label: '低' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最大' },
    ],
    map: {
      auto: null,
      off: { thinking: { type: 'disabled' } },
      low: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
      medium: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      max: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    },
    hint: '智谱部分新版模型强制开启思考（无法关闭），否则用 thinking 开关 + reasoning_effort 调强度。',
  },
  openai: {
    label: 'OpenAI',
    // 无真正「关闭」：off 落到最低档 low
    options: [
      { value: 'auto', label: '跟随模型默认' },
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ],
    map: {
      auto: null,
      off: { reasoning_effort: 'low' },
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
      max: { reasoning_effort: 'high' },
    },
    hint: 'OpenAI 思考无「关闭」，最低档为「低」。',
  },
  generic: {
    label: 'OpenAI 兼容',
    options: [
      { value: 'auto', label: '跟随模型默认' },
      { value: 'off', label: '关闭思考' },
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
      { value: 'max', label: '最大' },
    ],
    map: {
      auto: null,
      off: { enable_thinking: false },
      low: { reasoning_effort: 'low' },
      medium: { reasoning_effort: 'medium' },
      high: { reasoning_effort: 'high' },
      max: { reasoning_effort: 'max' },
    },
    hint: '通用 OpenAI 兼容接口：关闭用 enable_thinking，强度用 reasoning_effort；识别不到的服务按此处理。',
  },
}

// 依据档位生成要追加到请求体的思考参数；auto/未知档位返回 null（不传，跟随模型默认）
export function buildThinkingParams(baseURL, level) {
  if (!level || level === 'auto') return null
  const provider = detectProvider(baseURL)
  return PROVIDER_THINKING[provider].map[level] || null
}

// 设置页展示用：当前供应商可用的档位。若已存值不在该列表里（换过供应商），追加进去保证下拉能显示当前值。
export function getThinkingOptions(baseURL, current) {
  const options = PROVIDER_THINKING[detectProvider(baseURL)].options.slice()
  if (current && !options.some((o) => o.value === current)) {
    // 用通用标签兜底追加，避免下拉框空白
    const labels = { auto: '跟随模型默认', off: '关闭思考', low: '低', medium: '中', high: '高', max: '最大' }
    options.push({ value: current, label: labels[current] || current })
  }
  return options
}

// 当前供应商的说明文案
export function getThinkingHint(baseURL) {
  return PROVIDER_THINKING[detectProvider(baseURL)].hint
}

// 当前供应商显示名（用于设置页小标题）
export function getProviderLabel(baseURL) {
  return PROVIDER_THINKING[detectProvider(baseURL)].label
}
