// PDF 渲染器：pdfjs canvas + textLayer 叠层（单页渲染）
// - worker 配置在 lib/pdf.js 顶层完成（?url 导入，静态托管可用）
// - 划词：textLayer 在主文档 DOM 中，走 useSelection 的 document 通道

import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { pdfjsLib, loadPdf } from '../../lib/pdf'

const PAGE_MARGIN = 32 // 页面左右留白

export default function PdfRenderer({ ref, book, progress, onProgress }) {
  const [pdf, setPdf] = useState(null)
  const [pageNum, setPageNum] = useState(progress?.pageNum ?? 1)
  const [error, setError] = useState(null)
  const wrapRef = useRef(null)
  const pdfRef = useRef(null)

  // 1. 加载 PDF 文档
  useEffect(() => {
    let alive = true
    book.blob
      .arrayBuffer()
      .then((data) => loadPdf(data))
      .then((p) => {
        if (!alive) {
          p.destroy()
          return
        }
        pdfRef.current = p
        setPdf(p)
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
      pdfRef.current?.destroy()
      pdfRef.current = null
    }
  }, [book.id, book.blob])

  // 2. 渲染当前页（canvas + textLayer 叠层）
  useEffect(() => {
    const doc = pdfRef.current
    const wrap = wrapRef.current
    if (!doc || !wrap) return
    let cancelled = false

    const render = async () => {
      const availWidth = Math.max(200, wrap.clientWidth - PAGE_MARGIN * 2)
      const page = await doc.getPage(pageNum)
      const base = page.getViewport({ scale: 1 })
      const scale = availWidth / base.width
      const viewport = page.getViewport({ scale })

      wrap.innerHTML = '' // 清掉上一页的 canvas/textLayer

      // 页容器：textLayer 绝对定位叠在 canvas 上，整体在 flex 容器中居中
      const pageDiv = document.createElement('div')
      pageDiv.style.position = 'relative'
      pageDiv.style.width = `${viewport.width}px`
      pageDiv.style.height = `${viewport.height}px`
      pageDiv.style.boxShadow = '0 2px 12px rgba(0, 0, 0, 0.4)'

      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.display = 'block'
      canvas.className = 'pdf-canvas'

      const textDiv = document.createElement('div')
      textDiv.className = 'textLayer'
      textDiv.style.width = '100%'
      textDiv.style.height = '100%'

      pageDiv.appendChild(textDiv)
      pageDiv.appendChild(canvas)
      wrap.appendChild(pageDiv)

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise

      const textContent = await page.getTextContent()
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textDiv,
        viewport,
      })
      await textLayer.render()
      page.cleanup()

      if (cancelled) return
      onProgress({ pageNum, totalPages: doc.numPages, percentage: pageNum / doc.numPages })
    }

    render().catch((e) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [pdf, pageNum, onProgress])

  // 3. 翻页 API
  useImperativeHandle(
    ref,
    () => ({
      next: () => setPageNum((p) => (pdfRef.current ? Math.min(pdfRef.current.numPages, p + 1) : p)),
      prev: () => setPageNum((p) => Math.max(1, p - 1)),
      goToPercent: (p) => {
        const total = pdfRef.current?.numPages
        if (!total) return
        setPageNum(Math.max(1, Math.min(total, Math.round(p * total))))
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
  if (!pdf) {
    return (
      <div className="placeholder">
        <span>加载中…</span>
      </div>
    )
  }

  return (
    <div className="renderer-container pdf-view">
      <div className="pdf-wrap" ref={wrapRef}>
        <div className="pdf-hint">正在渲染第 {pageNum} 页…</div>
      </div>
      <div className="txt-page-hint">
        {pageNum} / {pdf.numPages} 页
      </div>
    </div>
  )
}
