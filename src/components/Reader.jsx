// 阅读器壳：按格式分发渲染器，统一状态栏 / 字号控制 / 键盘翻页 / 进度保存

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import TxtRenderer from './renderers/TxtRenderer'
import EpubRenderer from './renderers/EpubRenderer'
import MobiRenderer from './renderers/MobiRenderer'
import PdfRenderer from './renderers/PdfRenderer'
import TranslationPopup from './TranslationPopup'
import UiTestPanel from './UiTestPanel'
import { FORMATS } from '../lib/constants'
import { getProgress, getSettings } from '../lib/storage'
import { useAutoSave } from '../hooks/useAutoSave'
import { useSelection } from '../hooks/useSelection'
import { resolveTheme } from '../lib/theme'
import {
  diagEvent,
  diagInZone,
  diagMove,
  diagRequest,
  diagSettle,
  diagTouchStart,
  diagUp,
  getFlags,
  subscribe,
} from '../lib/uitest'

const MIN_FONT = 14
const MAX_FONT = 32
// 纯标点/空白选区（如误拖到行末标点）不弹复制/翻译，避免打扰
const PUNCT_ONLY_RE = /^[\s、。，．,.;:!?！？…—―～「」『』（）()【】《》〈〉"'“”‘’]*$/
// 触屏（手机/平板）：屏蔽系统菜单，选中后自绘“复制 / 翻译”操作条；
// 鼠标设备保持原行为，选中后直接弹翻译窗。
const IS_TOUCH =
  typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || matchMedia('(hover: none)').matches)

export default function Reader({ book, onBack }) {
  const [initialProgress] = useState(() => getProgress(book.id))
  const [fontSize, setFontSize] = useState(initialProgress?.fontSize ?? 18)
  const [theme, setTheme] = useState(() => resolveTheme(getSettings().theme))
  // 触屏设备默认开启划词模式（设备模式/手机浏览器下原生长按选择不可用或不便，
  // 划词模式下触摸拖动直接选词，翻页改用左右两侧按钮）；用户手动切换会记住
  const [selectMode, setSelectMode] = useState(() => {
    if (initialProgress?.selectMode != null) return initialProgress.selectMode
    return typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || matchMedia('(hover: none)').matches)
  })
  // 顶栏/状态栏常驻不消失（按用户要求关闭自动隐藏）；CSS 浮层结构保留，
  // 换来的好处是不管 chrome 配什么背景都不挤压正文区域
  const locRef = useRef(initialProgress ?? {})
  const [status, setStatus] = useState(null) // { pageIndex, totalPages }
  // 渲染器实测的正文左右内缩（px）。目前只有 MOBI 会报（列 padding 固定 28px，
  // 与 --page-zone 不一致），用来把翻页热区收窄到「刚好到文字边缘」，避免热区压字
  const [navZone, setNavZone] = useState(null)
  const [selection, setSelection] = useState(null) // { text, context, x, y } → 划词翻译弹窗
  const [translateOpen, setTranslateOpen] = useState(false) // 触屏：点“翻译（AI）”后再打开弹窗
  const [deepMode, setDeepMode] = useState(false) // 触屏：点“深度翻译”以普通流式打开（思考强度走深度档）
  const [copied, setCopied] = useState(false) // 复制成功后的短暂反馈
  const [dragPct, setDragPct] = useState(null) // 进度条拖动中的临时值（0-1000），松开后跳页
  const [actionsClosing, setActionsClosing] = useState(false) // 操作条退场动画中
  const [fontSizeOpen, setFontSizeOpen] = useState(false) // 顶栏字号步进浮层
  const apiRef = useRef(null)
  const copyTimerRef = useRef(0)
  const actionsCloseTimerRef = useRef(0)

  // 关字号浮层。不再需要抑制 chrome 手势（那套手势已下线），保留 suppress 是为了
  // 防止关闭浮层的那一下同选区重放误弹操作条（同弹窗遮罩）
  const closeFontMenu = useCallback(() => {
    suppressUntilRef.current = Date.now() + 400
    setFontSizeOpen(false)
  }, [])
  // 关闭弹窗/操作条后的一小段窗口内忽略划词上报：
  // 点弹窗外关闭时，TXT/PDF 的旧选区还在，useSelection 会在 touchend 后把同一选区再上报一次，
  // 不拦的话刚点外部关掉又会立刻弹回来。MOBI/EPUB 选区在 iframe 里不受影响，但统一拦也无害。
  const suppressUntilRef = useRef(0)
  const suppressSelection = useCallback(() => {
    suppressUntilRef.current = Date.now() + 400
  }, [])

  // 渲染器进度上报：只更新内存 + 状态栏，落盘交给 useAutoSave
  const handleProgress = useCallback(
    (loc) => {
      locRef.current = { ...loc }
      setStatus(loc)
    },
    [],
  )

  // 「跟随系统」时系统切换深浅色，阅读页纸面（MOBI/EPUB 的 iframe 底色）要跟着变
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTheme(resolveTheme(getSettings().theme))
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    setNavZone(null)
  }, [book.id])

  useAutoSave(book.id, () =>
    locRef.current.pageIndex != null || locRef.current.cfi ? { ...locRef.current, fontSize, selectMode } : null,
  )

  // 划词上报统一入口：纯标点/空白选区直接丢弃，不弹“复制/翻译”
  const handleSelection = useCallback((sel) => {
    setActionsClosing(false)
    clearTimeout(actionsCloseTimerRef.current)
    if (!sel) return
    const text = (sel.text || '').trim()
    if (!text || PUNCT_ONLY_RE.test(text)) {
      setSelection(null)
      setTranslateOpen(false)
      return
    }
    // 刚关掉弹窗/操作条后的同一选区重放要忽略，避免“点外部关闭 → 又弹回来”
    if (Date.now() < suppressUntilRef.current) return
    setSelection(sel)
    setTranslateOpen(false) // 新选区出现时回到“复制 / 翻译”操作条
    setDeepMode(false)
  }, [])

  // 统一划词监听：document（TXT/PDF）+ iframe（MOBI），EPUB 走 epubjs 内置事件
  const { clearSelections } = useSelection(handleSelection)

  /* 触屏翻页不能只靠 click。
     iOS 上如果上一次翻页的平滑滚动还在跑（或滚动惯性未停），这一下点击会被系统当成
     「把滚动停下来」—— click 根本不派发，表现就是「有时点了没反应」。桌面鼠标没有
     滚动惯性，所以永远复现不出来。
     所以自己判手势：按下到抬起位移 < 10px 且 < 500ms 才算点击，直接翻页；
     位移大就交给滚动容器（正文区滑动翻页照旧）。
     touchend 与 pointerup 两条都挂了：不同 webkit 版本在「停下惯性滚动」时
     补发的事件不一样，两条共用同一次手势记录，先到先算。 */
  const navGestureRef = useRef(null)
  const navClickGuardRef = useRef(0)
  const autoSettleRef = useRef(0)
  const shellRef = useRef(null)
  const uiFlags = useSyncExternalStore(subscribe, getFlags)

  // 翻页唯一出口（诊断需要知道「我们确实发了指令」）
  const turn = (dir) => {
    diagRequest()
    if (uiFlags.clearSelectionOnTurn) clearSelections()
    if (dir < 0) apiRef.current?.prev()
    else apiRef.current?.next()
  }

  // ------------------------------------------------------------ 诊断埋点
  // 一次触摸一条记录：落点元素、事件流水、位移/时长、浮层、页码变化。
  // 挂在 shell 根而不是 .reader-body：操作条遮罩与翻译弹窗是 body 的兄弟节点，
  // 挂在 body 上会漏掉「被遮罩吃掉的那一触」（日志里会出现无法解释的空洞）。
  const overlayDesc = () => {
    const el = document.querySelector('.sel-backdrop,.trans-backdrop,.font-menu-backdrop')
    return el ? String(el.className).split(' ')[0] : ''
  }
  const shortEl = (el) => (el && el.tagName ? `${el.tagName}.${String(el.className || '').split(' ')[0]}` : '-')

  useEffect(() => {
    const el = shellRef.current
    if (!uiFlags.debug || !el) return
    const CODES = {
      touchstart: 'ts',
      touchend: 'te',
      touchcancel: 'tc',
      touchmove: 'mv',
      pointerdown: 'pd',
      pointerup: 'pu',
      pointercancel: 'pc',
      click: 'ck',
      contextmenu: 'cm',
    }
    const pick = (e) => {
      const t = e.touches?.[0] || e.changedTouches?.[0]
      return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX, y: e.clientY }
    }
    const inZone = (p) =>
      [...document.querySelectorAll('.page-nav')].some((n) => {
        const r = n.getBoundingClientRect()
        return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
      })
    const onAny = (e) => {
      const code = CODES[e.type]
      if (!code) return
      if (e.target?.closest?.('.ut')) return // 诊断面板自己的操作不记
      if (e.type === 'touchstart' || e.type === 'pointerdown') {
        const p = pick(e)
        diagTouchStart(p, shortEl(e.target), overlayDesc(), inZone(p))
      } else if (e.type === 'touchmove') {
        const p = pick(e)
        diagMove(p.x, p.y)
      }
      diagEvent(code)
      // 抬起/取消：先结算页码，等动画走完再补最终页码
      if (e.type === 'touchend' || e.type === 'pointerup' || e.type === 'touchcancel' || e.type === 'pointercancel') {
        diagUp(locRef.current?.pageIndex, overlayDesc())
        clearTimeout(autoSettleRef.current)
        autoSettleRef.current = setTimeout(() => diagSettle(locRef.current?.pageIndex), 900)
      }
    }
    const types = Object.keys(CODES)
    types.forEach((t) => el.addEventListener(t, onAny, { capture: true, passive: true }))
    return () => {
      types.forEach((t) => el.removeEventListener(t, onAny, { capture: true }))
      clearTimeout(autoSettleRef.current)
    }
  }, [uiFlags.debug])

  // ------------------------------------------------------------ 翻页手势
  // 一次触摸手势的收尾：无论最终翻不翻页，都要吃掉浏览器随后补发的 click。
  // 否则长按/滑动也会走 click 再翻一次，「什么时候会翻」就不确定了。
  const navGestureEnd = (dir, x, y) => {
    const g = navGestureRef.current
    if (!g) return // 已被另一条事件（pointerup / touchend）处理过
    navGestureRef.current = null
    if (!uiFlags.tapByGesture) return // ① 关掉：完全交给 click（对照组）
    navClickGuardRef.current = Date.now() + 700
    if (Math.hypot(x - g.x, y - g.y) > 10) return // 滑动：交给滚动
    if (Date.now() - g.at > 500) return // 长按：不翻页
    turn(dir)
  }
  const navDown = (dir) => (e) => {
    diagInZone(dir)
    if (e.pointerType !== 'touch') return
    if (uiFlags.turnOnPointerDown) {
      // ② 不等抬起：抬手时不再翻一次
      navGestureRef.current = null
      navClickGuardRef.current = Date.now() + 700
      turn(dir)
      return
    }
    navGestureRef.current = { x: e.clientX, y: e.clientY, at: Date.now(), id: null }
  }
  const navTouchStart = (dir) => (e) => {
    diagInZone(dir)
    if (uiFlags.turnOnPointerDown) return
    const t = e.changedTouches[0]
    if (t) navGestureRef.current = { x: t.clientX, y: t.clientY, at: Date.now(), id: t.identifier }
  }
  const navTouchEnd = (dir) => (e) => {
    const g = navGestureRef.current
    if (!g) return
    const t = [...e.changedTouches].find((x) => x.identifier === g.id) || e.changedTouches[0]
    if (t) navGestureEnd(dir, t.clientX, t.clientY)
  }
  const navPointerUp = (dir) => (e) => {
    if (e.pointerType !== 'touch') return // 鼠标走 click
    navGestureEnd(dir, e.clientX, e.clientY)
  }
  // 鼠标 / 键盘（Enter、空格）
  const navClick = (dir) => () => {
    if (Date.now() < navClickGuardRef.current) return
    turn(dir)
  }
  const navHandlers = (dir) => ({
    onPointerDown: navDown(dir),
    onTouchStart: navTouchStart(dir),
    onTouchEnd: navTouchEnd(dir),
    onPointerUp: navPointerUp(dir),
    onClick: navClick(dir),
  })

  // 翻页后清掉旧选区和操作条，避免停留在错误位置
  useEffect(() => {
    setActionsClosing(false)
    setSelection(null)
    setTranslateOpen(false)
  }, [status?.pageIndex])

  // 退场动画：先播退场，结束后（超时兜底）再清掉选区和操作条
  const closeActions = () => {
    if (actionsClosing) return
    suppressSelection() // 关闭后短暂忽略旧选区重放，避免 TXT/PDF 下刚关又弹回来
    setActionsClosing(true)
    actionsCloseTimerRef.current = setTimeout(() => {
      setSelection(null)
      setTranslateOpen(false)
      setActionsClosing(false)
    }, 200)
  }

  // 组件卸载时清掉复制 / 操作条退场定时器
  useEffect(
    () => () => {
      clearTimeout(copyTimerRef.current)
      clearTimeout(actionsCloseTimerRef.current)
    },
    [],
  )

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
    <div className="reader-shell" ref={shellRef}>
      <header className="reader-topbar">
        <button className="icon-btn" onClick={onBack} title="返回书架" aria-label="返回书架">
          ‹
        </button>
        <span className="reader-title">{book.title}</span>
        <button
          className={`icon-btn${fontSizeOpen ? ' on' : ''}`}
          title="字号"
          aria-label="字号"
          onClick={() => setFontSizeOpen((v) => !v)}
        >
          A
        </button>
        <button
          className={`icon-btn${selectMode ? ' on' : ''}`}
          title="划词模式：开启后可直接拖动选择文字"
          aria-label="划词模式"
          onClick={() => setSelectMode((v) => !v)}
        >
          {/* 线性铅笔（lucide pencil）：✎ 是字符图标，iOS 与桌面端字形差别很大，
              跨端一致只能自己画 */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
      </header>

      <div className="reader-body" style={navZone ? { '--nav-zone': `${navZone}px` } : undefined}>
        {book.format === FORMATS.TXT && (
          <TxtRenderer ref={apiRef} book={book} progress={initialProgress} fontSize={fontSize} onProgress={handleProgress} onSelection={handleSelection} />
        )}
        {book.format === FORMATS.EPUB && (
          <EpubRenderer ref={apiRef} book={book} progress={initialProgress} fontSize={fontSize} theme={theme} onProgress={handleProgress} onSelection={handleSelection} />
        )}
        {book.format === FORMATS.MOBI && (
          <MobiRenderer ref={apiRef} book={book} progress={initialProgress} fontSize={fontSize} selectMode={selectMode} theme={theme} onProgress={handleProgress} onSelection={handleSelection} onNavZone={setNavZone} />
        )}
        {book.format === FORMATS.PDF && (
          <PdfRenderer ref={apiRef} book={book} progress={initialProgress} onProgress={handleProgress} onSelection={handleSelection} />
        )}
        <button
          className={`page-nav page-nav-prev${selectMode ? ' page-nav-select-mode' : ''}${uiFlags.navTouchActionNone ? ' page-nav-notouch' : ''}`}
          title="上一页"
          {...navHandlers(-1)}
        >
          ‹
        </button>
        <button
          className={`page-nav page-nav-next${selectMode ? ' page-nav-select-mode' : ''}${uiFlags.navTouchActionNone ? ' page-nav-notouch' : ''}`}
          title="下一页"
          {...navHandlers(1)}
        >
          ›
        </button>
      </div>

      {fontSizeOpen && (
        <>
          {/* 遮罩与浮层都挂在 shell 根部，不放 header 里：
              topbar 有 backdrop-filter，会给 fixed 子元素建立 containing block，
              遮罩放里面会被裁成 topbar 自己的盒子，点正文区域关不掉 */}
          <div className="font-menu-backdrop" onPointerDown={closeFontMenu} onContextMenu={(e) => e.preventDefault()} />
          <div className="font-menu" role="group" aria-label="字号">
            <button
              className="icon-btn"
              title="减小字号"
              aria-label="减小字号"
              onClick={() => setFontSize((f) => Math.max(MIN_FONT, f - 2))}
            >
              A−
            </button>
            {/* 步进点：当前档位亮金，每档 2px（MIN_FONT ～ MAX_FONT） */}
            <div className="font-dots" aria-hidden="true">
              {Array.from({ length: (MAX_FONT - MIN_FONT) / 2 + 1 }, (_, i) => {
                const v = MIN_FONT + i * 2
                return <i key={v} className={v >= fontSize ? 'on' : ''} style={{ width: 4 + i }} />
              })}
            </div>
            <button
              className="icon-btn"
              title="增大字号"
              aria-label="增大字号"
              onClick={() => setFontSize((f) => Math.min(MAX_FONT, f + 2))}
            >
              A+
            </button>
          </div>
        </>
      )}

      <footer className="reader-statusbar">
        {status ? (
          <span>
            {status.pageIndex != null ? `${status.pageIndex + 1} / ${status.totalPages} 页` : ''}
          </span>
        ) : null}
        {/* 进度条：可拖动跳页。拖动中只更新滑块位置（不跳页防卡顿），松开时跳转。
            填充比例经 --pct 传给 ::-webkit-slider-runnable-track（内联渐变会被 input 的
            22px 高度撑成一条粗色块，画在 track 伪元素上才是 3px 细线） */}
        <input
          type="range"
          className="progress-track"
          min={0}
          max={1000}
          step={1}
          value={dragPct ?? pct * 10}
          aria-label="阅读进度"
          style={{ '--pct': `${(dragPct ?? pct * 10) / 10}%` }}
          onInput={(e) => setDragPct(Number(e.target.value))}
          onChange={(e) => {
            apiRef.current?.goToPercent?.(Number(e.target.value) / 1000)
            setDragPct(null)
          }}
        />
        <span>{pct}%</span>
      </footer>

      {selection && !IS_TOUCH && (
        <TranslationPopup {...selection} onBackdropPress={suppressSelection} onClose={() => setSelection(null)} />
      )}

      {selection && IS_TOUCH && !translateOpen && (
        <>
          {/* 操作条遮罩：点操作条外即关闭，且拦截这次按下避免重新划词（同弹窗遮罩） */}
          <div
            className="sel-backdrop"
            onPointerDown={() => {
              suppressSelection()
              closeActions()
            }}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div
            className={actionsClosing ? 'sel-actions exit' : 'sel-actions'}
            style={{
              // 300 = 操作条最大宽度（4 个按钮 + 间距 + 内边距，见 .sel-actions）。
              // 钳位小于实际宽度会被 flex 压窄 → 按钮文字折行
              left: Math.max(8, Math.min(selection.x, window.innerWidth - 300)),
              top: Math.max(8, Math.min(selection.y + 10, window.innerHeight - 56)),
            }}
          >
            <button onClick={copySelection}>{copied ? '已复制' : '复制'}</button>
            <button onClick={() => setTranslateOpen(true)}>翻译</button>
            <button
              onClick={() => {
                setDeepMode(true)
                setTranslateOpen(true)
              }}
            >
              深度翻译
            </button>
            <button
              className="sel-actions-close"
              aria-label="关闭"
              onClick={closeActions}
            >
              ✕
            </button>
          </div>
        </>
      )}

      {selection && IS_TOUCH && translateOpen && (
        <TranslationPopup
          {...selection}
          mode={deepMode ? 'deep' : 'normal'}
          onBackdropPress={suppressSelection}
          onClose={() => {
            setSelection(null)
            setTranslateOpen(false)
          }}
        />
      )}

      {/* 真机排障面板（默认不渲染，见 lib/uitest.js）。放在 shell 根部，
          和弹窗一样避免被 topbar 的 backdrop-filter 裁掉 */}
      <UiTestPanel format={book.format} />
    </div>
  )
}
