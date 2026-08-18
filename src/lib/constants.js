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
}

// OpenAI 兼容 API 预设（均为国内可直接访问的服务）
export const API_PRESETS = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '智谱', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
]

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
