import React, { useState, useEffect } from 'react'
import { Card, Input, Button, message, Space, Typography, Tag, Divider } from 'antd'
import { SaveOutlined, CheckCircleOutlined } from '@ant-design/icons'

const { Text, Link } = Typography

const PRESETS = [
  {
    name: 'OpenAI',
    url: 'https://api.openai.com',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    placeholder: 'sk-...',
    doc: 'https://platform.openai.com/docs',
  },
  {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-coder'],
    placeholder: 'sk-...',
    doc: 'https://platform.deepseek.com/api-docs',
  },
  {
    name: 'Claude (Anthropic)',
    url: 'https://api.anthropic.com',
    models: ['claude-3-haiku-20240307', 'claude-3-sonnet-20240229'],
    placeholder: 'sk-ant-...',
    doc: 'https://docs.anthropic.com',
    note: '需要 /v1/messages 格式，暂不支持',
  },
  {
    name: '自定义 / 中转站',
    url: '',
    models: [],
    placeholder: '填入你的 API 地址',
    doc: '',
  },
]

const STORAGE_KEY = 'stata_assistant_ai_config'

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch { return {} }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export default function Settings() {
  const [config, setConfig] = useState({ api_url: '', api_key: '', model: '', preset: '' })

  useEffect(() => {
    const saved = loadConfig()
    if (saved.api_url) setConfig(saved)
  }, [])

  const handleSave = () => {
    if (!config.api_url || !config.api_key) {
      message.warning('请填写 API 地址和密钥')
      return
    }
    saveConfig(config)
    message.success('设置已保存')
  }

  const handlePreset = (preset) => {
    setConfig(c => ({
      ...c,
      api_url: preset.url,
      preset: preset.name,
      model: preset.models[0] || '',
    }))
  }

  return (
    <div style={{ padding: 32, maxWidth: 700 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: '#1e293b', marginBottom: 8 }}>
        AI 助手设置
      </h2>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>
        配置你自己的大模型 API，即可使用 AI 助手功能。密钥仅保存在浏览器本地，不会上传到任何服务器。
      </p>

      <Card title="快速选择" size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          {PRESETS.map(p => (
            <Button key={p.name}
              type={config.preset === p.name ? 'primary' : 'default'}
              onClick={() => handlePreset(p)}
            >
              {p.name}
            </Button>
          ))}
        </Space>
      </Card>

      <Card title="API 配置" size="small" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>API 地址</div>
          <Input
            value={config.api_url}
            onChange={e => setConfig(c => ({ ...c, api_url: e.target.value }))}
            placeholder="https://api.openai.com"
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            填写 API 基础地址，如 https://api.openai.com 或中转站地址
          </Text>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>API Key</div>
          <Input.Password
            value={config.api_key}
            onChange={e => setConfig(c => ({ ...c, api_key: e.target.value }))}
            placeholder={PRESETS.find(p => p.name === config.preset)?.placeholder || 'sk-...'}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>模型名称</div>
          <Input
            value={config.model}
            onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
            placeholder="gpt-4o-mini"
            list="model-list"
          />
          <datalist id="model-list">
            {(PRESETS.find(p => p.name === config.preset)?.models || []).map(m => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {PRESETS.find(p => p.name === config.preset)?.note && (
            <Text type="warning" style={{ fontSize: 11 }}>
              ⚠️ {PRESETS.find(p => p.name === config.preset)?.note}
            </Text>
          )}
        </div>

        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} size="large">
          保存设置
        </Button>
      </Card>

      <Card size="small" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
        <Space>
          <CheckCircleOutlined style={{ color: '#16a34a' }} />
          <Text style={{ fontSize: 12 }}>
            你的密钥仅存储在浏览器本地 (localStorage)，不会发送到我们的服务器。
            所有 AI 请求由浏览器直接发往你配置的 API 地址。
          </Text>
        </Space>
      </Card>
    </div>
  )
}
