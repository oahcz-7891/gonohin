// 书架：导入书籍、卡片网格、删除

import { useEffect, useRef, useState } from 'react'
import BookCard from './BookCard'
import { importBook, ACCEPT_EXTS } from '../lib/importBook'
import { deleteBook, getCover } from '../lib/db'
import { getProgress } from '../lib/storage'

export default function Shelf({ books, onOpen, onImported, onSettings }) {
  const fileRef = useRef(null)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(null) // { type: 'error'|'info', text }
  const [covers, setCovers] = useState({})
  const coversRef = useRef({})
  const noticeTimer = useRef(null)

  // 每本书的封面 → blob URL（懒加载，卸载时统一 revoke）
  useEffect(() => {
    let alive = true
    books.forEach((b) => {
      getCover(b.id).then((blob) => {
        if (!alive || !blob || coversRef.current[b.id]) return
        const url = URL.createObjectURL(blob)
        coversRef.current[b.id] = url
        setCovers((prev) => ({ ...prev, [b.id]: url }))
      })
    })
    return () => {
      alive = false
    }
  }, [books])

  // 组件卸载时释放全部 objectURL（卸载时刻读 ref 最新值，勿复制到局部变量）
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(coversRef.current).forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  function showNotice(type, text) {
    setNotice({ type, text })
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3500)
  }

  async function handleFiles(e) {
    const files = [...e.target.files]
    e.target.value = '' // 清空，允许重复选择同一文件
    if (!files.length) return
    setImporting(true)
    for (const f of files) {
      const r = await importBook(f)
      if (!r.ok) showNotice('error', r.reason)
    }
    setImporting(false)
    onImported()
  }

  async function handleDelete(book) {
    if (!confirm(`删除「${book.title}」？本地数据无法恢复。`)) return
    const url = coversRef.current[book.id]
    if (url) URL.revokeObjectURL(url)
    delete coversRef.current[book.id]
    setCovers((prev) => {
      const next = { ...prev }
      delete next[book.id]
      return next
    })
    await deleteBook(book.id)
    showNotice('info', '已删除')
    onImported()
  }

  return (
    <div className="shelf">
      <header className="topbar">
        <h1 className="topbar-title">Gonohin</h1>
        <div className="topbar-actions">
          {importing && <span className="topbar-hint">导入中…</span>}
          <button className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>
            导入书籍
          </button>
          <button className="btn btn-ghost" onClick={onSettings}>
            设置
          </button>
        </div>
        <input ref={fileRef} type="file" accept={ACCEPT_EXTS} multiple hidden onChange={handleFiles} />
      </header>

      {notice && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}

      {books.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            {/* 线性合上的书（lucide book 风格）：浅灰圆底 + 细线，见空态参考样式 */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          </div>
          <p>书架上还没有书</p>
          <p className="empty-hint">支持 EPUB / PDF / MOBI / AZW3 / TXT 格式</p>
          <button className="btn btn-primary" disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? '导入中…' : '导入第一本书'}
          </button>
        </div>
      ) : (
        <div className="shelf-grid">
          {books.map((b) => (
            <BookCard
              key={b.id}
              book={b}
              coverUrl={covers[b.id]}
              progress={getProgress(b.id)}
              onOpen={() => onOpen(b)}
              onDelete={() => handleDelete(b)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
