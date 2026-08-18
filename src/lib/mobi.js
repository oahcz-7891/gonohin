// MOBI 解析补丁层：修复库的两个问题
//
// 1. PalmDOC compression 映射错误（dist/index.browser.mjs setup()）：
//    规范 1=PalmDOC 压缩、2=无压缩，库写反了，导致无压缩书正文损坏、压缩书乱码。
//    修补：按正确映射覆盖 decompress 后重新 innerInit。
//
// 2. hybrid 书（MOBI version>=8，含 KF8 部分）必须用 initKf8File 解析：
//    initMobiFile 的 Mobi 类按 PalmDOC 记录流读文本，对 KF8 记录区会读出乱码。
//    修补：预检测 version，>=8 自动路由到 initKf8File。

import { initMobiFile, initKf8File } from '@lingo-reader/mobi-parser'

/** PalmDOC 解压算法（与库内实现一致，自实现以便在修补中复用） */
export function palmDocDecompress(array) {
  const output = []
  for (let i = 0; i < array.length; i++) {
    const byte = array[i]
    if (byte === 0) {
      output.push(0)
    } else if (byte <= 8) {
      // 字面量重复：后续 byte 个字节原样复制
      for (const x of array.subarray(i + 1, (i += byte) + 1)) output.push(x)
    } else if (byte <= 127) {
      output.push(byte) // 字面量
    } else if (byte <= 191) {
      // LZ77 回溯引用
      const bytes = (byte << 8) | array[++i]
      const distance = (bytes & 16383) >>> 3
      const length = (bytes & 7) + 3
      for (let j = 0; j < length; j++) output.push(output[output.length - distance])
    } else {
      output.push(32, byte ^ 128) // 空格 + 异或字面量
    }
  }
  return Uint8Array.from(output)
}

/**
 * 修正版 initMobiFile：自动处理 KF8/hybrid 书与压缩标志错误。
 * 用法与 initMobiFile 一致（传 File / Uint8Array）。
 *
 * hybrid 书（含 KF8 部分）的 record0 是旧版 MOBI 头，无法通过预检测判定；
 * 直接先按 KF8 尝试解析（KF8 主记录有 FDST 结构），失败再回落旧版路径。
 */
export async function initMobiFixed(file) {
  try {
    const kf8 = await initKf8File(file)
    if (kf8.getSpine().length > 0) return kf8 // 确为 KF8/hybrid 书
    kf8.destroy()
  } catch {
    // 旧版 MOBI 无 FDST 结构，走下方路径
  }

  const mobi = await initMobiFile(file)
  const mf = mobi.mobiFile
  const compression = mf.palmdocHeader?.compression
  if (compression === 1) {
    // 库误将压缩书当无压缩：补上真正的 PalmDOC 解压
    mf.decompress = palmDocDecompress
  } else if (compression === 2) {
    // 库误将无压缩书当 PalmDOC 压缩流解析（正文会损坏截断）：改回原样
    mf.decompress = (f) => f
  }
  if (compression === 1 || compression === 2) {
    // 用修正后的解压重新解析章节（initMobiFile 内部已跑过一次错误的 innerInit）
    await mobi.innerInit()
  }
  return mobi
}
