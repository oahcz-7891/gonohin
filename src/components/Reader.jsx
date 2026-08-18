// 阅读器壳：按格式分发渲染器，统一状态栏 / 字号控制 / 键盘翻页 / 进度保存

import { useCallback, useEffect, useRef, useState } from 'react'
import TxtRenderer from './renderers/TxtRenderer'
import EpubRenderer from './renderers/EpubRenderer'
import MobiRenderer from './renderers/MobiRenderer'
import PdfRenderer from './renderers/PdfRenderer'
import TranslationPopup from './TranslationPopup'
import { FORMATS } from '../lib/constants'
import { getProgress, getSettings } from '../lib/storage'
import { useAutoSave } from '../hooks/useAutoSave'
import { useSelection } from '../hooks/useSelection'
import { resolveTheme } from '../lib/theme'

const MIN_FONT = 14
const MAX_FONT = 32
// 触屏（手机/平板）：屏蔽系统菜单，选中后自绘“复制 / 翻译”操作条；
// 鼠标设备保持原行为，选中后直接弹翻译窗。
const IS_TOUCH =
  typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || matchMedia('(hover: none)').matches)

export default function Reader({ book, onBack }) {
  const [initialProgress] = useState(() => getProgress(book.id))
  const [fontSize, setFontSize] = useState(initialProgress?.fontSize ?? 18)
  const [theme] = useState(() => resolveTheme(getSettings().theme))
  // 触屏设备默认开启划词模式（设备模式/手机浏览器下原生长按选择不可用或不便，
  // 划词模式下触摸拖动直接选词，翻页改用左右两侧按钮）；用户手动切换会记住
  const [selectMode, setSelectMode] = useState(() => {
    if (initialProgress?.selectMode != null) return initialProgress.selectMode
    return typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || matchMedia('(hover: none)').matches)
  })
  const locRef = useRef(initialProgress ?? {})
  const [status, setStatus] = useState(null) // { pageIndex, totalPages }
  const [selection, setSelection] = useState(null) // { text, x, y } → 划词翻译弹窗
  const [translateOpen, setTranslateOpen] = useState(false) // 触屏：点“翻译（AI）”后再打开弹窗
  const [copied, setCopied] = useState(false) // 复制成功后的短暂反馈
  const [dragPct, setDragPct] = useState(null) // 进度条拖动中的临时值（0-1000），松开后跳页
  const apiRef = useRef(null)
  const copyTimerRef = useRef(0)

  // 渲染器进度上报：只更新内存 + 状态栏，落盘交给 useAutoSave
  const handleProgress = useCallback(
    (loc) => {
      locRef.current = { ...loc }
      setStatus(loc)
    },
    [],
  )

  useAutoSave(book.id, () =>
    locRef.current.pageIndex != null || locRef.current.cfi ? { ...locRef.current, fontSize, selectMode } : null,
  )

  // 统一划词监听：document（TXT/PDF）+ iframe（MOBI），EPUB 走 epubjs 内置事件
  useSelection((sel) => {
    setSelection(sel)
    if (sel) setTranslateOpen(false) // 新选区出现时回到“复制 / 翻译”操作条
  })

  // 翻页后清掉旧选区和操作条，避免停留在错误位置
  useEffect(() => {
    setSelection(null)
    setTranslateOpen(false)
  }, [status?.pageIndex])

  // 组件卸载时清掉复制反馈定时器
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  const copySelection = async () => {
    const text = selection?.text
    if (!text) return
    let ok = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) {
      // 非 HTTPS（如局域网 http://IP:5173）下 clipboard API 不可用，退回 execCommand
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.style.top = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, text.length)
      ok = document.execCommand('copy')
      ta.remove()
    }
    if (ok) {
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200)
    }
  }

  // 键盘左右键翻页
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') apiRef.current?.next()
      if (e.key === 'ArrowLeft') apiRef.current?.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pct = locRef.current.percentage ? Math.round(locRef.current.percentage * 100) : 0

  return (
    <div className="reader-shell">
      <header className="reader-topbar">
        <button className="btn btn-ghost" onClick={onBack}>
          ← 书架
        </button>
        <span className="reader-title">{book.title}</span>
        <button
          className={`btn ${selectMode ? 'btn-primary' : 'btn-ghost'}`}
          title="划词模式：开启后可直接拖动选择文字"
          onClick={() => setSelectMode((v) => !v)}
        >
          划词
        </button>
        <div className="font-size-controls">
          <button title="减小字号" onClick={() => setFontSize((f) => Math.max(MIN_FONT, f - 2))}>
            A−
          </button>
          <button title="增大字号" onClick={() => setFontSize((f) => Math.min(MAX_FONT, f + 2))}>
            A+
          </button>
        </div>
      </header>

      <div className="reader-body">
        {book.format === FORMATS.TXT && (
          <TxtRenderer ref={apiRef} book={book} progress={initialProgress} fontSize={fontSize} onProgress={handleProgress} onSelection={setSelection} />
        )}
        {book.format === FORMATS.EPUB && (
          <EpubRenderer ref={apiRef} book={book} progress={initialProgress} fontSize={fontSize} onProgress={handleProgress} onSelection={setSelection} />
        )}
        {book.format === FORMATS.MOBI && (
          <MobiRenderer ref={apiRef} book={book} progress={initialProgress} fontSize={fontSize} selectMode={selectMode} theme={theme} onProgress={handleProgress} onSelection={setSelection} />
        )}
        {book.format === FORMATS.PDF && (
          <PdfRenderer ref={apiRef} book={book} progress={initialProgress} onProgress={handleProgress} onSelection={setSelection} />
        )}
        <button
          className={`page-nav page-nav-prev${selectMode ? ' page-nav-select-mode' : ''}`}
          title="上一页"
          onClick={() => apiRef.current?.prev()}
        >
          ‹
        </button>
        <button
          className={`page-nav page-nav-next${selectMode ? ' page-nav-select-mode' : ''}`}
          title="下一页"
          onClick={() => apiRef.current?.next()}
        >
          ›
        </button>
      </div>

      <footer className="reader-statusbar">
        {status ? (
          <span>
            {status.pageIndex != null ? `${status.pageIndex + 1} / ${status.totalPages} 页` : ''}
          </span>
        ) : null}
        {/* 进度条：可拖动跳页。拖动中只更新滑块位置（不跳页防卡顿），松开时跳转 */}
        <input
          type="range"
          className="progress-track"
          min={0}
          max={1000}
          step={1}
          value={dragPct ?? pct * 10}
          aria-label="阅读进度"
          style={{
            background: `linear-gradient(to right, var(--primary) ${(dragPct ?? pct * 10) / 10}%, var(--border) ${(dragPct ?? pct * 10) / 10}%)`,
          }}
          onInput={(e) => setDragPct(Number(e.target.value))}
          onChange={(e) => {
            apiRef.current?.goToPercent?.(Number(e.target.value) / 1000)
            setDragPct(null)
          }}
        />
        <span>{pct}%</span>
      </footer>

      {selection && !IS_TOUCH && <TranslationPopup {...selection} onClose={() => setSelection(null)} />}

      {selection && IS_TOUCH && !translateOpen && (
        <div
          className="sel-actions"
          style={{
            left: Math.max(8, Math.min(selection.x, window.innerWidth - 190)),
            top: Math.max(8, Math.min(selection.y + 10, window.innerHeight - 56)),
          }}
        >
          <button onClick={copySelection}>{copied ? '已复制' : '复制'}</button>
          <button onClick={() => setTranslateOpen(true)}>翻译</button>
          <button
            className="sel-actions-close"
            aria-label="关闭"
            onClick={() => {
              setSelection(null)
              setTranslateOpen(false)
            }}
          >
            ✕
          </button>
        </div>
      )}

      {selection && IS_TOUCH && translateOpen && (
        <TranslationPopup
          {...selection}
          onClose={() => {
            setSelection(null)
            setTranslateOpen(false)
          }}
        />
      )}
    </div>
  )
}
