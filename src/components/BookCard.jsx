// 书架卡片：封面 / 标题 / 进度 / 删除

export default function BookCard({ book, coverUrl, progress, onOpen, onDelete }) {
  const pct = Math.round((progress?.percentage ?? 0) * 100)

  return (
    <div className="book-card" onClick={onOpen} title={book.title}>
      <div className="book-cover">
        {coverUrl ? <img src={coverUrl} alt="" loading="lazy" /> : <span className="cover-fallback">{book.format}</span>}
        <button
          className="book-delete"
          title="删除"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          ×
        </button>
      </div>
      <div className="book-title">{book.title}</div>
      <div className="book-meta">
        {book.format}
        {book.author ? ` · ${book.author}` : ''}
      </div>
      {pct > 0 && (
        <div className="book-progress" title={`已读 ${pct}%`}>
          <div className="book-progress-bar" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
