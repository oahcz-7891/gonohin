// 书架卡片：封面 / 标题 / 进度 / 删除

import { hashHue } from '../utils/cover'

// 竖排书名的字数上限：超过就降一档字号（.cv-vt-dense）。
// 竖排没有省略号可加，只能靠降档把字尽量留在封面上。
const DENSE_TITLE_LEN = 9

export default function BookCard({ book, coverUrl, progress, onOpen, onDelete }) {
  const pct = Math.round((progress?.percentage ?? 0) * 100)
  const dense = book.title.length > DENSE_TITLE_LEN

  return (
    <div className="book-card" onClick={onOpen} title={book.title}>
      <div className="cv">
        {coverUrl ? (
          <img className="cv-photo" src={coverUrl} alt="" loading="lazy" />
        ) : (
          <>
            {/* 色只落在左边 10px 粗条上；色相按书名哈希，亮度由主题变量定 */}
            <span className="cv-spine" style={{ '--cover-h': hashHue(book.title) }} />
            <span className={dense ? 'cv-vt cv-vt-dense' : 'cv-vt'}>{book.title}</span>
          </>
        )}
        <span className="fmt">{book.format}</span>
        <button
          className="kill"
          title="删除"
          aria-label={`删除 ${book.title}`}
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
