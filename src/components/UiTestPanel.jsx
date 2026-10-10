// 翻页诊断面板：只看事实，不做美化。目标是「手机截一张图就能定位原因」。
// 收起时只占状态栏那一条（本来就是死区，不占翻页热区），展开后 60vh 可滚动。

import { useState, useSyncExternalStore } from 'react'
import {
  STRATEGIES,
  VERDICT_LABEL,
  clearRecords,
  envInfo,
  getFlags,
  getRecords,
  resetFlags,
  safeTopPx,
  setFlag,
  subscribe,
  summarize,
  verdict,
} from '../lib/uitest'
import '../styles/uitest.css'

function useFlags() {
  return useSyncExternalStore(subscribe, getFlags)
}

const VERDICT_CLASS = {
  turned: 'ok',
  miss: 'warn',
  overlay: 'bad',
  cancel: 'bad',
  noEnd: 'bad',
  noScroll: 'bad',
  moved: 'warn',
  longpress: 'warn',
  clickOnly: 'warn',
  unknown: 'idle',
}

export default function UiTestPanel({ format }) {
  const flags = useFlags()
  const records = useSyncExternalStore(subscribe, getRecords)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const sum = summarize(records)
  const env = envInfo()
  const top = safeTopPx()

  if (!flags.debug) return null

  const copy = async () => {
    const text = [
      `环境: ${env.runtime} · ${env.mode} · ${env.viewport} · safeTop ${env.safeTop} · touch ${env.touch} · scrollend ${env.scrollend} · 格式 ${format || '?'}`,
      `开关: ${STRATEGIES.filter((s) => flags[s.key]).map((s) => s.key).join(',') || '（全关）'}`,
      `结论: 共 ${sum.total} 次，成功 ${sum.turned}，失败 ${sum.failed}｜${sum.advice}`,
      ...records.map(
        (r) =>
          `#${r.n} ${VERDICT_LABEL[verdict(r)]} 页${r.page0}→${r.page1} 位移${r.moved} ${r.dur}ms [${r.ev.join(' ')}] 落点${r.hit}${r.inZone ? ' 热区' : ''}${r.overlay0 || r.overlay1 ? ' 有浮层' : ''}`,
      ),
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 没权限就靠截图 */
    }
  }

  return (
    <div className={`ut ${open ? 'ut-open' : ''}`}>
      <button className="ut-bar" onClick={() => setOpen((v) => !v)}>
        <b>翻页诊断</b>
        <span className="ut-count">
          ✅{sum.turned}/{sum.total}
        </span>
        <span className="ut-advice">{sum.advice}</span>
        <span className="ut-caret">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="ut-body">
          <div className="ut-env">
            {format} · {env.runtime} · {env.mode} · {env.viewport} · touch {env.touch} · scrollend{' '}
            {env.scrollend}
          </div>

          {/* 两个高度互不相干，都用滑条在真机上定：
              蓝帽 = 蓝色铺到哪；工具行 = 距屏幕顶部多远（要越过 iOS 材质区 ≈90px 才不糊） */}
          <div className="ut-knob">
            <div className="ut-knob-head">
              <b>蓝帽高度</b>
              <span>
                <b>{flags.capH ?? 0}px</b>
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={160}
              step={2}
              value={flags.capH ?? 0}
              onChange={(e) => setFlag('capH', Number(e.target.value))}
            />
            <div className="ut-knob-scale">
              <span>0（不画蓝）</span>
              <span>40（你画的那条线）</span>
              <span>160（整条蓝）</span>
            </div>
          </div>

          <div className="ut-knob">
            <div className="ut-knob-head">
              <b>工具行下移</b>
              <span>
                ×{(flags.topScale ?? 1).toFixed(2)} → 让位 <b>{top?.pad ?? '—'}px</b>（顶栏总高{' '}
                {top?.total ?? '—'}px）
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={3}
              step={0.02}
              value={flags.topScale ?? 1}
              onChange={(e) => setFlag('topScale', Number(e.target.value))}
            />
            <div className="ut-knob-scale">
              <span>×1（材质区，发糊）</span>
              <span>×1.45 ≈ 86px（默认）</span>
              <span>×3 最厚</span>
            </div>
          </div>

          <div className="ut-row ut-actions">
            <button onClick={copy}>{copied ? '已复制' : '复制日志'}</button>
            <button onClick={clearRecords}>清空计数</button>
            <button onClick={resetFlags}>重置开关</button>
          </div>

          <div className="ut-legend">
            {Object.entries(sum.counts).map(([k, v]) => (
              <span key={k} className={`ut-chip ${VERDICT_CLASS[k]}`}>
                {VERDICT_LABEL[k]} {v}
              </span>
            ))}
            {!sum.total && <span className="ut-chip idle">还没有记录，去点几次翻页</span>}
          </div>

          <div className="ut-list">
            {records.slice(0, 12).map((r) => {
              const v = verdict(r)
              return (
                <div key={r.n} className={`ut-rec ${VERDICT_CLASS[v]}`}>
                  <div className="ut-rec-1">
                    <b>#{r.n}</b> <span className="ut-v">{VERDICT_LABEL[v]}</span>
                    <span className="ut-sep">页</span>
                    {r.page0}
                    <span className="ut-sep">→</span>
                    {r.page1 ?? '?'}
                    <span className="ut-sep">位移</span>
                    {r.moved}
                    <span className="ut-sep">{r.dur}ms</span>
                  </div>
                  <div className="ut-rec-2">
                    [{r.ev.join(' ') || '无事件'}] {r.hit}
                    {r.inZone ? ' · 热区' : ''}
                    {r.overlay0 || r.overlay1 ? ' · 有浮层' : ''}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="ut-switches">
            <div className="ut-switch-title">候选修复（逐个单独试，看上面哪一条让失败消失）</div>
            {STRATEGIES.map((s) => (
              <label key={s.key} className="ut-switch">
                <input type="checkbox" checked={!!flags[s.key]} onChange={(e) => setFlag(s.key, e.target.checked)} />
                <span>
                  <b>{s.label}</b>
                  <i>{s.hint}</i>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
