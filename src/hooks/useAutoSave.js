// 进度自动保存：定时兜底 + 页面隐藏时立即 flush

import { useEffect, useRef } from 'react'
import { saveProgress } from '../lib/storage'

/**
 * @param {string} bookId 书籍 id
 * @param {() => object|null} getPayload 每次调用返回要保存的进度对象（从 ref 读最新值）
 * 渲染器进度变化时只更新内存（ref），本 hook 负责落盘：5s 定时 + beforeunload/visibilitychange。
 */
export function useAutoSave(bookId, getPayload) {
  const getRef = useRef(getPayload)
  getRef.current = getPayload

  useEffect(() => {
    const flush = () => {
      const payload = getRef.current()
      if (payload) saveProgress(bookId, payload)
    }
    const timer = setInterval(flush, 5000)
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onHide)
    }
  }, [bookId])
}
