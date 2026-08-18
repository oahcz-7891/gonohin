// 划词翻译弹窗：流式显示译文，支持重译 / 复制 / 关闭

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { translateStream } from '../lib/translate'

const MAX_SOURCE_LEN = 2000

export default function TranslationPopup({ text, x, y, onClose }) {
  const popupRef = useRef(null)
  const [result, setResult] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pos, setPos] = useState({ left: 8, top: 8 })
  const runIdRef = useRef(0)
  const source = text.length > MAX_SOURCE_LEN ? text.slice(0, MAX_SOURCE_LEN) + '…' : text

  const run = async () => {
    const runId = ++runIdRef.current
    setLoading(true)
    setError(null)
    setResult('')
    try {
      const stream = await translateStream(source)
      for await (const delta of stream) {
        if (runIdRef.current !== runId) return // 已被重译/关闭打断
        setResult((prev) => prev + delta)
      }
      setLoading(false)
    } catch (e) {
      if (runIdRef.current === runId) {
        setError(e.message)
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    run()
    return () => {
      // 卸载时使进行中的流失效（需读最新 ref 值，勿复制到局部变量）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      runIdRef.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result)
    } catch {
      // 剪贴板不可用（如非 https），忽略
    }
  }

  // 定位：渲染后按实际宽高 clamp，保证底部按钮（关闭等）始终可见
  useLayoutEffect(() => {
    const el = popupRef.current
    if (!el) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8))
    const maxTop = Math.max(8, window.innerHeight - height - 8)
    setPos({ left, top: Math.min(y + 12, maxTop) })
  }, [x, y, result, error, loading])

  return (
    <div className="trans-popup" ref={popupRef} style={pos}>
      <div className="trans-source" title="原文">
        {source}
        {source !== text && <span style={{ color: 'var(--fg-muted)' }}>（已截取前 {MAX_SOURCE_LEN} 字）</span>}
      </div>

      {error ? (
        <div className="trans-error">{error}</div>
      ) : (
        <div className="trans-result">
          {result}
          {loading && <span className="trans-loading">▍</span>}
        </div>
      )}

      <div className="trans-actions">
        <div>
          <button className="btn" onClick={run} disabled={loading}>
            重新翻译
          </button>
          <button className="btn" onClick={copy} disabled={!result || loading}>
            复制
          </button>
        </div>
        <button className="btn btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  )
}
