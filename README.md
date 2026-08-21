# Gonohin

## 简介

纯前端日语电子书阅读器，支持 EPUB / PDF / MOBI / AZW3 / TXT 四种格式，划词调用 AI 翻译（日语 → 中文）。数据全部保存在本机浏览器，可免费部署到任意静态托管。

### 功能

- 书架：导入 / 删除书籍，封面、阅读进度一目了然（IndexedDB 持久化，刷新不丢）
- 多格式阅读：
  - EPUB → epubjs
  - PDF → pdfjs-dist（canvas + 可划词文本层）
  - MOBI / AZW3 → @lingo-reader/mobi-parser
  - TXT → 原生分页（自动检测 UTF-8 / Shift_JIS 编码）
- 划词翻译：触屏设备自绘「复制 / 翻译 / 深度翻译」操作条，鼠标设备选中直接弹翻译窗；SSE 流式输出译文（手写解析器，零依赖）
- 深度翻译：agent loop（初译 → 文章内验证 → 按审校意见修正 → 再验证），自动完成翻译、词汇语法讲解与读音校验（超长文本自动限制）
- 翻译缓存：结果写入 localStorage（LRU 淘汰），重复翻译同一段直接重放、零 API 调用；「重新翻译」可强制刷新
- 界面风格：弹窗与划词操作条采用 iOS 26 液体玻璃材质、高光边缘与弹性入场 / 退场动画
- 设置页：OpenAI 兼容 API Key 配置（DeepSeek / 通义千问 / Kimi / 智谱 预设），带连接测试
- 阅读进度：按格式保存（CFI / 页码 / 章节），自动定时落盘并在刷新后恢复

### 技术栈

React 19 + Vite 8，纯前端零后端。API Key 存浏览器 localStorage，翻译请求由浏览器直连 API，不经任何服务器。

### 开发

```bash
npm install
npm run dev      # 本地开发
npm run build    # 构建产物 → dist/
npm run preview  # 本地预览构建产物
```

### 部署（免费静态托管）

构建产物 dist/ 为纯静态文件，可部署到 Cloudflare Pages、GitHub Pages、Vercel、Netlify 等任意静态托管服务（以 Cloudflare Pages 为例）：

1. 登录 Cloudflare Dashboard → Workers & Pages
2. 创建 Pages 项目 → 选择「直接上传」→ 上传 dist/ 目录内容
3. 获得形如 https://xxx.pages.dev 的访问地址
4. 后续更新可用 Wrangler CLI 推送：npx wrangler pages deploy dist

### 隐私

所有阅读数据、翻译缓存与 API Key 均只保存在本机浏览器，不上传任何服务器。

---

## Introduction

A pure front-end Japanese e-book reader supporting EPUB / PDF / MOBI / AZW3 / TXT, with AI translation (Japanese → Chinese) on text selection. All data stays in the browser, and it can be deployed for free to any static host.

### Features

- Bookshelf: import / delete books with covers and reading progress (IndexedDB persistence, survives refresh)
- Multi-format reading:
  - EPUB → epubjs
  - PDF → pdfjs-dist (canvas + selectable text layer)
  - MOBI / AZW3 → @lingo-reader/mobi-parser
  - TXT → native pagination with UTF-8 / Shift_JIS auto-detection
- Selection translation: touch devices get a custom copy / translate / deep-translate bar; mouse devices open the translator directly on selection. Translations stream in via SSE with a hand-written, zero-dependency parser.
- Deep translation: an agent loop (draft → in-context verification → fix per review → re-verify) that produces a polished translation with vocabulary/grammar notes and reading checks (automatically limited for long texts).
- Translation cache: results are stored in localStorage (LRU eviction); repeating a translation replays instantly with zero API calls, while "re-translate" forces a fresh run.
- UI style: the popup and selection bar use an iOS 26 Liquid Glass material with edge highlight and springy entrance / exit animations.
- Settings: OpenAI-compatible API key setup with presets for DeepSeek / Qwen / Kimi / Zhipu, plus a connection test.
- Reading progress: saved per format (CFI / page / chapter), auto-persisted on an interval and restored on reload.

### Tech Stack

React 19 + Vite 8, front-end only with no backend. The API key lives in browser localStorage; translation requests go directly from the browser to the API without passing through any server.

### Development

```bash
npm install
npm run dev      # local development
npm run build    # build output → dist/
npm run preview  # preview the build locally
```

### Deployment (Free Static Hosting)

The dist/ build is pure static files and can be hosted anywhere: Cloudflare Pages, GitHub Pages, Vercel, Netlify, or any static host. Example with Cloudflare Pages:

1. Log in to the Cloudflare Dashboard → Workers & Pages
2. Create a Pages project → choose "Direct Upload" → upload the contents of dist/
3. Get an address like https://xxx.pages.dev
4. Push future updates with: npx wrangler pages deploy dist

### Privacy

All reading data, translation caches, and the API key remain in your own browser and are never uploaded anywhere.