// 书架：导入书籍、卡片网格、删除

import { useEffect, useMemo, useRef, useState } from 'react'
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

  // 最近在读的一本（按进度里的 updatedAt 比）。
  // updatedAt 由 saveProgress 自动写入，所以不需要额外的存储结构。
  // 注意：只有真正翻过页的书才有进度，打开后一页没翻的书不会出现在这里。
  const recent = useMemo(() => {
    let best = null
    for (const b of books) {
      const p = getProgress(b.id)
      if (p?.updatedAt && (!best || p.updatedAt > best.progress.updatedAt)) best = { book: b, progress: p }
    }
    return best
  }, [books])

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
          <button className="icon-btn" title="导入书籍" aria-label="导入书籍" disabled={importing} onClick={() => fileRef.current?.click()}>
            ＋
          </button>
          <button className="icon-btn" title="设置" aria-label="设置" onClick={onSettings}>
            {/* 线性齿轮（lucide settings）：⚙ 在 iOS 上会渲染成立体彩色齿轮，和桌面端完全不同 */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
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
        <>
          {recent && (
            <button
              className="continue-card"
              onClick={() => onOpen(recent.book)}
              title={recent.book.title}
            >
              {/* 帯：整块实色 + 反白字。不再用封面模糊铺底——
                  实块本身已是最重的视觉，再叠一张模糊图会让底色脏掉 */}
              <span className="continue-card-body">
                <b>{recent.book.title}</b>
                <span>读到 {Math.round((recent.progress.percentage ?? 0) * 100)}%</span>
              </span>
              <span className="continue-card-go">继续</span>
            </button>
          )}
          {/* 册数用现有数据（books.length），不造假的统计 */}
          <div className="ghead">
            全部藏书 <span>{books.length} 册</span>
          </div>
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
        </>
      )}
    </div>
  )
}
