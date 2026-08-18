// IndexedDB 极简封装：单库 gonohin-db，单 store books
// 一条书记录存全量（含 Blob，可结构化克隆）；封面单独存 key 'cover:'+id 避免书架反复读全书

const DB_NAME = 'gonohin-db'
const STORE = 'books'
const COVER_PREFIX = 'cover:'

let dbPromise = null

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function run(mode, fn) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    // 注意：resolve 的是 req.result（数据），不是 req（IDBRequest 对象）本身
    t.oncomplete = () => resolve(req?.result)
    t.onerror = () => reject(t.error)
  })
}

/** 存书（新增或更新），record = { id, title, author, format, size, addedAt, blob } */
export function putBook(record) {
  return run('readwrite', (store) => store.put(record))
}

/** 单独存封面，key 为 'cover:' + bookId */
export function putCover(bookId, coverBlob) {
  return run('readwrite', (store) => store.put({ id: COVER_PREFIX + bookId, blob: coverBlob }))
}

/** 取一本书的完整记录（含 blob） */
export async function getBook(bookId) {
  const rec = await run('readonly', (store) => store.get(bookId))
  return rec || null
}

/** 取封面 Blob，没有则返回 null */
export async function getCover(bookId) {
  const rec = await run('readonly', (store) => store.get(COVER_PREFIX + bookId))
  return rec ? rec.blob : null
}

/** 全部书的元数据列表（不含 blob 大字段，书架用） */
export async function getAllBooks() {
  const all = await run('readonly', (store) => store.getAll())
  return all.filter((r) => !r.id.startsWith(COVER_PREFIX))
}

/** 删除书及其封面 */
export async function deleteBook(bookId) {
  return run('readwrite', (store) => {
    store.delete(bookId)
    store.delete(COVER_PREFIX + bookId)
  })
}
