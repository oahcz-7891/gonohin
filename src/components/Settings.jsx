// 设置页：API Key 配置（apiKey / baseURL / model + 提供商预设 + 测试连接）
// 数据只存浏览器 localStorage，直连 OpenAI 兼容 API，不经任何服务器

import { useState, useSyncExternalStore } from 'react'
import { getSettings, setSettings } from '../lib/storage'
import { API_PRESETS } from '../lib/constants'
import { normalizeBaseURL } from '../lib/translate'
import { getThinkingOptions, getThinkingHint, getProviderLabel } from '../lib/thinking'
import { applyTheme } from '../lib/theme'
import { getFlags, setFlag, subscribe } from '../lib/uitest'

export default function Settings({ onBack }) {
  const [form, setForm] = useState(() => getSettings())
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, message }
  const [saved, setSaved] = useState(false)
  const uiFlags = useSyncExternalStore(subscribe, getFlags)

  const set = (key) => (e) => {
    const value = e.target.value
    setForm((f) => ({ ...f, [key]: value }))
    if (key === 'theme') {
      setSettings({ theme: value })
      applyTheme(value)
    }
  }

  // 思考强度按当前 baseURL 识别的供应商展示对应档位
  const thinkingOptions = (key) => getThinkingOptions(form.baseURL, form[key])

  // 清空指定文本字段（模型 / API Key 输入框的 ✕ 按钮）
  const clearField = (key) => () => setForm((f) => ({ ...f, [key]: '' }))

  const applyPreset = (e) => {
    const preset = API_PRESETS.find((p) => p.name === e.target.value)
    if (preset) setForm((f) => ({ ...f, baseURL: preset.baseURL, model: preset.model }))
  }

  const save = () => {
    setSettings({ ...form, apiKey: form.apiKey.trim(), baseURL: form.baseURL.trim() })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const testConnection = async () => {
    if (!form.apiKey) {
      setTestResult({ ok: false, message: '请先填写 API Key' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${normalizeBaseURL(form.baseURL)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${form.apiKey}`,
        },
        body: JSON.stringify({
          model: form.model,
          stream: false,
          max_tokens: 1,
          messages: [{ role: 'user', content: '连接测试' }],
        }),
      })
      if (res.ok) {
        setTestResult({ ok: true, message: '连接成功，API Key 有效 ✓' })
      } else {
        const err = await res.json().catch(() => null)
        setTestResult({ ok: false, message: `连接失败：${err?.error?.message || `HTTP ${res.status}`}` })
      }
    } catch (e) {
      setTestResult({ ok: false, message: `网络错误：${e.message}（浏览器直连被 CORS 拦截时也会报这个错）` })
    }
    setTesting(false)
  }

  return (
    <div className="settings-page">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="icon-btn" onClick={onBack} title="返回书架" aria-label="返回书架">
            ‹
          </button>
          <h1 className="topbar-title">设置</h1>
        </div>
      </header>

      <div className="settings-body">
      <div className="settings-group">
        <label htmlFor="preset">服务商预设</label>
        <select id="preset" onChange={applyPreset} defaultValue="">
          <option value="" disabled>
            选择预设后自动填充…
          </option>
          {API_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="settings-hint">支持所有 OpenAI 兼容接口：DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI 等</div>
      </div>

      <div className="settings-group">
        <label htmlFor="baseURL">API 地址（Base URL）</label>
        <input id="baseURL" type="text" placeholder="https://api.deepseek.com" value={form.baseURL} onChange={set('baseURL')} spellCheck={false} />
      </div>

      <div className="settings-group">
        <label htmlFor="model">模型</label>
        <div className="input-clear">
          <input id="model" type="text" placeholder="deepseek-chat" value={form.model} onChange={set('model')} spellCheck={false} />
          {form.model && (
            <button className="input-clear-btn" aria-label="清除模型" onClick={clearField('model')}>✕</button>
          )}
        </div>
      </div>

      <div className="settings-group">
        <label>
          思考强度 · <span style={{ color: 'var(--primary)' }}>{getProviderLabel(form.baseURL)}</span>
        </label>
        <div className="thinking-field">
          <label htmlFor="thinkingNormal">普通翻译</label>
          <select id="thinkingNormal" value={form.thinkingNormal} onChange={set('thinkingNormal')}>
            {thinkingOptions('thinkingNormal').map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="thinking-field">
          <label htmlFor="thinkingDeep">深度翻译</label>
          <select id="thinkingDeep" value={form.thinkingDeep} onChange={set('thinkingDeep')}>
            {thinkingOptions('thinkingDeep').map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-hint">{getThinkingHint(form.baseURL)}</div>
      </div>

      <div className="settings-group">
        <label htmlFor="apiKey">API Key</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="input-clear" style={{ flex: 1 }}>
            <input
              id="apiKey"
              type={showKey ? 'text' : 'password'}
              placeholder="sk-…"
              value={form.apiKey}
              onChange={set('apiKey')}
              autoComplete="off"
            />
            {form.apiKey && (
              <button className="input-clear-btn" aria-label="清除 API Key" onClick={clearField('apiKey')}>✕</button>
            )}
          </div>
          <button className="btn" onClick={() => setShowKey((v) => !v)}>
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="settings-hint">
          密钥只保存在本机浏览器（localStorage），由浏览器直连 API，不经过任何服务器。清除浏览器数据会丢失，请自行保管。
        </div>
      </div>

      <div className="settings-group">
        <label htmlFor="theme">外观</label>
        <select id="theme" value={form.theme} onChange={set('theme')}>
          <option value="dark">深色（藍）</option>
          <option value="light">浅色（纸白）</option>
          <option value="system">跟随系统</option>
        </select>
        <div className="settings-hint">深色是主调色板，长时间阅读更省眼</div>
      </div>

      <div className="settings-group">
        <label>UI 诊断 · 翻页日志</label>
        <label className="settings-toggle">
          <input type="checkbox" checked={!!uiFlags.debug} onChange={(e) => setFlag('debug', e.target.checked)} />
          <span>在阅读页底部显示翻页诊断面板</span>
        </label>
        <div className="settings-hint">
          只在排查「手机上翻页时灵时不灵」时打开。打开后进任意书籍，底部出现诊断条，展开可以看到每一次触摸的
          落点元素、派发了哪些事件、翻页后页码有没有变。
        </div>
      </div>

      <div className="settings-group">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={testConnection} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn btn-primary" onClick={save}>
            {saved ? '已保存 ✓' : '保存'}
          </button>
        </div>
        {testResult && <div className={`settings-test-result ${testResult.ok ? 'ok' : 'fail'}`}>{testResult.message}</div>}
      </div>
      </div>
    </div>
  )
}
