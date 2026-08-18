// pdfjs-dist 集成：worker 配置 + 工具函数（导入元数据 / 渲染器共用）
// 注意：必须在首次 getDocument 前设置 workerSrc，否则会回退到 fake worker（主线程阻塞）

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css' // textLayer 定位所需样式

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjsLib }

/** 从 ArrayBuffer/Uint8Array 加载 PDF 文档 */
export function loadPdf(data) {
  return pdfjsLib.getDocument({ data }).promise
}

/** 取 PDF 元数据，title 为空时用文件名兜底 */
export async function extractPdfMeta(data, fallbackName) {
  const pdf = await loadPdf(data)
  try {
    const meta = await pdf.getMetadata()
    const info = meta?.info || {}
    return {
      title: (info.Title || fallbackName).trim(),
      author: (info.Author || '').trim(),
    }
  } finally {
    pdf.destroy()
  }
}

/** 渲染第一页生成封面缩略图 Blob，失败返回 null */
export async function renderPdfCover(data, targetWidth = 240) {
  try {
    const pdf = await loadPdf(data)
    try {
      const page = await pdf.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const scale = targetWidth / base.width
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    } finally {
      pdf.destroy()
    }
  } catch {
    return null // 封面失败不影响导入
  }
}
