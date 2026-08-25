# Gonohin 架构与代码速查

一个纯前端的日语翻译阅读器：导入 EPUB / PDF / MOBI / AZW3 / TXT，可在阅读时滑词调 AI 翻译（OpenAI 兼容 API，浏览器直连）。无后端、无路由库、无 UI 库，全部 React + Vite。

本文件按「数据流」组织，帮你快速定位：改一处逻辑该动哪个文件、哪个函数、哪些钩子。

---

## 1. 技术栈与关键依赖

| 领域 | 用的东西 |
|---|---|
| 框架 | React 19 + Vite（`src/main.jsx` 挂载） |
| 路由 | 无，App.jsx 用 `view` state 切换三视图（书架/阅读器/设置） |
| 数据存储 | IndexedDB（书本体+封面）、localStorage（设置+进度+翻译缓存） |
| MOBI 解析 | `@lingo-reader/mobi-parser`（有一层补丁 `lib/mobi.js`） |
| EPUB 解析 | `epubjs` |
| PDF 解析 | `pdfjs-dist`（worker 用 `?url` 导入） |
| 日语分词 | `@patdx/kuromoji`，跑在 Web Worker（`lib/tokenize.worker.js`） |
| 翻译 | 自定义 SSE 解析器，OpenAI 兼容 `/chat/completions` |

---

## 2. 目录结构

```
src/
├── main.jsx                     # 入口：initTheme + React 挂载
├── App.jsx                      # 顶层三视图切换（shelf/reader/settings）
├── components/
│   ├── Shelf.jsx                # 书架（导入/删除/列表）
│   ├── BookCard.jsx             # 单张书卡片（封面/标题/进度/删除）
│   ├── Reader.jsx               # 阅读器壳：分发渲染器、进度、划词、弹窗
│   ├── Settings.jsx             # 设置页（API Key/baseURL/model/主题）
│   └── TranslationPopup.jsx     # 翻译弹窗（流式显示、重译/复制/切换模式）
│   └── renderers/
│       ├── TxtRenderer.jsx      # TXT：CSS columns 分页
│       ├── EpubRenderer.jsx     # EPUB：epubjs 集成
│       ├── MobiRenderer.jsx     # MOBI：iframe srcdoc + 划词脚本
│       └── PdfRenderer.jsx      # PDF：canvas + textLayer
├── hooks/
│   ├── useSelection.js          # 划词统一监听（TXT/PDF 主文档 + MOBI iframe）
│   └── useAutoSave.js           # 进度自动落盘（5s 定时 + 页面隐藏）
├── lib/
│   ├── constants.js             # 常量：设置默认值、API 预设、导出格式、上下文长度
│   ├── storage.js               # localStorage 封装（设置 + 进度）
│   ├── db.js                    # IndexedDB 封装（shelf 用）
│   ├── importBook.js            # 导入管线：格式识别→元数据→入库
│   ├── translate.js             # 翻译核心：普通流式 + 深度 agent loop
│   ├── sse.js                   # 手写 SSE 解析器
│   ├── cache.js                 # 翻译结果 LRU 缓存（localStorage）
│   ├── tokenize.js              # 分词 Worker 客户端封装
│   ├── tokenize.worker.js       # kuromoji 分词 Worker + HTML 扫描包裹
│   ├── theme.js                 # 主题（system/light/dark）
│   ├── mobi.js                  # mobi-parser 补丁层
│   ├── pdf.js                   # pdfjs 集成（worker 配置 + 工具）
│   └── storage.js
├── utils/text.js                # TXT 编码检测（UTF-8/Shift_JIS）
└── styles/global.css            # 全部样式（CSS 变量做主题）
```

---

## 3. 启动流程

```
src/main.jsx
  ├─ initTheme()              → 应用主题到 <html data-theme>，跟随系统时监听切换
  └─ createRoot().render(<StrictMode><App/></StrictMode>)
        └─ App 挂载后 useEffect → refreshBooks() → getAllBooks() → 展示书架
```

注意：`StrictMode` 会让开发环境的 `useEffect` 执行两次（有 cleanUp 的钩子会 mount→unmount→mount），调试时不要把它当成 bug。

---

## 4. 数据层（内存之外的一切都在这里）

### 4.1 IndexedDB —— `lib/db.js`

单库 `gonohin-db`、单 store `books`，keyPath 为 `id`。

| 函数 | 用途 |
|---|---|
| `putBook(record)` | 存书（含 Blob 大字段） |
| `putCover(bookId, blob)` | 单独存封面，key = `cover:` + id |
| `getBook(bookId)` | 取完整记录（含 blob） |
| `getCover(bookId)` | 取封面 Blob，没有返回 null |
| `getAllBooks()` | 所有书的元数据（过滤掉 `cover:` 前缀的条目） |
| `deleteBook(bookId)` | 删书 + 封面 |

关键点：一条书记录 `put(record)` 存全量（含 Blob 可结构化克隆）；封面单存一个 key，避免书架反复读整本书的 Blob。

### 4.2 localStorage —— `lib/storage.js`

| 封装 | 存储 key | 内容 |
|---|---|---|
| `getSettings()` / `setSettings()` | `gonohin:settings` | `{ apiKey, baseURL, model, theme }`，读取时与 `DEFAULT_SETTINGS` 深合并 |
| `getProgress(bookId)` / `saveProgress(bookId, p)` | `gonohin:progress:<id>` | 阅读进度（见 7.4），写入时自动带 `updatedAt` |

### 4.3 翻译缓存 —— `lib/cache.js`

localStorage 里的 LRU 缓存，`key` 前缀 `gonohin:trans:`。

- `makeCacheKey({mode, text, context, model, baseURL})` → `{ key, raw }`
  - `raw` 是 `[PROMPT_VERSION, mode, text, context, model, baseURL].join(分隔符)`；`key` 是它的 FNV-1a 哈希，`raw` 随值暂存，读取时比对防碰撞。
- `cacheGet(key, raw)`：比对 `raw` 一致才命中。
- `cacheSet(key, raw, value)`：写入，超 `MAX_ITEMS` 时按时间戳淘汰（LRU）。
- `PROMPT_VERSION`：**改任意翻译提示词后必须 +1**，否则旧 token 会命中错误缓存。这非常重要（改 `translate.js` 的 `DRAFT_SYSTEM` / 验证 / 修正 prompt 时都要同步改这里）。

---

## 5. 书籍导入管线 —— `lib/importBook.js`

`importBook(file)`：

```
detectFormat(file)        # 扩展名 + 魔数双保险
  → PDF:  %PDF-       头
  → EPUB: PK\x03\x04  头
  → MOBI: 头4KB里子串 "BOOKMOBI"
  → 无魔数按扩展名；都不匹配则默认 TXT

extractMeta(format, file, blob)   # 按格式取 title/author/coverBlob
  → EPUB: epubjs metadata + cover
  → PDF:  pdfjs getMetadata + renderPdfCover
  → MOBI: mobi.getMetadata + getCoverImage

去重：同 title+format+size 视为同一本 → 返回 { ok:false, reason:'已在书架上' }

putBook({id, title, author, format, size, addedAt, blob})
putCover(id, coverBlob)
```

- `id` 是 `format-时间戳-随机串`，不用哈希（避免碰撞）。
- 失败时 `console.error` 完整堆栈，页面只显示摘要 `reason`。
- `Shelf.jsx` 调它后 `onImported()` → `App.refreshBooks()` 刷新列表。

---

## 6. 视图切换 —— `App.jsx`

`view` state：`'shelf'` / `'reader'` / `'settings'`。

```jsx
view === 'shelf'    → <Shelf books={books} onOpen onImported onSettings />
view === 'reader'   → <Reader book={activeBook} onBack={closeReader} />   // 仅当 activeBook 存在
view === 'settings' → <Settings onBack={() => setView('shelf')} />
```

- `openBook(book)`：设 `activeBook` 然后切到 reader。
- `closeReader()`：清 activeBook、切回 shelf、`refreshBooks()`（刷新进度条）。

---

## 7. 阅读器壳与四个渲染器

### 7.1 `Reader.jsx` 壳

职责：**分发渲染器 + 统一进度 + 统一划词入口 + 弹翻译弹窗**。

- 状态：
  - `selectMode`：划词模式开关（默认触屏开；进度里记住用户选择）
  - `selection`：`{ text, context, x, y }`，来自渲染器划词上报
  - `translateOpen` / `deepMode`：触屏操作条是否已点「翻译/深度翻译」
  - `status`：`{ pageIndex, totalPages }` 用于状态栏
  - `fontSize` / `theme`：字号、主题
- 核心回调：
  - `handleProgress(loc)` → 更新内存 `locRef` + `setStatus`（不落盘，落盘交给 useAutoSave）
  - `handleSelection(sel)` → 划词统一入口：纯标点/空白丢弃；**设 suppression 窗口**；否则 `setSelection(sel)` 并回到操作条
- 翻页 API：`apiRef.current.next()/prev()/goToPercent(p)`，由各渲染器 `useImperativeHandle` 暴露。
- 键盘：`←/→` 翻页。
- `useSelection(handleSelection)` 挂划词监听（TXT/PDF 主文档 + MOBI iframe）。

**分格式渲染**：
```jsx
book.format === TXT  → <TxtRenderer … />
book.format === EPUB → <EpubRenderer … />
book.format === MOBI → <MobiRenderer … selectMode theme … />
book.format === PDF  → <PdfRenderer … />
```

### 7.2 四个渲染器对照

| 渲染器 | 解析 | 分页/翻页 | 划词通道 |
|---|---|---|---|
| `TxtRenderer` | `decodeTxt`（UTF-8/Shift_JIS） | CSS columns，`scrollLeft` 步进 | 主文档，走 `useSelection` |
| `PdfRenderer` | `pdfjs` | 单页 canvas，`pageNum` | 主文档 textLayer，走 `useSelection` |
| `EpubRenderer` | `epubjs` | epubjs 内置 paginated | epubjs `selected` 事件 |
| `MobiRenderer` | `initMobiFixed` | iframe 内 CSS columns | iframe 内自定义脚本 |

#### 7.2.1 TxtRenderer
- `decodeTxt(book.blob)` 解码（UTF-8 失败率高时回退 Shift_JIS）。
- 用 `useLayoutEffect` 量列宽并`页面恢复`（避免闪到第一页再跳回）。
- 进度上报 `onProgress({pageIndex, totalPages, percentage})`。
- 暴露 `next/prev/goToPercent`（改 `scrollLeft`）。

#### 7.2.2 PdfRenderer
- 每页渲染 canvas + pdfjs `TextLayer` 叠层（划词靠 textLayer）。
- 翻页 = `setPageNum`；`pageNum` 初始来自 `progress.pageNum`。
- 暴露 `next/prev/goToPercent`。

#### 7.2.3 EpubRenderer
- `rendition.on('selected', (cfiRange, contents) => …)` 捕获选区 → 弹窗。上下文用 `extractEpubContext(range, doc)`（注意 selectNode 用 iframe 的 Range）。
- 进度依赖 `relocated` 事件，`bookObj.locations.generate(500)` 后台生成定位索引。
- 暴露 `next/prev/goToPercent`（`cfiFromPercentage` 未就绪时忽略跳页）。

#### 7.2.4 MobiRenderer（最复杂，划词在 iframe 内）
- 用 `initMobiFixed(new File([blob], title))` 解析，把**所有 spine 章节拼成一份连续文档**，CSS columns 分页。
- 组装 `srcDoc`（`useMemo`），`selectMode` 时把分词结果 `tokHtml` 注入并注入 `SELECT_SCRIPT`。
- **iframe 加载后 `handleFrameLoad` 恢复页码**（`needsRestoreRef`/`didRestoreRef` 控制是否恢复），并 setReady 再显示。
- iframe 内脚本通过 `postMessage({type:'mobi-selection', …})` 上报选区，父页 `onMessage` 加 iframe 偏移后交给 `onSelection`。
- 暴露 `next/prev/goToPercent`（滚动一列）。

---

## 8. 划词翻译链路（核心，最容易改出问题的地方）

### 8.1 三条上报通道

| 格式 | 通道 | 位置 |
|---|---|---|
| TXT / PDF | 主文档 `mouseup/touchend/selectionchange` | `hooks/useSelection.js`（attach 到 `document`） |
| MOBI | iframe 内自带脚本事后门 | `MobiRenderer.jsx` 的 `SELECT_SCRIPT` |
| EPUB | epubjs 内置 `selected` | `EpubRenderer.jsx` |

### 8.2 `useSelection.js`

> TXT/PDF 与 MOBI iframe 内容文档都走这里。

- `attach(doc, offsetX, offsetY)` 在某 document 上监听：
  - `mouseup` / `touchend` / `touchstart` / `selectionchange`
  - `read()`：取选区 `getSelection()`，算 `getBoundingClientRect()`（+偏移转换到主视图坐标），再 `extractContext(range)` 取上下文，回调解发。
  - iOS 长按：`touchend` 后轮询一小段窗口兜底（选区可能延迟提交）。
- `extractContext(range)`：向上找最近块级元素（P/DIV/LI…），取整段；超过 `CTX_MAX` 时以选区为中心截取左右各 `CTX_RADIUS` 字（见 10.3）。
- 主文档 `attach(document, 0, 0)` + 轮询 `iframe.trans-iframe` 自动绑定内容文档（MOBI 翻章后 contentDocument 会变，按文档标记而非元素标记）。

### 8.3 `MobiRenderer` 的 `SELECT_SCRIPT`（iframe 内自定义划词）

`srcdoc` 里内联的一段脚本（字符串），跑在 iframe 内部（iOS 对父页给 iframe 挂 touch 监听支持差）。

- 禁用系统选择、`touch-action: none`。
- 选词优先级：
  1. 命中 kuromoji 分词 `<span class="tok">` → 单击=整词；
  2. 拖动时逐字精确区间（`caretRangeFromPoint`），松手后两端吸附到整词边界（`snapWordEnds`）；
  3. 未命中回退 `Intl.Segmenter`（`wordFromCaret`）。
- 高亮：自绘 `sel-layer` / `sel-box`（拖动中 rAF 合帧增量更新，不重建整层）。
- 上报：`window.parent.postMessage({type:'mobi-selection', text, context, x, y}, '*')`。

### 8.4 弹窗交互 —— `TranslationPopup.jsx`

- props：`text, context, x, y, mode('normal'|'deep'), onClose, onBackdropPress`。
- `run(force)`：
  - 递增 `runIdRef`，abort 上一次，新建 `AbortController`；
  - `mode==='deep'` → `translateDeep(...)`；否则 `translateStream(...)`；
  - `for await` 逐 delta `setResult(prev=>prev+delta)`，`stampFirst()` 记录首字耗时；
  - 结束 `setLoading(false)` 并 `setTiming({first, total})`（底部显示的“首字 Xms · 总 Yms”，用于诊断慢在哪）。
- 遮罩：`.trans-backdrop` 盖住正文（含 MOBI iframe），`onPointerDown` 关闭且**不触发新一轮划词**；`onBackdropPress` 触发父级 suppression。
- 关闭退场动画：`setClosing(true)` → 200ms 后真正 `onClose`。

### 8.5 抑制窗口（防止“关掉又弹回来”）

`Reader.jsx` 里 `suppressUntilRef` + `suppressSelection()`：关闭操作条/弹窗时设 `now+400ms`，`handleSelection` 在该窗口内**忽略同选区的再次上报**。因为 TXT/PDF 的旧选区留在文档里，关闭后 touchend 会重新上报同一个选区，不拦就立即又弹出来。MOBI/EPUB 选区在 iframe 内，但统一拦也无害。

---

## 9. 翻译管线 —— `lib/translate.js`

两条管线，都写缓存、都能被信号 cancel。

### 9.1 请求构造

```js
buildMessages(text, context) → messages
  // 有 context 时：
  //   【待翻译】\n{text}\n\n【上下文】（仅供理解语境，不要翻译）\n{context}
  // 无 context 时：直接 {text}
```

`DRAFT_SYSTEM`（当前）关键指令：
1. 只翻译【待翻译】，上下文不能翻译/解释；
2. 词汇解释：优先把相邻汉字合并成整体词条（如「捜査一課（そうさいっか）」），不要逐字拆；
3. 复合词读音不一定是单字拼接，注音前检查。

> ⚠️ 改这里的任何文字后，必须把 `cache.js` 的 `PROMPT_VERSION` **+1**。

### 9.2 `translateStream` — 普通翻译（单次流式）

```js
translateStream(text, context, settings, signal, opts)
  → 查缓存（cache= true 且 !fresh 时）命中直接 yield 重放
  → 否则 streamChat()（stream:true，temperature:0.2）逐 delta yield
  → 流正常结束才 cacheSet
```

- `opts.fresh`：跳过缓存读取（「重新翻译」用），结果仍写回。
- `opts.cache=false`：不读不写（深度翻译的初译草稿用）。

### 9.3 `translateDeep` — 深度翻译（agent loop）

对任意选区：**初译 → 验证 → 修正 → 再验证**，最多 4 次 API。

1. `translateStream(…, {cache:false})` 初译草稿（流式）。
2. `chatOnce`（非流式）验证：传入 system（审校）+ user（含译文），期望返回 `{"pass":true/false, "issues":"…", "final":"…"}`，用 `extractJSON` 稳健解析（兼容纯 JSON / 代码块 / 前后说明文字）。
3. 若 fail → 流式按审校意见重译 → 再验证一轮。
4. 最后 `cacheSet` 整个 loop 的最终结果，只 `yield final` 一次。

`MAX_DEEP_LEN = 100`：超过 100 字拒绝深度翻译（避免多轮烧钱）。
`onStage` 回调：`'translating' | 'verifying' | 'fixing'`，弹窗据此显示阶段。

---

## 10. 分词 —— `lib/tokenize.js` + `tokenize.worker.js`

### 10.1 客户端封装 `tokenize.js`

- 懒创建 Worker（`new Worker(new URL('./tokenize.worker.js', import.meta.url), {type:'module'})`）。
- 按消息 id 配对：`pending` Map，`worker.onmessage` 里 resolve/reject。
- `tokenizeHtml(html)` → 返回包好 `<span class="tok" data-pos="品詞">` 的新 HTML。

### 10.2 Worker `tokenize.worker.js`

- kuromoji 在 Worker 跑，避免大书分词卡 UI。
- 词典随应用本地托管在 `public/dict/`（从 `@patdx/kuromoji/dict` 复制，`.gz` 改名 `.gzip`，避免静态服务器加 `Content-Encoding: gzip` 导致二次解压报错）。
- `DICT_BASE = import.meta.env.BASE_URL + 'dict/'`（dev 和 build 后都是 `/dict/`）。
- **词典用 `DecompressionStream('gzip')` 解压**。
- 无 `DOMParser`，用轻量扫描器（`wrapHtml`）只对文本段分词，结构原样保留。
- 合并规则（`wrapTextSegment`）：助动词/接续助词并入前一个动词/形容词/助动词；非自立/接尾动词仅在直接接连用形词干时并入；`て/で` 后的补助动词不并（那是句式）。
- `MERGEABLE = {動詞, 形容詞, 助動詞}`；`JP_RE` 只对含日文假名/汉字的段分词。

---

## 11. 其它

### 11.1 主题 —— `lib/theme.js`

- `resolveTheme()`：`light`/`dark` 直接返回；`system` 查 `matchMedia('(prefers-color-scheme: dark)')`。
- `applyTheme()`：写 `<html data-theme>` + `style.colorScheme`，组件通过 CSS 变量换肤。
- `initTheme()`：启动应用 + 跟随系统时监听切换。
- `Settings.jsx` 里改主题走 `setSettings({theme})` + `applyTheme(theme)`。

### 11.2 设置 —— `Settings.jsx`

- `form` 初始 `getSettings()`；`applyPreset` 从 `API_PRESETS` 填充 baseURL+model。
- `testConnection()`：非流式 `max_tokens:1`，`{ok, message}`。
- 存 `localStorage`，浏览器直连 API，不经过任何服务器。

### 11.3 进度落盘 —— `hooks/useAutoSave.js`

- `useAutoSave(bookId, getPayload)`：5s 定时 flush + `visibilitychange`(hidden) + `beforeunload` 立即 flush。
- `getPayload()` 从 ref 读最新 loc，返回 null 则跳过（无有效进度）。

---

## 12. 关键常量与「改这里全局生效」的开关

集中在 `lib/constants.js` 与 `lib/cache.js`：

| 常量 | 作用 | 改动影响 |
|---|---|---|
| `CTX_MAX` / `CTX_RADIUS` | 翻译上下文长度上限 / 选区两侧截取半径 | 输入 token 量；改这里全局生效（三处取上下文都读取它） |
| `API_PRESETS` | 设置页的服务商预设 | 增删改预设 |
| `DEFAULT_SETTINGS` | 默认 baseURL（DeepSeek）/ model / theme | 首次打开默认值 |
| `MAX_SOURCE_LEN` (TranslationPopup) | 弹窗原文显示截断长度 2000 | 只影响弹窗显示 |
| `MAX_DEEP_LEN` (translate) | 深度翻译文本上限 100 | 深度开关禁用条件 |
| `PROMPT_VERSION` (cache) | 缓存版本号 | **改 prompt 后必须 +1** |
| `PUNCT_ONLY_RE` (Reader) | 纯标点/空白选区丢弃 | 划词过滤 |

---

## 13. 常见「我想改X」→ 到哪改

| 想改 | 文件 | 具体位置 |
|---|---|---|
| 翻译结果更准/更全 | `lib/translate.js` | `DRAFT_SYSTEM`（普通）、`chatOnce` 的验证 system（深度） |
| 翻译慢/首字慢 | 设置里换 model；`lib/constants.js` 的 `CTX_MAX` | 见第 12 节 |
| 上下文太长/太短 | `lib/constants.js` | `CTX_MAX` / `CTX_RADIUS` |
| 缓存不生效/旧结果弹回 | `lib/cache.js` | `PROMPT_VERSION` +1 |
| 划词选不中想要的词 | `MobiRenderer.jsx` `SELECT_SCRIPT` | `wordFromCaret` / `snapWordEnds` |
| 弹窗点外面关不掉 | `TranslationPopup.jsx` | `trans-backdrop` + `onPointerDown` |
| 关弹窗又立刻弹回来 | `Reader.jsx` | `suppressSelection` / `suppressUntilRef` |
| 恢复阅读位置闪第一页 | `TxtRenderer`（useLayoutEffect）/ `MobiRenderer`（ready 门控） | 见 7.2 |
| 进度条 iOS 拖不动 | `styles/global.css` | `::-webkit-slider-thumb` 宽度 |
| 新增一种书籍格式 | `lib/importBook.js` + `components/renderers/` 新渲染器 | `detectFormat` + 渲染器 + `FORMATS` |
| 换/加 API 服务商 | `lib/constants.js` | `API_PRESETS` |
| 设置页加选项 | `components/Settings.jsx` + `lib/storage.js` | `form`/`set` |

---

## 14. 调试提示

- **计时**：翻译弹窗底部会显示「首字 Xms · 总 Yms」。首字≈服务端首 token 延迟（你看到的主要等待），总-首字≈生成耗时。首字高基本是服务端/网络/排队，与应用无关。
- **分支/缩放的闪页**：MOBI 用 `ready` 门控（`visibility:hidden` 恢复后再显示），TXT 用 `useLayoutEffect`。加了新渲染逻辑时保持同样的「先隐藏/首帧前定位」思路。
- **StrictMode 双执行**：开发模式 useEffect 跑两次，别当 bug。
- **词典加载**：`public/dict/*.gzip` 是 gzip 压缩的 kuromoji 词典，千万别把 `.gzip` 改回 `.gz`（见 worker 注释）。
