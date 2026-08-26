// 设置页：API Key 配置（apiKey / baseURL / model + 提供商预设 + 测试连接）
// 数据只存浏览器 localStorage，直连 OpenAI 兼容 API，不经任何服务器

import { useState } from 'react'
import { getSettings, setSettings } from '../lib/storage'
import { API_PRESETS } from '../lib/constants'
import { normalizeBaseURL } from '../lib/translate'
import { getThinkingOptions, getThinkingHint, getProviderLabel } from '../lib/thinking'
import { applyTheme } from '../lib/theme'

export default function Settings({ onBack }) {
  const [form, setForm] = useState(() => getSettings())
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, message }
  const [saved, setSaved] = useState(false)

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
        <h1 className="topbar-title">设置</h1>
        <button className="btn btn-ghost" onClick={onBack}>
          ← 返回
        </button>
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
          <option value="system">跟随系统</option>
          <option value="light">浅色（羊皮纸）</option>
          <option value="dark">深色</option>
        </select>
        <div className="settings-hint">深色模式适合夜间阅读</div>
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
