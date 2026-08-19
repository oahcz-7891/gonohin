// EPUB 渲染器：epubjs 直接集成（无包装层）
// - 进度：CFI 字符串存 localStorage，display(cfi) 恢复
// - 划词：epubjs 内置 selected 事件（内容在 iframe 内），坐标加 iframe 偏移换算

import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import ePub from 'epubjs'
import { getSettings } from '../../lib/storage'
import { resolveTheme } from '../../lib/theme'

// EPUB 内容页在 iframe 里，用其 document 取上下文（注意 selectNode 用 contentWindow 的 Range）
function extractEpubContext(range, doc) {
  try {
    let node = range.startContainer
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement
    const blockRE = /^(P|DIV|LI|TD|BLOCKQUOTE|H[1-6]|SECTION|ARTICLE|DD|DT|TH|FIGCAPTION)$/
    let block = node
    while (block && block !== doc.body) {
      if (blockRE.test(block.tagName)) break
      block = block.parentElement
    }
    const text = (block?.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length <= 400) return text
    const selText = range.toString().replace(/\s+/g, ' ').trim()
    const idx = text.indexOf(selText)
    const center = idx >= 0 ? idx : Math.floor(text.length / 2)
    return text.slice(Math.max(0, center - 200), Math.min(text.length, center + 200))
  } catch {
    return ''
  }
}

export default function EpubRenderer({ ref, book, progress, fontSize, onProgress, onSelection }) {
  const containerRef = useRef(null)
  const renditionRef = useRef(null)
  const bookRef = useRef(null) // book 实例，用于 locations 百分比换算
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    const container = containerRef.current
    let rendition = null
    let bookObj = null

    ;(async () => {
      try {
        bookObj = ePub(await book.blob.arrayBuffer())
        bookRef.current = bookObj
        rendition = bookObj.renderTo(container, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none', // 单页视图，移动端友好
        })
        renditionRef.current = rendition
        const isDark = resolveTheme(getSettings().theme) === 'dark'
        rendition.themes.default({
          body: {
            background: isDark ? '#241d16' : '#f7eeda',
            color: isDark ? '#eadbc0' : '#4a3826',
          },
        })

        // 恢复进度（CFI），无进度则从开头
        if (progress?.cfi) {
          await rendition.display(progress.cfi)
        } else {
          await rendition.display()
        }
        rendition.themes.fontSize(`${fontSize}px`)

        // 进度上报
        rendition.on('relocated', (location) => {
          const start = location.start
          onProgress({
            cfi: start.cfi,
            pageIndex: start.displayed?.page ?? 0,
            totalPages: start.displayed?.total ?? 0,
            percentage: start.percentage ?? 0,
          })
        })

        // 划词翻译：epubjs 检测到 iframe 内选区时触发
        rendition.on('selected', (cfiRange, contents) => {
          const doc = contents.document
          const sel = contents.window.getSelection()
          const text = sel.toString().trim()
          if (!text || !sel.rangeCount) return
          const range = sel.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          const iframeRect = rendition.getContents()[0].iframe.getBoundingClientRect()
          onSelection({
            text,
            context: extractEpubContext(range, doc),
            x: rect.left + iframeRect.left,
            y: rect.bottom + iframeRect.top,
          })
        })

        // 后台生成全书定位索引（relocated 里的 percentage 依赖它，越精确越慢，500 为折中）
        bookObj.locations.generate(500)
      } catch (e) {
        if (alive) setError(e.message)
      }
    })()

    return () => {
      alive = false
      renditionRef.current = null
      bookRef.current = null
      try {
        rendition?.destroy()
      } catch {
        /* epubjs 重复 destroy 会抛错，忽略 */
      }
      try {
        bookObj?.destroy()
      } catch {
        /* 同上 */
      }
    }
  }, [book.id, book.blob]) // eslint-disable-line react-hooks/exhaustive-deps

  // 字号变化即时应用
  useEffect(() => {
    renditionRef.current?.themes?.fontSize(`${fontSize}px`)
  }, [fontSize])

  useImperativeHandle(
    ref,
    () => ({
      next: () => renditionRef.current?.next(),
      prev: () => renditionRef.current?.prev(),
      goToPercent: (p) => {
        const book = bookRef.current
        const rendition = renditionRef.current
        if (!book || !rendition) return
        // locations 由后台 generate() 填充，未就绪时 cfiFromPercentage 返回 undefined，忽略本次跳转
        const cfi = book.locations?.cfiFromPercentage?.(p)
        if (cfi) rendition.display(cfi)
      },
    }),
    [],
  )

  if (error) {
    return (
      <div className="placeholder">
        <span>打开失败：{error}</span>
      </div>
    )
  }

  return <div className="renderer-container" ref={containerRef} />
}
