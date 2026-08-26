// 全局常量：存储 key、默认设置、API 预设、格式定义

export const STORE_KEYS = {
  settings: 'gonohin:settings',
  progressPrefix: 'gonohin:progress:',
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  theme: 'system', // system | light | dark
  // 思考强度档位（auto=| off=关 | low | medium | high | max），按 baseURL 识别供应商映射
  thinkingNormal: 'auto', // 普通翻译
  thinkingDeep: 'auto', // 深度翻译
}

// OpenAI 兼容 API 预设（均为国内可直接访问的服务）
export const API_PRESETS = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '智谱', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
]

// 翻译上下文长度控制：划词只发给模型的上文，仅用于理解语境/专有名词，不参与翻译。
// 整段 ≤ CTX_MAX 时整段发送；超长则以选区为中心截取左右各 CTX_RADIUS 字。
// 数值越小输入 token 越少、生成/排队越快，但上下文信息也越少。改这里即可全局调整。
export const CTX_MAX = 30
export const CTX_RADIUS = 15

export const FORMATS = { EPUB: 'EPUB', PDF: 'PDF', MOBI: 'MOBI', TXT: 'TXT' }

// 扩展名 → 格式
export const FORMAT_BY_EXT = {
  epub: FORMATS.EPUB,
  pdf: FORMATS.PDF,
  mobi: FORMATS.MOBI,
  azw3: FORMATS.MOBI, // KF8 与 MOBI 同为 PalmDB 容器
  txt: FORMATS.TXT,
}

// 魔数检测（双保险）：PDF 头、ZIP(PK\x03\x04)、MOBI（BOOKMOBI 位置随记录数变化，用子串搜索）
export const MAGIC = {
  PDF: '%PDF-',
  ZIP: [0x50, 0x4b, 0x03, 0x04],
  MOBI: 'BOOKMOBI',
}

// 书架卡片支持的导入文件扩展名
export const ACCEPT_EXTS = '.epub,.pdf,.mobi,.azw3,.txt'
