// 划词翻译弹窗：流式显示译文，支持重译 / 复制 / 关闭
// 两种模式：
//   normal —— 普通翻译（单次流式，思考强度走「普通翻译」档）
//   deep   —— 深度翻译（同一条单次流式管线，但思考强度走「深度翻译」档），弹窗内可随时切换

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { translateStream, translateDeep } from '../lib/translate'

const MAX_SOURCE_LEN = 2000

export default function TranslationPopup({ text, context = '', x, y, mode: initialMode = 'normal', onClose, onBackdropPress }) {
  const popupRef = useRef(null)
  // 初始模式来自调用方（触屏操作条的「翻译/深度翻译」区分），弹窗内可自由切换
  const [mode, setMode] = useState(initialMode) // 'normal' | 'deep'
  const [result, setResult] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pos, setPos] = useState({ left: 8, top: 8 })
  const [closing, setClosing] = useState(false) // 关闭退场动画中的标记，结束后再真正卸载
  const [timing, setTiming] = useState(null) // { first: 首 token 耗时ms, total: 总耗时ms }，用于诊断慢在哪
  const runIdRef = useRef(0)
  const abortRef = useRef(null) // 当前运行对应的 AbortController，用于真正打断进行中的请求
  const source = text.length > MAX_SOURCE_LEN ? text.slice(0, MAX_SOURCE_LEN) + '…' : text

  // force：跳过缓存读取（「重新翻译」用），新结果仍会写回缓存
  const run = async (force = false) => {
    const runId = ++runIdRef.current
    abortRef.current?.abort() // 先打断上一次运行（重译 / 切模式），避免旧请求继续烧 token
    const ac = new AbortController()
    abortRef.current = ac
    const t0 = performance.now() // 计时起点：真实 requests 从这里开始，冷启动/排队都算进去
    let firstMs = null
    const stampFirst = () => {
      if (firstMs == null) firstMs = performance.now() - t0
    }
    setLoading(true)
    setError(null)
    setResult('')
    setTiming(null)
    try {
      // 两条管线都是单次流式，仅思考强度档位不同
      const stream =
        mode === 'deep'
          ? translateDeep(source, context, undefined, ac.signal, { fresh: force })
          : translateStream(source, context, undefined, ac.signal, { fresh: force })
      for await (const delta of stream) {
        if (runIdRef.current !== runId) return // 已被重译/切模式/关闭打断
        stampFirst()
        setResult((prev) => prev + delta)
      }
      setLoading(false)
      setTiming({ first: firstMs, total: performance.now() - t0 })
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
      // 进行中的流式请求需真正 abort 才能打断（重译/切模式/关闭时避免旧请求继续烧 token）
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode])

  // 退场动画：先播 animation，结束后（或超时兜底）再调 onClose 卸载
  const closeTimerRef = useRef(0)
  const handleClose = () => {
    if (closing) return
    onBackdropPress?.() // 通知父级短暂忽略旧选区重放（TXT/PDF 下刚关掉又弹回来的情况）
    setClosing(true)
    closeTimerRef.current = setTimeout(onClose, 200)
  }
  useEffect(() => () => clearTimeout(closeTimerRef.current), [])

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
  }, [x, y, result, error, loading, mode])

  return (
    <>
      {/* 透明遮罩：点击弹窗外即关闭。必须盖住正文（含 MOBI iframe）才能拦截这次按下、
          避免触发新一轮划词；z-index 低于弹窗，弹窗内按钮不受影响 */}
      <div
        className="trans-backdrop"
        onPointerDown={handleClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className={closing ? 'trans-popup exit' : 'trans-popup'} ref={popupRef} style={pos}>
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

        {/* 耗时诊断：first=首 token 前耗时（网络+排队+模型思考，这段时间画面在转圈），total=总耗时 */}
        {loading && timing?.first != null && (
          <div className="trans-timing">首字 {Math.round(timing.first)}ms…</div>
        )}
        {!loading && timing && (
          <div className="trans-timing">首字 {Math.round(timing.first)}ms · 总 {Math.round(timing.total)}ms</div>
        )}

        <div className="trans-actions">
          <div>
            <button className="btn" onClick={() => setMode(mode === 'deep' ? 'normal' : 'deep')}>
              {mode === 'deep' ? '普通翻译' : '深度翻译'}
            </button>
            <button className="btn" onClick={() => run(true)} disabled={loading}>
              重新翻译
            </button>
            <button className="btn" onClick={copy} disabled={!result || loading}>
              复制
            </button>
          </div>
          <button className="btn btn-ghost" onClick={handleClose}>
            关闭
          </button>
        </div>
      </div>
    </>
  )
}