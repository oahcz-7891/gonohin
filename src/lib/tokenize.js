// 分词客户端封装：懒创建 Worker，按消息 id 做请求/响应配对

let worker = null
let seq = 0
const pending = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./tokenize.worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const { id, html, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (error) p.reject(new Error(error))
    else p.resolve(html)
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || '分词 Worker 崩溃')
    pending.forEach((p) => p.reject(err))
    pending.clear()
    worker = null
  }
  return worker
}

/** 把整段 HTML 的文本节点按形态素分词，返回包裹 <span class="tok" data-pos="品詞"> 后的新 HTML */
export function tokenizeHtml(html) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, html })
  })
}
