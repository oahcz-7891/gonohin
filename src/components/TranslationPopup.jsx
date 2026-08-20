// 划词翻译弹窗：流式显示译文，支持重译 / 复制 / 关闭
// 两种模式：
//   normal —— 普通翻译（上下文注入，单次流式）
//   deep   —— 深度翻译（agent loop：初译 → 验证 → 修正 → 再验证），弹窗内可随时切换

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { translateStream, translateDeep, MAX_DEEP_LEN } from '../lib/translate'

const MAX_SOURCE_LEN = 2000

const STAGE_LABEL = {
  translating: '初译中…',
  verifying: '文章内验证…',
  fixing: '按审校意见修正…',
}

export default function TranslationPopup({ text, context = '', x, y, mode: initialMode = 'normal', onClose }) {
  const popupRef = useRef(null)
  // 初始模式来自调用方（触屏操作条的「翻译/深度翻译」区分），弹窗内可自由切换
  const [mode, setMode] = useState(initialMode) // 'normal' | 'deep'
  const [stage, setStage] = useState(null) // deep 模式阶段
  const [result, setResult] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pos, setPos] = useState({ left: 8, top: 8 })
  const [closing, setClosing] = useState(false) // 关闭退场动画中的标记，结束后再真正卸载
  const runIdRef = useRef(0)
  const abortRef = useRef(null) // 当前运行对应的 AbortController，用于真正打断进行中的请求
  const source = text.length > MAX_SOURCE_LEN ? text.slice(0, MAX_SOURCE_LEN) + '…' : text
  // 深度模式有长度上限：超长文本禁用切换
  const deepDisabled = text.length > MAX_DEEP_LEN

  // force：跳过缓存读取（「重新翻译」用），新结果仍会写回缓存
  const run = async (force = false) => {
    const runId = ++runIdRef.current
    abortRef.current?.abort() // 先打断上一次运行（重译 / 切模式），避免旧请求继续烧 token
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    setResult('')
    setStage(null)
    try {
      if (mode === 'deep') {
        const stream = translateDeep(source, context, undefined, setStage, ac.signal, { fresh: force })
        for await (const delta of stream) {
          if (runIdRef.current !== runId) return // 已被重译/切模式/关闭打断
          setResult((prev) => prev + delta)
        }
      } else {
        const stream = await translateStream(source, context, undefined, ac.signal, { fresh: force })
        for await (const delta of stream) {
          if (runIdRef.current !== runId) return // 已被重译/关闭打断
          setResult((prev) => prev + delta)
        }
      }
      setLoading(false)
    } catch (e) {
      if (runIdRef.current === runId) {
        setError(e.message)
        setLoading(false)
        setStage(null)
      }
    }
  }

  useEffect(() => {
    run()
    return () => {
      // 卸载时使进行中的流失效（需读最新 ref 值，勿复制到局部变量）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      runIdRef.current++
      // deep 模式的 agent loop 只在最后 yield 一次，靠 runId 拦不住，必须真正 abort 请求
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode])

  // 退场动画：先播 animation，结束后（或超时兜底）再调 onClose 卸载
  const closeTimerRef = useRef(0)
  const handleClose = () => {
    if (closing) return
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
          {loading &&
            (mode === 'deep' && stage ? (
              <span className="trans-stage">{STAGE_LABEL[stage]}</span>
            ) : (
              <span className="trans-loading">▍</span>
            ))}
        </div>
      )}

      <div className="trans-actions">
        <div>
          <button
            className="btn"
            onClick={() => setMode(mode === 'deep' ? 'normal' : 'deep')}
            disabled={mode === 'normal' && deepDisabled}
            title={deepDisabled && mode === 'normal' ? `文本超过 ${MAX_DEEP_LEN} 字，无法深度翻译` : undefined}
          >
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
  )
}