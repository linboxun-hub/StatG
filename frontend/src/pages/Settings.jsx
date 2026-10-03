import React, { useState, useEffect } from 'react'
import { Card, Input, Button, message, Space, Typography, Tag, Divider, Alert } from 'antd'
import {
  SaveOutlined, CheckCircleOutlined, ReloadOutlined, DownloadOutlined,
  ThunderboltFilled, GithubOutlined,
} from '@ant-design/icons'
import { updateAPI, updateStore, formatBytes } from '../api/update'
import { useUpdate } from '../hooks/useUpdate'

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

// ── 版本与更新：单独拆成组件，设置页只负责摆放 ──
function UpdateCard() {
  const st = useUpdate()
  const [repoDraft, setRepoDraft] = useState('')

  useEffect(() => {
    updateAPI.loadInfo().then((info) => { if (info) setRepoDraft(info.repo || '') })
    const off = updateAPI.onAvailable(() => message.info('发现有新版本，去「版本与更新」看看'))
  }, [])

  const info = st.info || {}
  const r = st.result
  const checking = st.checking
  const busy = checking || st.downloading

  const handleCheck = async () => {
    const res = await updateAPI.check()
    if (res.ok && !res.hasUpdate) message.success(`已经是最新版本 v${res.current}`)
    if (res.ok && res.hasUpdate) message.info(`发现新版本 v${res.latest}`)
  }

  const handleDownloadInstall = async () => {
    if (!r || !r.assetUrl) {
      message.warning('这个 Release 里没挂安装包，点「去下载页」手动下')
      return
    }
    try {
      const res = await updateAPI.download(r.assetUrl, `StatG-Setup-${r.latest}.exe`)
      message.success(`下载完成：${res.path}`)
    } catch (e) {
      message.error('下载失败：' + e.message)
    }
  }

  const openUrl = (url) => {
    if (!url) return
    // 桌面版里 electron 会拦 window.open，所以交给主进程用系统浏览器开
    if (window.statgApp) {
      // 通过 file:// 不行，这里借 setWindowOpenHandler：直接 fetch 一个跳转请求
      window.open(url, '_blank')
    } else {
      window.open(url, '_blank')
    }
  }

  return (
    <Card
      title={<Space><ThunderboltFilled style={{ color: '#7c3aed' }} />版本与更新</Space>}
      size="small"
      style={{ marginBottom: 16 }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Tag color="geekblue" style={{ fontSize: 13, padding: '2px 10px' }}>
            当前版本 {info.version ? `v${info.version}` : '开发版'}{info.arch ? ` · ${info.arch}` : ''}
          </Tag>
          {r && r.ok && r.hasUpdate && <Tag color="magenta">有新版本 v{r.latest}</Tag>}
          {r && r.ok && !r.hasUpdate && <Tag color="green">已是最新</Tag>}
        </Space>

        {!updateAPI.isDesktop && (
          <Alert type="info" showIcon
            message="现在跑的是网页开发版"
            description="检查更新只对打包好的桌面版有效——它需要读程序版本、下载安装包。" />
        )}

        <div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
            GitHub 仓库（用于检查更新）
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={repoDraft}
              onChange={(e) => setRepoDraft(e.target.value)}
              placeholder="用户名/仓库名，例如 octocat/StatG"
              disabled={busy}
            />
            <Button
              disabled={busy}
              onClick={async () => {
                if (!updateAPI.isDesktop) { message.warning('只有桌面版能保存仓库'); return }
                await updateAPI.setRepo(repoDraft)
                message.success('已保存，点「检查更新」试试')
              }}
            >
              保存
            </Button>
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 11 }}>
            填你发布 Release 的那个仓库。程序会读它的最新 Release 来比版本号。
          </Text>
        </div>

        <Space wrap>
          <Button type="primary" icon={<ReloadOutlined />} loading={checking} onClick={handleCheck}>
            检查更新
          </Button>
          {r && r.ok && r.hasUpdate && r.url && (
            <Button icon={<GithubOutlined />} onClick={() => openUrl(r.url)}>去下载页</Button>
          )}
        </Space>

        {r && !r.ok && <Alert type="warning" showIcon message={r.message || '检查失败'} />}

        {r && r.ok && r.hasUpdate && (
          <Alert
            type="info"
            showIcon
            message={`发现新版本 v${r.latest}（当前 v${r.current}）`}
            description={
              <Space direction="vertical" size={8}>
                {r.assetName && (
                  <Text style={{ fontSize: 12 }}>
                    安装包：{r.assetName}{r.assetSize ? `（${formatBytes(r.assetSize)}）` : ''}
                  </Text>
                )}
                {r.notes && (
                  <pre style={{
                    margin: 0, padding: 10, maxHeight: 180, overflow: 'auto',
                    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6,
                    fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {r.notes}
                  </pre>
                )}
                {st.downloading && st.progress && (
                  <Text style={{ fontSize: 12 }}>
                    下载中 {st.progress.percent != null ? `${st.progress.percent}%` :
                      `${formatBytes(st.progress.received)}`}
                  </Text>
                )}
                <Space>
                  <Button
                    type="primary"
                    danger
                    icon={<DownloadOutlined />}
                    loading={st.downloading}
                    onClick={handleDownloadInstall}
                  >
                    {st.downloading ? '正在下载…' : '下载并安装'}
                  </Button>
                  {st.downloaded && (
                    <Button loading={st.downloading}
                      onClick={async () => {
                        try {
                          await updateAPI.install(st.downloaded)
                        } catch (e) { message.error(e.message) }
                      }}>
                      立即安装（会关闭程序）
                    </Button>
                  )}
                </Space>
                {st.downloaded && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    已下载到：{st.downloaded}。也可以自己去双击这个文件装。
                  </Text>
                )}
              </Space>
            }
          />
        )}

        <Text type="secondary" style={{ fontSize: 11 }}>
          更新检查走 GitHub 官方接口，程序不会自动下载、也不会偷偷升级——
          点「下载并安装」才会把安装包拉到你的「下载」文件夹，装不装你定。
        </Text>
      </Space>
    </Card>
  )
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

      <UpdateCard />

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
