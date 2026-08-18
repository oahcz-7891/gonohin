// 书籍导入管线：格式识别（扩展名+魔数双保险）→ 元数据提取 → 入库

import ePub from 'epubjs'
import { initMobiFixed } from './mobi'
import './pdf.js' // 副作用：确保 pdfjs worker 已配置
import { extractPdfMeta, renderPdfCover } from './pdf'
import { FORMATS, FORMAT_BY_EXT, MAGIC, ACCEPT_EXTS } from './constants'
import { putBook, putCover, getAllBooks } from './db'

/** 读文件头部字节，按偏移识别格式 */
export async function detectFormat(file) {
  // 前 4KB 覆盖 PalmDB 头 + 偏移表的可变长度（BOOKMOBI 在 record0 的偏移 16 处，不固定）
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const ascii = (start, len) => String.fromCharCode(...head.slice(start, start + len))
  const hasSubstr = (s) => String.fromCharCode(...head).includes(s)

  if (ascii(0, 5) === MAGIC.PDF) return FORMATS.PDF
  if (head[0] === MAGIC.ZIP[0] && head[1] === MAGIC.ZIP[1] && head[2] === MAGIC.ZIP[2] && head[3] === MAGIC.ZIP[3]) {
    return FORMATS.EPUB
  }
  if (hasSubstr(MAGIC.MOBI)) return FORMATS.MOBI

  // 无魔数则按扩展名兜底；纯文本没有文件头特征
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (FORMAT_BY_EXT[ext]) return FORMAT_BY_EXT[ext]
  return FORMATS.TXT // 其余默认按纯文本处理
}

/** 按格式提取元数据 + 封面 Blob */
async function extractMeta(format, file, blob) {
  const fallbackName = file.name.replace(/\.(epub|pdf|mobi|azw3|txt)$/i, '')

  switch (format) {
    case FORMATS.EPUB: {
      const book = ePub(await blob.arrayBuffer())
      const m = book.metadata
      let coverBlob = null
      try {
        const coverUrl = await book.cover
        if (coverUrl) coverBlob = await (await fetch(coverUrl)).blob()
      } catch { /* 无封面忽略 */ }
      book.destroy()
      return { title: m.title || fallbackName, author: (m.creator || '').trim(), coverBlob }
    }
    case FORMATS.PDF: {
      const data = await blob.arrayBuffer()
      const [meta, coverBlob] = await Promise.all([
        extractPdfMeta(data, fallbackName),
        renderPdfCover(data),
      ])
      return { title: meta.title || fallbackName, author: meta.author, coverBlob }
    }
    case FORMATS.MOBI: {
      const mobi = await initMobiFixed(new File([blob], file.name))
      const m = await mobi.getMetadata()
      let coverBlob = null
      try {
        const coverUrl = await mobi.getCoverImage()
        if (coverUrl) coverBlob = await (await fetch(coverUrl)).blob()
      } catch { /* 无封面忽略 */ }
      mobi.destroy()
      return { title: m.title || fallbackName, author: (m.author || []).join(', '), coverBlob }
    }
    case FORMATS.TXT:
    default:
      return { title: fallbackName, author: '', coverBlob: null }
  }
}

/**
 * 导入一本书到 IndexedDB。
 * 返回 { ok: true, reason: null } 或 { ok: false, reason: '错误信息' }
 */
export async function importBook(file) {
  const format = await detectFormat(file)
  const blob = file

  try {
    const { title, author, coverBlob } = await extractMeta(format, file, blob)

    // 去重：同书名+格式+大小视为同一本书
    const existing = await getAllBooks()
    if (existing.some((b) => b.title === title && b.format === format && b.size === blob.size)) {
      return { ok: false, reason: `「${title}」已在书架上` }
    }

    const id = `${format}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await putBook({ id, title, author, format, size: blob.size, addedAt: Date.now(), blob })
    if (coverBlob) await putCover(id, coverBlob)

    return { ok: true, reason: null }
  } catch (err) {
    console.error('导入失败:', err)
    if (err?.stack) console.error(err.stack) // 完整堆栈进 console，页面只显示摘要
    return { ok: false, reason: `解析失败：${err?.message || '文件格式不支持'}` }
  }
}

export { ACCEPT_EXTS }
