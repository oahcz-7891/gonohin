// 顶层视图切换：书架 / 阅读器 / 设置（state 切换，不引路由）

import { useCallback, useEffect, useState } from 'react'
import Shelf from './components/Shelf'
import Reader from './components/Reader'
import Settings from './components/Settings'
import { getAllBooks } from './lib/db'

export default function App() {
  const [view, setView] = useState('shelf')
  const [books, setBooks] = useState([])
  const [activeBook, setActiveBook] = useState(null)

  const refreshBooks = useCallback(async () => {
    setBooks(await getAllBooks())
  }, [])

  useEffect(() => {
    refreshBooks()
  }, [refreshBooks])

  const openBook = (book) => {
    setActiveBook(book)
    setView('reader')
  }

  const closeReader = () => {
    setActiveBook(null)
    setView('shelf')
    refreshBooks() // 回到书架时刷新（含新进度）
  }

  return (
    <div className="app">
      {view === 'shelf' && (
        <Shelf books={books} onOpen={openBook} onImported={refreshBooks} onSettings={() => setView('settings')} />
      )}
      {view === 'reader' && activeBook && <Reader book={activeBook} onBack={closeReader} />}
      {view === 'settings' && <Settings onBack={() => setView('shelf')} />}
    </div>
  )
}
