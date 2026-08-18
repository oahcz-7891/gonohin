// 划词统一上报：监听 document（PDF/TXT）与 iframe（MOBI）的 mouseup / touchend / selectionchange，
// 产出 { text, x, y, fromTouch }（主视图 viewport 坐标）交给翻译弹窗。
// iOS 长按后选区可能到 touchend 之后才真正提交，且 selectionchange 并不可靠，
// 所以在 touch 期间额外轮询一小段窗口，读到选区即上报（保留系统菜单，只补 AI 翻译入口）。
// EPUB 不用本 hook——epubjs 提供内置 selected 事件（坐标换算在渲染器内做）。

import { useEffect, useRef } from 'react'

export function useSelection(onSelect) {
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    // 在某 document 上监听划词；offsetX/Y 是该文档相对主视图的偏移
    const attach = (doc, offsetX, offsetY) => {
      let timer = 0
      let pollTimer = 0

      const stopPoll = () => {
        clearInterval(pollTimer)
        pollTimer = 0
      }

      const read = (fromTouch = false) => {
        const sel = doc.getSelection()
        const text = sel?.toString().trim()
        if (!text || sel.rangeCount === 0) return false
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        if (!rect || (rect.width === 0 && rect.height === 0)) return false
        onSelectRef.current({ text, x: rect.left + offsetX, y: rect.bottom + offsetY, fromTouch })
        return true
      }

      // iOS 长按：选区可能在 touchend 之后才提交，轮询一小段窗口兜底
      const startPoll = (duration) => {
        stopPoll()
        const startAt = Date.now()
        pollTimer = setInterval(() => {
          if (read(true) || Date.now() - startAt > duration) stopPoll()
        }, 150)
      }

      const handler = (e) => {
        if (e.type === 'touchend') {
          requestAnimationFrame(() => read(true))
          startPoll(2000)
        } else {
          read(false)
        }
      }
      const onSelectionChange = () => {
        // 触屏的原生选择手柄、双击选词等只触发 selectionchange，
        // 用防抖等选区稳定后再上报
        clearTimeout(timer)
        timer = setTimeout(() => read(false), 250)
      }
      const onTouchStart = () => startPoll(2500)

      doc.addEventListener('mouseup', handler)
      doc.addEventListener('touchend', handler, { passive: true })
      doc.addEventListener('touchstart', onTouchStart, { passive: true })
      doc.addEventListener('selectionchange', onSelectionChange)
      return () => {
        clearTimeout(timer)
        stopPoll()
        doc.removeEventListener('mouseup', handler)
        doc.removeEventListener('touchend', handler)
        doc.removeEventListener('touchstart', onTouchStart)
        doc.removeEventListener('selectionchange', onSelectionChange)
      }
    }

    const detachMain = attach(document, 0, 0)
    const detachFrames = []
    const boundDocs = new WeakSet()

    // 轮询已挂载的 .trans-iframe（MOBI 渲染器标记的），自动绑定其内容文档。
    // 注意：iframe 翻章后内容重新加载，contentDocument 是新对象——按文档标记而非元素标记，
    // 否则新文档不会补绑（划词失效）。
    const pollFrames = setInterval(() => {
      document.querySelectorAll('iframe.trans-iframe').forEach((iframe) => {
        const doc = iframe.contentDocument
        if (!doc || boundDocs.has(doc)) return
        boundDocs.add(doc)
        const rect = iframe.getBoundingClientRect()
        detachFrames.push(attach(doc, rect.left, rect.top))
      })
    }, 800)

    return () => {
      detachMain()
      detachFrames.forEach((d) => d())
      clearInterval(pollFrames)
    }
  }, [])
}
