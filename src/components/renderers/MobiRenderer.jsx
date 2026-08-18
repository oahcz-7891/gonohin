// MOBI 渲染器：@lingo-reader/mobi-parser 解析 + iframe srcdoc 渲染
// 分页策略：把整本书（所有 spine 章节）拼进同一个文档，用 CSS columns 按视口宽度分页，
// 翻页 = iframe 内横向滚动。这样 KF8 书即使只有 3 个 spine 也能正常显示几十上百页。
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { initMobiFixed } from '../../lib/mobi'

const READING_FONT =
  "'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP', 'Songti SC', serif"
const GAP = 40 // column-gap 固定 40px，与 step 计算一致

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/** 从章节 HTML 中提取 body 内部内容；无 body 的碎片（KF8 章节）则原样使用 */
function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return m ? m[1] : html
}

// 划词逻辑直接跑在 iframe 内部：iOS WebKit 对“父页面给 iframe 内容挂 touch 监听”支持很差，
// 只有 iframe 自己的脚本才可靠。iframe 内选中后通过 postMessage 把 {text,x,y} 交给父页面。
const SELECT_SCRIPT = `
<script>
(function () {
  'use strict'
  var scroller = document.querySelector('.mobi-scroll')
  if (!scroller || !window.parent) return
  scroller.style.touchAction = 'none'
  document.documentElement.style.webkitUserSelect = 'none'
  document.documentElement.style.userSelect = 'none'
  document.documentElement.style.webkitTouchCallout = 'none'
  // iOS iframe 内 touch 监听需要 document 上先有监听才会稳定触发
  document.addEventListener('touchstart', function () {}, { passive: true })

  var layer = null
  function clearHighlight() {
    if (layer) { layer.remove(); layer = null }
  }
  // 拖动中每帧增量更新高亮：复用已有 sel-box，只增删差额，避免整层重建的 GC/重排
  function updateHighlight(range) {
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'sel-layer'
      scroller.appendChild(layer)
    }
    var rects = range.getClientRects()
    var n = 0
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i]
      if (!r.width || !r.height) continue
      var box = layer.children[n]
      if (!box) {
        box = document.createElement('div')
        box.className = 'sel-box'
        layer.appendChild(box)
      }
      box.style.left = (r.left + scroller.scrollLeft) + 'px'
      box.style.top = r.top + 'px'
      box.style.width = r.width + 'px'
      box.style.height = r.height + 'px'
      n++
    }
    while (layer.children.length > n) layer.lastChild.remove()
  }

  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y)
      return r ? { node: r.startContainer, offset: r.startOffset } : null
    }
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y)
      return p ? { node: p.offsetNode, offset: p.offset } : null
    }
    return null
  }

  function makeRange(a, b) {
    if (!a || !b || !a.node || !b.node) return null
    var first = a
    var second = b
    if (a.node !== b.node) {
      var pos = a.node.compareDocumentPosition(b.node)
      if (pos & Node.DOCUMENT_POSITION_PRECEDING || pos & Node.DOCUMENT_POSITION_CONTAINED_BY) {
        first = b
        second = a
      }
    } else if (a.offset > b.offset) {
      first = b
      second = a
    }
    var range = document.createRange()
    try {
      range.setStart(first.node, first.offset)
      range.setEnd(second.node, second.offset)
    } catch (err) {
      return null
    }
    return range
  }

  var PHRASE_MAX = 12
  var STOP_RE = /[\\s、。，．,.;:!?！？…—―～「」『』（）()【】《》〈〉"'“”‘’\\n\\r]/
  // 长按 → 选中光标所在的“词”：Intl.Segmenter 按 Unicode 词边界分词（中英文均支持），
  // 光标落在标点/空白上时向两侧找最近的一个词；旧浏览器无 Segmenter 时回退为标点分隔的短语
  var SEGMENTER = null
  try { SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' }) } catch (err) {}
  function wordFromCaret(caret) {
    if (!caret || !caret.node) return null
    var node = caret.node
    var offset = caret.offset
    if (node.nodeType !== Node.TEXT_NODE) {
      node = node.firstChild
      while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild
      offset = 0
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null
    var data = node.data || ''
    if (!data.trim()) return null
    offset = Math.min(Math.max(0, offset), data.length)

    if (SEGMENTER) {
      var part = null
      var pick = function (i) {
        if (i < 0 || i >= data.length) return null
        var p = SEGMENTER.segment(data).containing(i)
        return p && p.isWordLike ? p : null
      }
      part = pick(offset) || pick(offset - 1) || pick(offset + 1)
      if (part) {
        var range = document.createRange()
        try {
          range.setStart(node, part.index)
          range.setEnd(node, part.index + part.segment.length)
        } catch (err) {
          return null
        }
        return range
      }
    }

    // 无分词器回退：标点/空白间的连续段（短语级）
    var left = offset
    var right = offset
    var n = 0
    while (left > 0 && n < PHRASE_MAX) {
      if (STOP_RE.test(data[left - 1])) break
      left--
      n++
    }
    n = 0
    while (right < data.length && n < PHRASE_MAX) {
      if (STOP_RE.test(data[right])) break
      right++
      n++
    }
    if (left === right) return null
    var range2 = document.createRange()
    try {
      range2.setStart(node, left)
      range2.setEnd(node, right)
    } catch (err) {
      return null
    }
    return range2
  }

  function applyRange(range) {
    if (!range || range.collapsed) return
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    updateHighlight(range)
  }

  function report(range) {
    if (!range || range.collapsed) return
    var text = range.toString().replace(/\\s+/g, ' ').trim()
    if (!text) return
    var rect = range.getBoundingClientRect()
    if (!rect || (!rect.width && !rect.height)) return
    window.parent.postMessage({ type: 'mobi-selection', text: text, x: rect.left, y: rect.bottom }, '*')
  }

  var start = null
  var lastRange = null
  var lastPoint = null
  var moved = false
  var startTime = 0
  // iOS 优化：touchmove 只记录坐标，统一在 rAF 里更新自绘高亮（轻量合帧）；
  // 拖动中不碰原生 selection（iOS 上高频操作开销大、会触发 selectionchange 风暴），
  // 松手时再一次性套用原生选区
  var pendingPoint = null
  var rafId = 0

  function onTouchStart(e) {
    e.preventDefault()
    var t = e.touches && e.touches[0]
    if (!t) return
    start = caretFromPoint(t.clientX, t.clientY)
    lastPoint = { x: t.clientX, y: t.clientY }
    startTime = Date.now()
    moved = false
    lastRange = null
    pendingPoint = null
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    clearHighlight()
  }

  // rAF 合帧：一帧最多更新一次高亮，重活不塞进高频 touchmove
  function step() {
    rafId = 0
    if (!start || !pendingPoint) return
    var cur = caretFromPoint(pendingPoint.x, pendingPoint.y)
    pendingPoint = null
    var range = makeRange(start, cur)
    if (!range) return
    lastRange = range
    updateHighlight(range)
  }

  function onTouchMove(e) {
    e.preventDefault()
    if (!start) return
    var t = e.touches && e.touches[0]
    if (!t || !lastPoint) return
    if (Math.abs(t.clientX - lastPoint.x) + Math.abs(t.clientY - lastPoint.y) > 6) moved = true
    lastPoint = { x: t.clientX, y: t.clientY }
    if (!moved) return
    pendingPoint = { x: t.clientX, y: t.clientY }
    if (!rafId) rafId = requestAnimationFrame(step)
  }
  function onTouchEnd() {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    pendingPoint = null
    if (moved && lastRange && !lastRange.collapsed) {
      applyRange(lastRange)
      report(lastRange)
    } else if (!moved && start && Date.now() - startTime >= 450) {
      var range = wordFromCaret(start)
      if (range && !range.collapsed) {
        applyRange(range)
        report(range)
      }
    }
    start = null
    lastRange = null
    lastPoint = null
  }

  document.addEventListener('touchstart', onTouchStart, { passive: false })
  document.addEventListener('touchmove', onTouchMove, { passive: false })
  document.addEventListener('touchend', onTouchEnd, { passive: true })
  document.addEventListener('touchcancel', onTouchEnd, { passive: true })
  scroller.addEventListener('scroll', clearHighlight, { passive: true })
})()
</script>`

export default function MobiRenderer({ ref, book, progress, fontSize, selectMode, theme, onProgress, onSelection }) {
  const [mobi, setMobi] = useState(null)
  const [spine, setSpine] = useState([])
  const [error, setError] = useState(null)
  const containerRef = useRef(null)
  const frameRef = useRef(null)
  const observerRef = useRef(null)

  const [colWidth, setColWidth] = useState(0)
  const [padX, setPadX] = useState(28) // 左右留白（跟随 CSS --page-zone），用于 iframe 内列 padding
  const [pageInfo, setPageInfo] = useState({ pageIndex: 0, totalPages: 0 })

  const pageIndexRef = useRef(progress?.pageIndex ?? 0)
  const didRestoreRef = useRef(false)
  const needsRestoreRef = useRef(true)
  const initialPageRef = useRef(progress?.pageIndex ?? null)
  const initialRatioRef = useRef(progress?.pageIndex == null ? (progress?.percentage ?? 0) : null)

  // 1. 初始化解析器
  useEffect(() => {
    let alive = true
    let m = null
    ;(async () => {
      try {
        m = await initMobiFixed(new File([book.blob], book.title))
        if (!alive) {
          m.destroy()
          return
        }
        setMobi(m)
        setSpine(m.getSpine())
      } catch (e) {
        if (alive) setError(e.message)
      }
    })()
    return () => {
      alive = false
      observerRef.current?.disconnect()
      m?.destroy() // 释放 blob URL
    }
  }, [book.id, book.blob, book.title])

  // 2. 合并所有 spine 章节为一份连续文档
  const combined = useMemo(() => {
    if (!mobi || !spine.length) return null
    const cssHrefs = []
    const parts = []
    for (const ch of spine) {
      let c
      try {
        c = mobi.loadChapter(ch.id)
      } catch {
        continue
      }
      if (!c) continue
      for (const css of c.css || []) {
        if (css?.href && !cssHrefs.includes(css.href)) cssHrefs.push(css.href)
      }
      parts.push(extractBody(c.html))
    }
    if (!parts.length) return null
    return { html: parts.join('\n'), css: cssHrefs }
  }, [mobi, spine])

  // 解析完成但没有可用内容时直接报错
  useEffect(() => {
    if (mobi && spine.length && !combined) setError('未解析到可显示的章节内容')
  }, [mobi, spine, combined])

  // 3. 容器宽度 -> 列宽（一屏一列）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      // 左右留白跟随 CSS（--page-zone），读取实际 padding 保证列宽与热区对齐
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 28
      setPadX(pad)
      setColWidth(Math.max(100, Math.floor(el.clientWidth - pad * 2)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 4. 组装 srcdoc
  const srcDoc = useMemo(() => {
    if (!combined || !colWidth) return null
    const dark = theme === 'dark'
    const paperBg = dark ? '#241d16' : '#f7eeda'
    const paperFg = dark ? '#eadbc0' : '#4a3826'
    const cssLinks = combined.css.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${cssLinks}
<style>
  html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden}
  body{background:${paperBg}}
  .mobi-scroll{position:absolute;inset:0;overflow-x:auto;overflow-y:hidden;
    direction:ltr;writing-mode:horizontal-tb;scrollbar-width:none}
  .mobi-scroll::-webkit-scrollbar{display:none}
  .mobi-cols{height:100%;box-sizing:border-box;padding:36px ${padX}px;
    column-width:${colWidth}px;column-gap:${GAP}px;column-fill:auto;
    direction:ltr;writing-mode:horizontal-tb;
    font-family:${READING_FONT};font-size:${fontSize}px;line-height:1.9;
    color:${paperFg};word-break:break-word}
  .mobi-cols img{max-width:100%;height:auto}
  .sel-layer{position:absolute;inset:0;pointer-events:none;z-index:3}
  .sel-box{position:absolute;background:rgba(154,107,63,.25);border-radius:2px}
</style></head><body><div class="mobi-scroll"><div class="mobi-cols">${combined.html}</div></div>${selectMode ? SELECT_SCRIPT : ''}</body></html>`
  }, [combined, colWidth, padX, fontSize, theme, selectMode])

  // srcDoc 重建（改字号/窗口大小）后，iframe 重新加载时要回到当前页
  useLayoutEffect(() => {
    if (srcDoc) needsRestoreRef.current = true
  }, [srcDoc])

  const report = (pageIndex, totalPages) => {
    const page = clamp(pageIndex, 0, totalPages - 1)
    pageIndexRef.current = page
    setPageInfo({ pageIndex: page, totalPages })
    onProgress({
      pageIndex: page,
      totalPages,
      chapterIndex: 0,
      chapterScrollRatio: totalPages > 1 ? page / (totalPages - 1) : 0,
      percentage: totalPages > 0 ? (page + 1) / totalPages : 0,
    })
  }

  // iframe 内的划词脚本通过 postMessage 上报选区（坐标为 iframe 视口坐标，需加 iframe 偏移）
  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== frameRef.current?.contentWindow) return
      if (e.data?.type !== 'mobi-selection') return
      const frameRect = frameRef.current?.getBoundingClientRect()
      if (!frameRect) return
      onSelection?.({
        text: e.data.text,
        x: e.data.x + frameRect.left,
        y: e.data.y + frameRect.top,
        fromTouch: true,
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onSelection])

  // 5. iframe 加载完成：测量页数、恢复页码、绑定滚动
  const handleFrameLoad = () => {
    const win = frameRef.current?.contentWindow
    const doc = win?.document
    if (!doc || !colWidth) return
    const scroller = doc.querySelector('.mobi-scroll')
    if (!scroller) return
    const step = colWidth + GAP
    let raf = 0
    let snapTimer = 0

    const measure = () => {
      if (frameRef.current?.contentDocument !== doc) return // iframe 已被替换
      const totalPages = Math.max(1, Math.round(scroller.scrollWidth / step))
      let page
      if (needsRestoreRef.current) {
        needsRestoreRef.current = false
        if (!didRestoreRef.current) {
          didRestoreRef.current = true
          page =
            initialPageRef.current != null
              ? initialPageRef.current
              : Math.round((initialRatioRef.current ?? 0) * (totalPages - 1))
        } else {
          page = pageIndexRef.current
        }
      } else {
        page = Math.round(scroller.scrollLeft / step)
      }
      page = clamp(page, 0, totalPages - 1)
      scroller.scrollLeft = page * step
      report(page, totalPages)
    }

    const onScroll = () => {
      doc.querySelector('.sel-layer')?.remove()
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (frameRef.current?.contentDocument !== doc) return
        const totalPages = Math.max(1, Math.round(scroller.scrollWidth / step))
        const page = clamp(Math.round(scroller.scrollLeft / step), 0, totalPages - 1)
        report(page, totalPages)
      })
      // 滚动停止后吸附到最近的完整页（手指滑动翻页后不能停在半页）
      clearTimeout(snapTimer)
      snapTimer = setTimeout(snapToPage, 200)
    }
    const snapToPage = () => {
      if (frameRef.current?.contentDocument !== doc) return
      const target = Math.round(scroller.scrollLeft / step) * step
      if (Math.abs(target - scroller.scrollLeft) > 1) scroller.scrollTo({ left: target, behavior: 'smooth' })
    }

    requestAnimationFrame(measure)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('scrollend', snapToPage)
    doc.fonts?.ready?.then(measure).catch(() => {})
    observerRef.current?.disconnect()
    observerRef.current = new ResizeObserver(measure)
    observerRef.current.observe(scroller)
  }

  // 6. 对外翻页 API：横向滚动一列
  useImperativeHandle(
    ref,
    () => {
      const move = (delta) => {
        const doc = frameRef.current?.contentDocument
        if (!doc || !colWidth) return
        const scroller = doc.querySelector('.mobi-scroll')
        if (!scroller) return
        const step = colWidth + GAP
        const totalPages = pageInfo.totalPages || 1
        const target = clamp(pageIndexRef.current + delta, 0, totalPages - 1)
        scroller.scrollTo({ left: target * step, behavior: 'smooth' })
      }
      return {
        next: () => move(1),
        prev: () => move(-1),
        goToPercent: (p) => {
          const doc = frameRef.current?.contentDocument
          const scroller = doc?.querySelector('.mobi-scroll')
          if (!scroller) return
          const step = colWidth + GAP
          const totalPages = Math.max(1, Math.round(scroller.scrollWidth / step))
          // 先算目标页再对齐到列宽步长，保证落在完整页
          const target = clamp(Math.round(p * (totalPages - 1)), 0, totalPages - 1)
          scroller.scrollTo({ left: target * step, behavior: 'auto' })
        },
      }
    },
    [colWidth, pageInfo.totalPages],
  )

  return (
    <div className="renderer-container" ref={containerRef}>
      {error ? (
        <div className="placeholder">
          <span>打开失败：{error}</span>
        </div>
      ) : !srcDoc ? (
        <div className="placeholder">
          <span>{combined ? '加载中…' : '解析中…'}</span>
        </div>
      ) : (
        <iframe
          ref={frameRef}
          className="trans-iframe mobi-frame"
          srcDoc={srcDoc}
          sandbox="allow-same-origin allow-scripts"
          onLoad={handleFrameLoad}
          title={book.title}
        />
      )}
      {pageInfo.totalPages > 0 && (
        <div className="txt-page-hint">
          {pageInfo.pageIndex + 1} / {pageInfo.totalPages}
        </div>
      )}
    </div>
  )
}
