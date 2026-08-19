// 分词 Worker：kuromoji 在 Worker 里跑，避免大书分词卡 UI
// 词典随应用本地托管（public/dict/，来自 @patdx/kuromoji/dict，改名 .gz → .gzip）
// - 为什么改名：public 下的 .gz 文件某些静态服务器会加 Content-Encoding: gzip，
//   浏览器 fetch 会自动解压，再手动 DecompressionStream 会重复解压报错
// - 原版 kuromoji 字典是 gzip 压缩的，仍用 DecompressionStream 解压
// - 加载一次后缓存 tokenizer，后续请求直接复用
// - 浏览器 Worker 里没有 DOMParser，所以用轻量扫描器定位文本段、逐字节保留原文，
//   只把命中的日文文本替换为 <span class="tok"> 包裹版本

import * as kuromoji from '@patdx/kuromoji'

// 不能用 './dict/'：worker 脚本在 dev 位于 /src/lib/、构建后位于 /assets/，
// 相对路径会解析到 /src/lib/dict/ 或 /assets/dict/（均不存在）。
// 用 BASE_URL 拼绝对路径：dev 与构建后都是 /dict/，子路径部署也跟着 base。
const DICT_BASE = import.meta.env.BASE_URL + 'dict/'

let tokenizerPromise = null

async function decompressGzip(data) {
  const ds = new DecompressionStream('gzip')
  const stream = new Response(data).body.pipeThrough(ds)
  return new Response(stream).arrayBuffer()
}

async function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const loader = {
        async loadArrayBuffer(filename) {
          // kuromoji 请求的是 base.dat.gz 等，本地文件为 base.dat.gzip
          const local = filename.replace(/\.gz$/, '.gzip')
          const url = DICT_BASE + local
          const res = await fetch(url)
          if (!res.ok) throw new Error(`词典加载失败: ${url} (${res.status})`)
          const data = await res.arrayBuffer()
          return filename.endsWith('.gz') ? decompressGzip(data) : data
        },
      }
      return new kuromoji.TokenizerBuilder({ loader }).build()
    })()
  }
  return tokenizerPromise
}

// 只对含日文假名/汉字的文本段分词；纯空白/标点段跳过，少建 span 也保留换行结构
const JP_RE = /[ぁ-んァ-ヶー一-龯々〆ヵヶ]/

// 助动词（た/だ/ない/ます 等）和接续助词（て/で/ながら/ば 等）并入前面的动词/形容词/助动词词干，
// 让「なかった」「並んで」「食べて」整体成为一个可选词；
// 非自立动词/形容词（だす/始める/すぎる/やすい 等）和接尾辞动词（れる/られる/せる 等被动·使役，
// ipadic 里标为 動詞・接尾）直接接连用形词干时并入，
// 构成词典词条「歩き出す」「作られて」；
// 但跟在て/で后面的补助动词（ください/いる/もらう/ほしい 等）不并入——
// 那是句式（てください/ている/てもらう），不是词条，整体反而没法查词
// 名词后的助动词（本+です）保持分开；格助词（東京で）、连体助词（日本語の）不合并；
// サ変名词+する（勉強する，する为自立）不合并
const MERGEABLE = new Set(['動詞', '形容詞', '助動詞'])

// 内容原样保留、不做分词包裹的标签（script/style 里可能有 < 等字符）
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

// 从 < 开始找到标签结束位置（跳过引号内的 >）
function findTagEnd(s, from) {
  let quote = null
  for (let j = from + 1; j < s.length; j++) {
    const c = s[j]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return j + 1
    }
  }
  return -1
}

function escapeAttr(v) {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 把一段纯文本按 kuromoji 切分，返回包好 span 后的字符串；
// kuromoji 的 surface_form 是原文子串，按顺序拼接可无损还原
function wrapTextSegment(seg, tokenizer) {
  if (!seg || !JP_RE.test(seg)) return seg
  const tokens = tokenizer.tokenize(seg)
  if (!tokens.length) return seg
  const parts = []
  let last = null
  let lastMergeable = false
  let lastEndsWithTe = false // 上一个合并单元是否以て/で（接続助詞）结尾
  for (const t of tokens) {
    const pos = t.pos || '記号'
    const isTe = t.pos === '助詞' && t.pos_detail_1 === '接続助詞'
    // 非自立或接尾（被动·使役的 れ/られ/せ 在 ipadic 里标为 動詞・接尾）
    const isAux =
      (t.pos === '動詞' || t.pos === '形容詞') &&
      (t.pos_detail_1 === '非自立' || t.pos_detail_1 === '接尾')
    // 助動詞/接続助詞直接并入；非自立/接尾动词仅当直接接连用形词干时并入
    // （lastEndsWithTe 时是 て+补助动词 句式，如 並んで+ください、されて+いる，不并入）
    const merges = t.pos === '助動詞' || isTe || (isAux && !lastEndsWithTe)
    if (merges && last && lastMergeable) {
      last.text += t.surface_form
      if (isTe) lastEndsWithTe = true
      continue
    }
    last = { text: t.surface_form, pos }
    parts.push(last)
    lastMergeable = MERGEABLE.has(pos)
    lastEndsWithTe = isTe
  }
  let out = ''
  let off = 0
  for (const p of parts) {
    if (!p.text || !seg.startsWith(p.text, off)) return seg
    out += `<span class="tok" data-pos="${escapeAttr(p.pos)}">${p.text}</span>`
    off += p.text.length
  }
  return off === seg.length ? out : seg
}

// 轻量 HTML 扫描：结构（标签/注释/CDATA/doctype/script/style 内容）原样保留，
// 只对标签之间的文本段做分词包装。不用 DOMParser 是为了兼容浏览器 Worker。
function wrapHtml(html, tokenizer) {
  const lower = html.toLowerCase()
  let out = ''
  let i = 0
  const n = html.length
  let textStart = 0
  const flushText = (end) => {
    if (end > textStart) {
      const seg = html.slice(textStart, end)
      out += seg && JP_RE.test(seg) ? wrapTextSegment(seg, tokenizer) : seg
    }
  }
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    const next = html[lt + 1]
    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4)
        if (end === -1) break
        flushText(lt)
        out += html.slice(lt, end + 3)
        i = end + 3
        textStart = i
        continue
      }
      if (html.startsWith('<![CDATA[', lt)) {
        const end = html.indexOf(']]>', lt + 9)
        if (end === -1) break
        flushText(lt)
        out += html.slice(lt, end + 3)
        i = end + 3
        textStart = i
        continue
      }
      const end = findTagEnd(html, lt)
      if (end === -1) break
      flushText(lt)
      out += html.slice(lt, end)
      i = end
      textStart = i
      continue
    }
    if (next === '?') {
      const end = html.indexOf('?>', lt + 2)
      if (end === -1) break
      flushText(lt)
      out += html.slice(lt, end + 2)
      i = end + 2
      textStart = i
      continue
    }
    if (next === '/' || (next && /[A-Za-z]/.test(next))) {
      const end = findTagEnd(html, lt)
      if (end === -1) break
      flushText(lt)
      out += html.slice(lt, end)
      i = end
      if (!html.startsWith('</', lt)) {
        const tagMatch = html.slice(lt, end).match(/^<\s*([A-Za-z][A-Za-z0-9]*)/)
        const tagName = tagMatch ? tagMatch[1].toLowerCase() : ''
        if (RAW_TEXT_TAGS.has(tagName)) {
          const close = lower.indexOf('</' + tagName, end)
          if (close !== -1) {
            const closeEnd = html.indexOf('>', close)
            if (closeEnd !== -1) {
              out += html.slice(end, closeEnd + 1)
              i = closeEnd + 1
              textStart = i
              continue
            }
          }
        }
      }
      textStart = i
      continue
    }
    // 裸 <（不是标签）当作普通文本
    i = lt + 1
  }
  flushText(n)
  return out
}

// 分词必须在消息处理里同步完成：先 build tokenizer，之后 tokenize 是同步的
let tokenizer = null

self.onmessage = async (e) => {
  const { id, html } = e.data
  try {
    if (!tokenizer) tokenizer = await getTokenizer()
    self.postMessage({ id, html: wrapHtml(html, tokenizer) })
  } catch (err) {
    self.postMessage({ id, error: err.message })
  }
}
