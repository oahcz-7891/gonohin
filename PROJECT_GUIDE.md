# Gonohin 源码导读 & 运行逻辑

> 纯前端日语电子书阅读器（React 19 + Vite 8）。本文档按「启动 → 数据 → 视图 → 翻译」的主线梳理整个程序的**运行逻辑、方法调用链、Hook 启动时机**，方便你改代码时快速定位。
>
> 快速定位某功能时，先在 **目录地图** 找到对应文件，再按本文档的 **调用链** 往下查。

---

## 1. 项目一句话

导入 EPUB / PDF / MOBI / AZW3 / TXT 电子书 → 在书架管理 → 打开进入阅读器 → 划词调用 OpenAI 兼容 API 流式翻译（普通翻译 / 深度翻译 agent loop）。

数据全部存本机（IndexedDB + localStorage），零后端，密钥在浏览器直连 API。

---

## 2. 目录地图（改代码从这查）

```
src/
├── main.jsx                       # 入口：挂载 React + 初始化主题
├── App.jsx                        # 顶层视图切换（书架 / 阅读器 / 设置），state 切换不引路由
│
├── components/
│   ├── Shelf.jsx                  # 书架：导入/删除书籍，卡片网格
│   ├── BookCard.jsx               # 书架卡片：封面/标题/进度/删除
│   ├── Reader.jsx                 # 阅读器壳：分发到具体渲染器、统一状态栏/翻页/进度/划词
│   ├── Settings.jsx               # 设置页：API Key 配置 + 连接测试 + 主题
│   ├── TranslationPopup.jsx       # 划词翻译弹窗（normal / deep 两模式）
│   └── renderers/
│       ├── TxtRenderer.jsx        # TXT：CSS columns 分页
│       ├── EpubRenderer.jsx       # EPUB：epubjs 集成
│       ├── MobiRenderer.jsx       # MOBI/AZW3：mobi-parser + iframe srcdoc
│       └── PdfRenderer.jsx        # PDF：pdfjs canvas + textLayer
│
├── hooks/
│   ├── useSelection.js            # 划词上报统一入口（监听 document + iframe）
│   └── useAutoSave.js             # 进度自动落盘（5s 定时 + 页面隐藏 flush）
│
├── lib/
│   ├── db.js                      # IndexedDB 封装（书 + 封面）
│   ├── storage.js                 # localStorage 封装（设置 + 阅读进度）
│   ├── cache.js                   # 翻译结果缓存（localStorage + LRU）
│   ├── constants.js               # 全局常量：存储 key、设置默认值、API 预设、格式、魔数
│   ├── theme.js                   # 主题解析/应用/系统监听
│   ├── importBook.js              # 导入管线：格式识别 → 元数据 → 入库
│   ├── translate.js               # 翻译核心：translateStream(普通) + translateDeep(agent loop)
│   ├── sse.js                     # 手写 SSE 解析器
│   ├── mobi.js                    # MOBI 解析补丁层（压缩映射修正 + KF8/旧版路由）
│   ├── pdf.js                     # pdfjs worker 配置 + 元数据/封面工具
│   ├── tokenize.js                # kuromoji 分词 Worker 客户端封装
│   └── tokenize.worker.js         # kuromoji 分词 Worker（词典加载 + HTML 扫描包裹 span）
│
├── utils/
│   └── text.js                    # TXT 编码检测（UTF-8 → 回退 Shift_JIS）
│
└── styles/
    └── global.css                 # 全局样式 + 主题变量（iOS 液态玻璃材质）
```

其它：
- `scripts/bench-translate.mjs` — 纯测翻译首字/分批耗时的命令行基准（不经过应用）。
- `vite.config.js` — host: true（局域网可访问）+ 端口 5173。
- `public/dict/*.gzip` — kuromoji 词典（本机托管，静态部署可用）。
- `er.name` — git 配置残留，已 gitignore，勿提交。

---

## 3. 启动 / 初始加载流程

```
index.html
  └─ <script type="module" src="/src/main.jsx">
     ├─ import { StrictMode } from 'react'
     ├─ import { createRoot } from 'react-dom/client'
     ├─ import { initTheme } from './lib/theme'
     │
     └─ main.jsx 执行体：
        1. initTheme()                        ← 先套主题，避免首帧闪白
        2. createRoot(document.getElementById('root'))
           .render(<StrictMode><App /></StrictMode>)
```

### `App.jsx`（顶层切换）
- **state**：`view`（'shelf' | 'reader' | 'settings'）、`books`（书列表）、`activeBook`（当前打开的书）。
- **`refreshBooks()`**：`getAllBooks()` 后 `setBooks`。
- **`useEffect(() => refreshBooks(), [refreshBooks])`**：首次挂载即拉取书架。
- **`openBook(book)`**：`setActiveBook + setView('reader')`。
- **`closeReader()`**：`setActiveBook(null) + setView('shelf') + refreshBooks()`（回来刷新进度）。
- 渲染三选一：`Shelf` / `Reader` / `Settings`。**不引 react-router，纯 state 切换。**

> ⚠️ StrictMode 在开发模式下会**双调用** effect 与某些函数，若你在 effect 里做重复副作用（如重复挂载事件），注意清理函数要写对称。

---

## 4. 数据层（两条存储线）

### 4.1 IndexedDB —— 书籍本体（`lib/db.js`）
单库 `gonohin-db`，单 store `books`，keyPath `id`。
- `openDB()`：懒加载、缓存 Promise（`dbPromise`），`onupgradeneeded` 建 store。
- `run(mode, fn)`：开事务，`t.oncomplete` 里 resolve `req.result`。
- 导出 API：
  - `putBook(record)` → `run('readwrite', store.put)` — 记录含 `{ id,title,author,format,size,addedAt,blob }`。
  - `putCover(bookId, coverBlob)` — 封面单独存，key 为 `'cover:'+bookId`（避免书架反复读全书 blob）。
  - `getBook(bookId)` / `getCover(bookId)` / `getAllBooks()`（过滤掉 `cover:` 前缀） / `deleteBook(bookId)`（删书 + 删封面）。

> 改存储结构（如加字段）注意：IDB 升级要 bump `openDB` 的版本号并写 `onupgradeneeded` 迁移逻辑。

### 4.2 localStorage —— 设置 / 进度 / 翻译缓存
- 设置 `gonohin:settings`（`storage.js`）：`getSettings()` 与 `DEFAULT_SETTINGS` 深度合并（容忍缺字段）；`setSettings(partial)` 合并写回。
- 进度 `gonohin:progress:<bookId>`（`storage.js`）：`getProgress` / `saveProgress`（自动补 `updatedAt`）。
- 翻译缓存 `gonohin:trans:...`（`cache.js`，见第 8 节）。

三块都做了 `try/catch` 兜底，存储不可用时**静默降级**，不影响阅读 / 翻译。

---

## 5. 书架 `Shelf.jsx`

- **state**：`covers`（bookId → blobURL 映射，懒加载）、`importing`、`notice`（顶部提示条）。
- **`useEffect([books])`**：逐本调 `getCover(b.id)` → `URL.createObjectURL(blob)` 存入 `covers` + `coversRef`（卸载时统一 `revokeObjectURL`，用 ref 读最新值）。
- **`handleFiles(e)`**：`[...e.target.files]` → 循环 `importBook(f)`，失败 `showNotice('error', reason)`，完成后 `onImported()`（= 父层的 `refreshBooks`）。
  - `e.target.value = ''`：清空，允许重复选同一文件。
- **`handleDelete(book)`**：`confirm` 确认 → revoke 封面 URL → `deleteBook(book.id)` → `showNotice('info','已删除')` → `onImported()`。
- **`BookCard`**：封面（无则显示格式回退）、进度条（`progress.percentage`）、删除按钮（`stopPropagation` 防触发打开）。

---

## 6. 导入管线 `lib/importBook.js`

```
importBook(file)
  ├─ detectFormat(file)                          # 魔数双保险
  │    ├─ 前 4KB：'%PDF-' → PDF ; 'PK\x03\x04' → EPUB ; 子串 'BOOKMOBI' → MOBI
  │    └─ 无魔数 → 按扩展名(FORMAT_BY_EXT) 兜底；azw3 也归 MOBI；否则默认 TXT
  ├─ extractMeta(format, file, blob)             # 按格式提取元数据 + 封面 Blob
  │    ├─ EPUB → ePub(blob).metadata + book.cover → fetch blob
  │    ├─ PDF  → extractPdfMeta + renderPdfCover（见 pdf.js）
  │    │         import ./pdf.js 挂副作用：确保 pdfjs worker 先配置
  │    ├─ MOBI → initMobiFixed(File) → getMetadata + getCoverImage
  │    └─ TXT  → 用文件名兜底，无封面
  ├─ 去重：同 title + format + size 视为同一本，命中返回失败
  ├─ putBook({ id: `${format}-${Date.now()}-${rand}` , ... , blob })
  └─ 若有封面 putCover(id, coverBlob)
```

- 成功：`{ ok:true, reason:null }`；失败：`{ ok:false, reason:'解析失败：…' }`，完整堆栈打进 console，页面只显示摘要。

---

## 7. 阅读器 `Reader.jsx` 与四种渲染器

### 7.1 Reader 壳（`Reader.jsx`）
**职责**：按 `book.format` 分发到具体渲染器，统一：状态栏、字号、键盘翻页、划词、进度保存。

关键 state / ref：
- `initialProgress`：`getProgress(book.id)`（挂载时读一次）。
- `fontSize`（默认取进度里的，否则 18，范围 MIN/MAX 14/32）。
- `theme`：`resolveTheme(getSettings().theme)`。
- `selectMode`：划词模式。触屏默认开启，可手动切换并记忆（写入进度）。
- `locRef`：进度内存对象（用 `ref`，渲染器回调只改它，落盘交给 `useAutoSave`）。
- `selection`：`{ text, context, x, y, fromTouch }`，划词弹窗数据。
- `translateOpen` / `deepMode` / `copied` / `dragPct` / `actionsClosing`。
- `suppressUntilRef`：关闭弹窗/操作条后 400ms 内忽略旧选区重放（防止「点外部关闭又立刻弹回」）。

**关键函数 / 逻辑**：
- `handleProgress(loc)`：更新 `locRef.current` + `setStatus`（只内存），落盘交给 `useAutoSave`。
- `useAutoSave(book.id, () => 可保存的进度)`：见第 10 节。
- `handleSelection(sel)`：统一划词入口。丢弃空/纯标点选区（`PUNCT_ONLY_RE`）；若在 `suppressUntilRef` 窗口内则忽略；否则 `setSelection + setTranslateOpen(false) + setDeepMode(false)`。
- `useSelection(handleSelection)`：见第 10 节。TXT/PDF 走主 document，MOBI 走 iframe 通道，EPUB 走 epubjs 内置 `selected` 事件（不经这个 hook）。
- 翻页后清选区（`useEffect([status?.pageIndex])`）。
- `closeActions()`：退场动画，播完（200ms）后清选区。
- `copySelection()`：优先 `navigator.clipboard`，非 HTTPS 回退 `execCommand('copy')`（textarea 隐藏法）。
- 键盘监听：← ＝ `apiRef.current.prev()`，→ ＝ `next()`。
- **进度条**：`<input type=range value=dragPct ?? pct*10>`，`onInput` 只更新滑块（防卡顿），`onChange` 才 `goToPercent(value/1000)`。

**渲染分发**：
```
book.format === TXT   → <TxtRenderer ref=apiRef .../>
book.format === EPUB  → <EpubRenderer ref=apiRef .../>
book.format === MOBI  → <MobiRenderer ref=apiRef selectMode theme .../>
book.format === PDF   → <PdfRenderer ref=apiRef .../>
```
所有渲染器通过 `useImperativeHandle` 暴露 `{ next, prev, goToPercent? }` 给 `apiRef`。

**触屏/鼠标分支**：`IS_TOUCH`（`navigator.maxTouchPoints>0 || matchMedia('(hover:none)')`）。
- 鼠标：划词直接弹 `TranslationPopup`。
- 触屏：先弹自绘「复制 / 翻译 / 深度翻译」操作条（`sel-actions`），点「翻译」才开弹窗；深度翻译有 `MAX_DEEP_LEN` 上限禁用。

### 7.2 TxtRenderer（CSS columns 分页）
- 流程：`decodeTxt(blob)` → 文本 → `useLayoutEffect` 量容器宽度 → `colWidth` → 分页（一屏一列，`columnWidth` + `columnGap` 40px）。
- 页码计算：`totalPages = scrollWidth / (colWidth+GAP)`，`pageIndex = scrollLeft / step`，rAF 节流上报 `onProgress({pageIndex,totalPages,percentage})`。
- 滚动停止后**吸附**到最近完整页（`scrollTo smooth`）。
- `useImperativeHandle`：`next/prev` = `scrollTo` 一列步进；`goToPercent` = 算目标页对齐列宽步长。
- 初始进度恢复：`pageIndexRef = progress.pageIndex`，列宽/文本就绪后 `scrollLeft = pageIndex*(colWidth+GAP)`。
- 划词天然在主 document（选区可能跨页，优点：不切文本）。

### 7.3 PdfRenderer（pdfjs canvas + textLayer）
- worker 在 `lib/pdf.js` 顶层 `GlobalWorkerOptions.workerSrc = ...?url` 配置（必须早于首次 getDocument，否则回退主线程阻塞）。
- 流程：`book.blob.arrayBuffer()` → `loadPdf(data)` → 按 `pageNum` 渲染单页：
  - `getPage(pageNum)` → 按容器宽缩放 viewport → 建 `pageDiv`（relative），内嵌 `textDiv`(textLayer) + `canvas`。
  - `page.render(...)` → `new pdfjsLib.TextLayer({ textContentSource, container, viewport })` → 渲染文本层（可划词）。
  - `onProgress({ pageNum, totalPages, percentage })`。
- `useImperativeHandle`：`next/prev` = 改 `pageNum`；`goToPercent` = 按总页数算目标页。
- 保护：`cancelled` 标记防止切页/卸载后的异步 render 误 setState；`page.cleanup()` 释放资源。
- textLayer 在主文档 DOM → 划词走 `useSelection` 的 document 通道。

### 7.4 EpubRenderer（epubjs 集成）
- 流程：`ePub(await blob.arrayBuffer())` → `book.renderTo(container, { flow:'paginated', spread:'none' })` → 设主题背景/字号 → 恢复进度：
  - 有 `progress.cfi` → `rendition.display(cfi)`，否则 `rendition.display()`。
- **进度上报** `rendition.on('relocated', loc => onProgress({ cfi, pageIndex, totalPages, percentage }))`。
- **划词** `rendition.on('selected', (cfiRange, contents) => ...)`：取 `contents.window.getSelection()`，`extractEpubContext(range, doc)` 取上下文，坐标加 iframe 偏移。
- 后台生成定位索引：`bookObj.locations.generate(500)`（relocated 的 percentage 依赖它）。
- `useImperativeHandle`：`next/prev` = `rendition.next/prev`；`goToPercent` = `book.locations.cfiFromPercentage(p)`（未就绪时返回 undefined，忽略）。
- 卸载：`rendition.destroy()` + `bookObj.destroy()`（各套 try/catch，重复 destroy 会抛）。

### 7.5 MobiRenderer（mobi-parser + iframe srcdoc）
最复杂的一个，分六步：

1. **`useEffect` 解析**：`initMobiFixed(new File([book.blob], book.title))` → `m.getSpine()`。
2. **`combined`（useMemo）**：把**所有 spine 章节 body 内容拼进同一份 HTML**（不切文本，KF8 章节即使只有 3 个 spine 也能分几十上百页），并汇总 CSS href。
3. **容器宽度 → 列宽**：`ResizeObserver` 算 `colWidth` + `padX`（左右留白）。
4. **划词模式分词**：`selectMode && combined` 时用 `tokenizeHtml(combined.html)`（Worker 异步），缓存按 HTML 字符串复用（`tokCache`）；失败则维持原文，`SELECT_SCRIPT` 走 `Intl.Segmenter` 回退。
5. **组装 `srcDoc`**（useMemo）：把所有章节 CSS link + 内联样式（列分页、`.tok`、`.sel-box` 高亮）+ 正文（`selectMode && tokHtml ? tokHtml : combined.html`）+ 划词脚本 `SELECT_SCRIPT`。
6. **`handleFrameLoad`**：iframe 加载完，测量页数、恢复页码（`didRestoreRef`/`needsRestoreRef` 决定首进 vs 重载）、绑定滚动（rAF 节流 + 吸附）、`ResizeObserver` 重测，最后 `setReady(true)` 显示（避免闪到第一页再跳回）。

**翻页 API**：`next/prev` = 横向滚动一列；`goToPercent` = 算目标页对齐列宽步长。

**划词**：在 iframe 内部脚本 `SELECT_SCRIPT` 中实现（iOS 对父页面监听 iframe 内 touch 支持差，只有 iframe 自己的脚本可靠）：
- 优先命中 `<span class="tok">`（kuromoji 形态素）：单击选整词；拖动走逐字精确（`caretRangeFromPoint`），松手两端吸附到整词边界（`snapWordEnds`）。
- 未命中回退 `Intl.Segmenter` 词级选中。
- 结果通过 `window.parent.postMessage({type:'mobi-selection', text, context, x, y}, '*')` 发给父页。
- 父页 `useEffect([onSelection])` 监听 message：加 iframe 偏移转成主视口坐标 → `onSelection({...})`。
- `sandbox="allow-same-origin allow-scripts"`，`className="trans-iframe"`（供 `useSelection` 轮询绑定其内容文档）。

> ⚠️ 划词模式会先渲染原文，分词完成后**热替换**为 `<span class="tok">` 版本（不阻塞阅读；词典首载约 17MB）。

---

## 8. 翻译管线（`lib/translate.js`）

### 8.1 参数准备
- `normalizeBaseURL(url)`：去尾 `/`。
- `MAX_DEEP_LEN = 100`：深度翻译文本上限（超过直接拒绝）。
- 上下文长度控制常量在 `lib/constants.js`：`CTX_MAX=30`，`CTX_RADIUS=15`（只在上下文中截取选区周围）。
- `DRAFT_SYSTEM`：初译 system prompt（规定只翻译【待翻译】、注音格式、逐词解释、语法解释等）。

### 8.2 普通翻译 `translateStream`
```js
async function* translateStream(text, context, settings, signal, opts={fresh,cache})
```
- `fresh`：跳过缓存读取（「重新翻译」用）；`cache`：是否读写缓存（深度翻译初译草稿传 `{cache:false}`，保证整条 loop 重跑）。
- 先 `makeCacheKey({mode:'normal', text, context, model, baseURL})` 查缓存，命中则 `yield hit` 直接返回（0 次 API）。
- 否则 `for await (delta of streamChat(...))`：累加 acc 并 `yield delta`。
- **流正常结束才写缓存**（中途 abort/出错抛错，走不到写缓存行）。

### 8.3 深度翻译 `translateDeep`（agent loop）
```js
async function* translateDeep(text, context, settings, onStage, signal, opts=fresh)
```
最多 **4 次 API 调用**（初译 1 + 验证 2 + 修正 1）。`onStage` 回调：`'translating'|'verifying'|'fixing'`。

1. 校验：无 key / 空文本 / `t.length > MAX_DEEP_LEN` → 抛错。
2. 查缓存（mode 'deep'），命中直接重放最终结果。
3. **初译**：`onStage('translating')`，用 `translateStream(..., {cache:false})` 流式收集 `draft`。
4. **验证** `verify(candidate, label)`：`chatOnce`（非流式 JSON）让审校模型对照上下文/待翻译检查译文，输出 `{pass, issues, final}`。对 `pass`（boolean/string）、`issues`/`final`（string/array/object）做容错。
5. 若 `first.pass` → `final = first.final || draft`。
6. 否则 **修正**（`onStage('fixing')`）：按 `first.issues` 用 `DRAFT_SYSTEM` + user 消息流式重译，收集 `fixed`。
7. **再验证**一次：`second = verify(fixed, 2)`；`final = second.pass ? 修正后 : fixed`。
8. loop 正常跑完才 `cacheSet(...)`；`yield final`。

> `translateDeep` 只在最后 `yield` 一次，中间靠 `signal`(AbortController) 真正打断请求；`TranslationPopup` 里靠 `runId` 拦截非当前运行。

### 8.4 请求实现细节
- `chatOnce` / `streamChat` 都走 `POST {baseURL}/chat/completions`：
  - 普通/初译：`stream:true`，`temperature:0.2`，`messages` 由 `buildMessages(text, context)` 构造（有上下文则拼 `【上下文】...【待翻译】...`）。
  - `streamChat` 是 **async generator**（而非返回 Promise<generator>），配合 `for await` 使用；`yield* parseSSE(res)`。
- 非 2xx 时：尝试解析 JSON 错误体取 `err.error.message`，否则保留 `HTTP status`。
- `buildUserMsg`（deep 专用）：拼 `【上下文】`(可选) + `【待翻译】` + 额外说明。

---

## 9. SSE 解析（`lib/sse.js` `parseSSE`）

- `fetch` 的 `response.body.getReader()` → `TextDecoder(stream:true)` 累积 `buffer`。
- 按 `\n\n` 切事件，取 `data:` 开头那行，`[DONE]` 返回结束。
- `JSON.parse` 取 `choices[0].delta.content` yield；解析失败/心跳行忽略。

> 想改流式解析（如支持 usage、role、finish_reason 等字段）就在这里加。

---

## 10. Hooks（启动时机 / 生命周期）

### `useSelection(onSelect)` —— 划词上报
- 维护 `onSelectRef`（每次渲染更新最新回调，避免 effect 依赖导致重复绑定）。
- `useEffect(..., [])` 一次性：
  - `attach(doc, offsetX, offsetY)`：给某 document 挂 `mouseup` / `touchend` / `touchstart` / `selectionchange`。
    - `read(fromTouch)`：读选区 `getSelection().toString()`，取 `getBoundingClientRect()`，`extractContext(range)`（向上找最近块级元素 `P|DIV|LI|TD|BLOCKQUOTE|H1-6|SECTION|ARTICLE|DD|DT|TH|FIGCAPTION`，整段超长时以选区为中心截 `CTX_MAX/CTX_RADIUS`），调用 `onSelectRef.current({text,context,x,y,fromTouch})`。
    - iOS 长按：`touchend` 后 `requestAnimationFrame(read)` + `startPoll(2000)` 轮询兜底；`touchstart` 也会 `startPoll(2500)`。
    - `selectionchange`：防抖 250ms 后 `read(false)`。
  - `detachMain = attach(document,0,0)`。
  - `pollFrames` 每 800ms 轮询 `.trans-iframe`，对**新 contentDocument**（WeakSet 去重，注意 by-document 而非 by-element，因为 iframe 翻章后内容重载会得到新 document）绑定，offset 用 iframe 的 `getBoundingClientRect()`。
  - 返回清理：detach main + frames + 清 interval。
- **EPUB 不用本 hook**（用 epubjs 内置 `selected` 事件）。

### `useAutoSave(bookId, getPayload)` —— 进度落盘
- `getRef.current = getPayload`（每次更新）。
- `useEffect([bookId])`：
  - `flush()`：`getRef.current()` 非空则 `saveProgress(bookId, payload)`。
  - `setInterval(flush, 5000)`；`visibilitychange`（`document.visibilityState==='hidden'`）与 `beforeunload` 时立即 flush。
  - 清理：clearInterval + 两个事件监听。

> 设计：**渲染器只在内存更新进度（ref），落盘统一交给本 hook**，避免高频写 localStorage。若要改保存频率/时机，改这里。

---

## 11. 划词交互 → 弹窗的完整链路（点线图）

```
【划词动作】
   ├─ TXT/PDF(主 document) → useSelection 监听 document 上报
   ├─ MOBI(iframe)        → SELECT_SCRIPT(postMessage) → Reader 监听 message 上报
   └─ EPUB(epubjs)        → rendition.on('selected') → EpubRenderer 上报
                ↓ 都汇聚到 Reader.handleSelection(sel)
                ↓ { text, context, x, y }
        Reader 分支：
   ├─ 鼠标(非触屏)  → 直接 <TranslationPopup {...sel} mode='normal'>
   └─ 触屏(IS_TOUCH) → 先弹操作条(sel-actions)
         ├─「复制」  → copySelection()
         ├─「翻译」  → setTranslateOpen(true) → <TranslationPopup mode='normal'>
         └─「深度翻译」→ setDeepMode(true)+setTranslateOpen(true) → mode='deep'
```

### `TranslationPopup.jsx`
- `mode`：'normal'（translateStream） | 'deep'（translateDeep），弹窗内可自由切换（超长禁用 deep）。
- `source`：超 2000 字截断为「已截取前 2000 字」。
- **`run(force=false)`**：
  - `runIdRef++` + `abortRef.current?.abort()`（先打断上一次，防旧请求继续烧 token）。
  - `mode==='deep'` → `translateDeep`（带 `setStage`）；否则 `translateStream`。
  - 计时：`t0=performance.now()`，`stampFirst` 记首 token；`timing={first,total}` 展示耗时诊断。
  - `runIdRef.current !== runId` 时 return（已被重译/切模式/关闭打断）。
  - catch 只处理当前 run。
- `useEffect([text, mode])`：挂载/切模式时 `run()`；卸载时 `runIdRef++` + `abort`.（deep 只在最后 yield 一次，靠 runId 拦不住，必须真 abort）。
- 定位：`useLayoutEffect` 按实际 `offsetWidth/Height` clamp，保证底部按钮可见。
- 关闭：`handleClose` 播退场动画（200ms）→ `onClose`；`onBackdropPress` 通知父级短时忽略旧选区重放。
- 遮罩：`onPointerDown=handleClose`，盖住正文（含 MOBI iframe）拦截这次按下，防重新划词。

---

## 12. 设置页 `Settings.jsx`

- `form` 初始 `getSettings()`。
- `set(key)`：输入变化更新 form；`theme` 变更即时 `setSettings({theme})` + `applyTheme(value)`。
- `applyPreset`：选预设 → 自动填 `baseURL` + `model`。
- `save()`：`setSettings({...form, apiKey:trim, baseURL:trim})`。
- `testConnection()`：非流式 `POST {baseURL}/chat/completions`，`max_tokens:1`，`messages:[{role:'user',content:'连接测试'}]`。成功/失败分别给提示；网络错误提示「浏览器直连被 CORS 拦截时也会报这个错」。

---

## 13. 主题（`lib/theme.js`）

- `resolveTheme(theme)`：'light'/'dark' 原样，否则按 `prefers-color-scheme`。
- `applyTheme(theme)`：写 `<html data-theme>` + `style.colorScheme`。
- `initTheme()`：`applyTheme()` + 监听 `prefers-color-scheme` change（仅当设置为 'system' 时重新套用），返回清理函数。

---

## 14. 翻译缓存（`lib/cache.js`）

- 前缀 `gonohin:trans:`，`MAX_ITEMS=200`，`PROMPT_VERSION=4`（改 prompt 后 +1 让旧缓存作废）。
- `makeCacheKey({mode,text,context,model,baseURL})`：FNV-1a 32bit 哈希压成短 key；`raw`（原文拼接）随值存储，读取时比对防碰撞。
- `cacheGet(key, raw)`：比对 `item.k===raw` 且为 string 才返回。损坏/不可用视作未命中。
- `cacheSet(key, raw, value)`：写 `{k,raw,v,t:Date.now()}`，然后 `prune(200)`；配额满时删一半最旧再试一次，仍失败放弃（静默）。
- `prune(keep)`：数前缀条目，超过保留数则按 `t` 升序删到 `keep*0.7`（留余量避免每次写都触发淘汰）。

---

## 15. MOBI 解析补丁（`lib/mobi.js`）

修复 `@lingo-reader/mobi-parser` 两个问题：
1. **PalmDOC 压缩映射写反**（规范 1=PalmDOC 压缩 / 2=无压缩，库写反）→ `initMobiFixed` 按正确映射覆盖 `mf.decompress`（`palmDocDecompress` 是自实现的解压算法）后重新 `innerInit()`。
2. **hybrid / KF8 书**（version>=8）必须走 `initKf8File`（否则按 PalmDOC 记录流读会乱码）→ 先尝试 `initKf8File`，`getSpine().length>0` 命中；否则回落旧版 `initMobiFile` 再修压缩。

- `palmDocDecompress(array)`：自实现 PalmDOC LZ77 解压，import 供补丁复用。
- 导出 `initMobiFixed(file)`，调用方（importBook / MobiRenderer）都传 `new File([blob], name)`。

---

## 16. PDF 工具（`lib/pdf.js`）

- 顶层副作用：`GlobalWorkerOptions.workerSrc = workerUrl`（`pdf.worker.min.mjs?url`，静态托管可用） + import `pdf_viewer.css`（textLayer 定位）。
- `loadPdf(data)` = `pdfjsLib.getDocument({data}).promise`。
- `extractPdfMeta(data, fallback)`：`getMetadata()` → `{title, author}`，title 空用文件名，finally `destroy()`。
- `renderPdfCover(data, targetWidth=240)`：渲染第 1 页 → `canvas.toBlob('image/jpeg',0.8)`，失败返回 null（封面失败不影响导入）。

---

## 17. kuromoji 分词（`lib/tokenize.js` + `tokenize.worker.js`）

- **客户端**：懒创建 Worker，按消息 id 做请求/响应配对（`pending` Map）。`tokenizeHtml(html)` 返回包裹 `<span class="tok" data-pos="品詞">` 的新 HTML。
- **Worker**：
  - 词典来源 `DICT_BASE = import.meta.env.BASE_URL + 'dict/'`（拼绝对路径，兼容 dev / 构建后的子路径部署）。
  - `build()` 一次后缓存 tokenizer 复用。
  - 本地文件是 `.gz`，浏览器请求是 `base.dat.gz` 等 → 映射成 `.gzip`；`DecompressionStream('gzip')` 解压（若某些静态服务器自动加了 `Content-Encoding: gzip`，fetch 会自动解压，就不手动重复解压）。
  - `wrapHtml`：轻量 HTML 扫描器（Worker 里没 DOMParser），只对标签间文本段（含日文假名/汉字 `JP_RE`）分词，结构/注释/script/style 原样保留。
  - `wrapTextSegment`：按 kuromoji token 组装 span，并把部分助动词/接续助词/非自立动词**并入前词**（`MERGEABLE`），让「なかった」「並んで」「食べて」等整体成为一个可查询词；但 て/で 后面的补助动词（ください/いる/もらう）不并入（那是句式）。
  - 分词在消息处理里同步完成（先 build tokenizer，之后 tokenize 同步）。

---

## 18. 常用改动点速查（改需求先看这里）

| 想改什么 | 改哪个文件 / 常量 |
|---|---|
| 划词上下文长度（发送给模型的上文范围） | `lib/constants.js` 的 `CTX_MAX` / `CTX_RADIUS` |
| 普通/深度翻译的 prompt | `lib/translate.js` 的 `DRAFT_SYSTEM`（改完记得 `cache.js` 里 `PROMPT_VERSION` +1） |
| 深度翻译文本上限 | `lib/translate.js` 的 `MAX_DEEP_LEN`（Reader 操作条与 TranslationPopup 都引它） |
| 翻译缓存条数上限 | `lib/cache.js` 的 `MAX_ITEMS` |
| 保存进度频率 | `hooks/useAutoSave.js` 的 5000ms |
| 浏览器直连 API 被 CORS 拦 | 只能换可 CORS 的接口；测试逻辑在 `Settings.jsx` `testConnection` |
| 触屏/鼠标划词行为切换 | `Reader.jsx` 的 `IS_TOUCH` 判断 + 操作条 / `TranslationPopup` 分支 |
| 新增一种书籍格式 | `constants.js` 加枚举/扩展名/魔数；`importBook.js` detectFormat/extractMeta；`Reader.jsx` 分发；新建 renderer |
| MOBI 压缩 / KF8 异常 | `lib/mobi.js` `initMobiFixed` / `palmDocDecompress` |
| 主题配色 / 玻璃质感 | `styles/global.css` 的 `:root` 与 `[data-theme='dark']` 变量 |
| 弹窗 / 操作条动画 | `styles/global.css` 的 `glass-in` / `.exit` 相关 keyframes |
| 编辑分词规则（哪些并入一词） | `tokenize.worker.js` 的 `MERGEABLE` / `MERGEABLE` 逻辑 |
| 上线静态托管 | `npm run build` → `dist/` 部署；`vite.config.js` 的 `base`（如需子路径） |
| 局域网手机访问 | 已开 `host:true` + 5173 端口，看终端打印的 Network 地址 |

---

## 19. 数据存储 Key 一览（调试 / 清缓存）

| key | 内容 | 位置 |
|---|---|---|
| `gonohin:settings` | `{apiKey, baseURL, model, theme}` | localStorage |
| `gonohin:progress:<bookId>` | `{...进度, fontSize?, selectMode?, updatedAt}` | localStorage |
| `gonohin:trans:<hash>` | `{k: raw, v: 译文, t: 时间}`（LRU） | localStorage |
| `gonohin-db` / store `books` | 书记录（含 blob）+ `cover:<id>` 封面 | IndexedDB |

> 想要「重新翻译某段 / 强制刷新」：`TranslationPopup` 的「重新翻译」按钮传 `fresh:true` 跳过缓存读取，但新结果仍写回。
