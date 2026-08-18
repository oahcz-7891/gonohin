// 文本工具：TXT 编码检测（日语 TXT 大量为 Shift_JIS）

/**
 * 解码 TXT Blob：先按 UTF-8 解，出现异常替换符 � 且占比超标时回退 Shift_JIS。
 * 浏览器 TextDecoder 原生支持 shift_jis，无需引入编码库。
 */
export async function decodeTxt(blob) {
  const buf = await blob.arrayBuffer()
  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/�/g) || []).length
  if (bad > 0 && bad / Math.max(utf8.length, 1) > 0.002) {
    return new TextDecoder('shift_jis').decode(buf)
  }
  return utf8
}
