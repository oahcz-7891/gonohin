// pdfjs-dist 集成：worker 配置 + 工具函数（导入元数据 / 渲染器共用）
// 注意：必须在首次 getDocument 前设置 workerSrc，否则会回退到 fake worker（主线程阻塞）

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css' // textLayer 定位所需样式

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }

/**
 * 打开一个 PDF，返回 { pdf, destroy }。
 *
 * pdfjs v6 的 PDFDocumentProxy 上**已经没有 destroy()**（只有 cleanup()，
 * 而 cleanup() 只回收页面资源、不释放 worker）。真正销毁必须走 loadingTask.destroy()，
 * 所以这里把 task 一起包出来 —— 调用方务必调返回的 destroy，否则每次打开都会漏一个 worker。
 */
export async function openPdf(data) {
  const task = pdfjsLib.getDocument({ data })
  const pdf = await task.promise
  return {
    pdf,
    destroy() {
      try {
        pdf.cleanup()
      } catch {
        /* 已销毁等情形忽略 */
      }
      return task.destroy()
    },
  }
}

/** 取 PDF 元数据，title 为空时用文件名兜底 */
export async function extractPdfMeta(data, fallbackName) {
  const { pdf, destroy } = await openPdf(data)
  try {
    const meta = await pdf.getMetadata()
    const info = meta?.info || {}
    return {
      title: (info.Title || fallbackName).trim(),
      author: (info.Author || '').trim(),
    }
  } finally {
    destroy()
  }
}

/** 渲染第一页生成封面缩略图 Blob，失败返回 null */
export async function renderPdfCover(data, targetWidth = 240) {
  let handle = null
  try {
    handle = await openPdf(data)
    const page = await handle.pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = targetWidth / base.width
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    page.cleanup()
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  } catch {
    return null // 封面失败不影响导入
  } finally {
    handle?.destroy()
  }
}
