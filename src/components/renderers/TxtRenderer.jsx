// TXT 渲染器：CSS columns 分页（一屏一列），翻页 = scrollLeft 步进
// 优点：不切文本（选区可跨页）、字号/窗口变化自动重排，进度按页索引恢复

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { decodeTxt } from '../../utils/text'
import { getFlags } from '../../lib/uitest'
// 诊断策略③：瞬时跳页。平滑动画/滚动惯性在 iOS 上可能吞掉手势，用瞬时跳页验证（lib/uitest.js）
const scrollBehavior = () => (getFlags().instantScroll ? 'auto' : 'smooth')

const GAP = 40 // column-gap 固定 40px，与 step 计算一致

export default function TxtRenderer({ ref, book, progress, onProgress, fontSize }) {
  const [text, setText] = useState(null)
  const [error, setError] = useState(null)
  const [colWidth, setColWidth] = useState(0)
  const colsRef = useRef(null)
  const pageIndexRef = useRef(progress?.pageIndex ?? 0)
  // 程序化翻页的目标页。翻页是平滑滚动，动画途中 scrollLeft 是中间值，用它反推出来的
  // pageIndexRef 会滞后——连点两下只会走一页；而「停 200ms 吸附到整页」的逻辑若按中间值取整，
  // 还会把页面拉回出发页（iOS 上动画一卡就发生）。所以程序化翻页自己记目标：
  // move() 只改它，settle() 以它为准（吸附 = 把这一页走完），走完再交还给手势。
  const navTargetRef = useRef(null)

  // 1. 解码文本（UTF-8 检测失败回退 Shift_JIS）
  useEffect(() => {
    let alive = true
    decodeTxt(book.blob)
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [book.id, book.blob])

  // 2. 容器宽度 → 列宽（一屏一列）
  //    useLayoutEffect：文本加载后要在首帧绘制前量好列宽并定位，否则会先画出第一页再跳回去
  useLayoutEffect(() => {
    const el = colsRef.current
    if (!el) return
    const update = () => {
      // 左右留白跟随 CSS（--page-zone），读取实际 padding 保证列宽与热区对齐
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0
      setColWidth(Math.max(100, el.clientWidth - pad * 2))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  // 3. 列宽/字号/文本变化时保持当前页比例重定位
  useLayoutEffect(() => {
    const el = colsRef.current
    if (!el || !colWidth) return
    el.scrollLeft = pageIndexRef.current * (colWidth + GAP)
    navTargetRef.current = null // 重排后旧的翻页目标作废
  }, [colWidth, fontSize, text])

  // 3.5 列宽/文本就绪后立即计算一次页码（初次加载无滚动事件，否则页码与进度不显示）
  useEffect(() => {
    const el = colsRef.current
    if (!el || !colWidth || !text) return
    const step = colWidth + GAP
    const totalPages = Math.max(1, Math.round(el.scrollWidth / step))
    const pageIndex = Math.min(totalPages - 1, Math.max(0, Math.round(el.scrollLeft / step)))
    pageIndexRef.current = pageIndex
    onProgress({ pageIndex, totalPages, percentage: (pageIndex + 1) / totalPages })
  }, [colWidth, text, onProgress])

  // 4. 滚动 → 更新页码与进度（rAF 节流）+ 停止后吸附到完整页
  useEffect(() => {
    const el = colsRef.current
    if (!el || !colWidth) return
    let raf = 0
    let snapTimer = 0
    const step = colWidth + GAP
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const totalPages = Math.max(1, Math.round(el.scrollWidth / step))
        const pageIndex = Math.min(totalPages - 1, Math.max(0, Math.round(el.scrollLeft / step)))
        pageIndexRef.current = pageIndex
        onProgress({ pageIndex, totalPages, percentage: (pageIndex + 1) / totalPages })
      })
      // 滚动停止后吸附到最近的完整页（手指滑动翻页后不能停在半页）
      clearTimeout(snapTimer)
      snapTimer = setTimeout(settle, 200)
    }
    // 吸附：有程序化翻页目标就把它走完，否则吸附到离指尖最近的整页。
    // 每次滚动都会重排 200ms 定时器，所以动画途中不会提前触发；
    // 即便触发了，也是朝着目标页继续走，不会反向拉回。
    const settle = () => {
      clearTimeout(snapTimer)
      const totalPages = Math.max(1, Math.round(el.scrollWidth / step))
      const intended = navTargetRef.current
      const page =
        intended != null
          ? Math.min(Math.max(intended, 0), totalPages - 1)
          : Math.min(totalPages - 1, Math.max(0, Math.round(el.scrollLeft / step)))
      const target = page * step
      if (Math.abs(target - el.scrollLeft) > 1) el.scrollTo({ left: target, behavior: scrollBehavior() })
      else if (intended != null) navTargetRef.current = null
    }
    const onScrollEnd = () => settle()
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('scrollend', onScrollEnd)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('scrollend', onScrollEnd)
      clearTimeout(snapTimer)
      cancelAnimationFrame(raf)
    }
  }, [colWidth, onProgress])

  // 5. 对外翻页 API（Reader 壳的翻页按钮/键盘调用）
  useImperativeHandle(
    ref,
    () => {
      const move = (delta) => {
        const el = colsRef.current
        if (!el) return
        const step = colWidth + GAP
        const totalPages = Math.max(1, Math.round(el.scrollWidth / step))
        // 以「上一个目标页」为基准而不是滚动位置：连点时不会因为动画未完成而原地踏步
        const base = navTargetRef.current ?? pageIndexRef.current
        const page = Math.min(Math.max(base + delta, 0), totalPages - 1)
        navTargetRef.current = page
        el.scrollTo({ left: page * step, behavior: scrollBehavior() })
      }
      return {
        next: () => move(1),
        prev: () => move(-1),
        goToPercent: (p) => {
          const el = colsRef.current
          if (!el) return
          navTargetRef.current = null // 瞬时跳转，不走平滑动画
          const step = colWidth + GAP
          const totalPages = Math.max(1, Math.round(el.scrollWidth / step))
          // 先算目标页再对齐到列宽步长，保证落在完整页
          const target = Math.min(totalPages - 1, Math.max(0, Math.round(p * (totalPages - 1))))
          el.scrollTo({ left: target * step, behavior: 'auto' })
        },
      }
    },
    [colWidth],
  )

  if (error) {
    return (
      <div className="placeholder">
        <span>打开失败：{error}</span>
      </div>
    )
  }
  if (!text) {
    return (
      <div className="placeholder">
        <span>加载中…</span>
      </div>
    )
  }

  return (
    <div className="renderer-container">
      <div className="txt-scroll" ref={colsRef}>
        <div className="txt-cols" style={{ fontSize: `${fontSize}px`, columnWidth: `${colWidth}px` }}>
          {text}
        </div>
      </div>
    </div>
  )
}
