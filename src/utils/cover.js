// 封面占位色：按书名哈希取一个色相，让同类占位（无封面的书）也有层次而不同色

// 冷调为主（暖色留给金色重音）
const HUES = [210, 232, 264, 288, 340, 20, 40]

export function hashHue(s = '') {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}
