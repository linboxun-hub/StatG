import React, { useState, useRef, useEffect } from 'react'
import { Input, Button, message, Drawer, Typography, FloatButton, Tag } from 'antd'
import { SendOutlined, RobotOutlined, UserOutlined, CloseOutlined } from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { aiAPI, kbAPI } from '../api'
import DraggableFab from './DraggableFab'

const STORAGE_KEY = 'stata_assistant_ai_config'

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}

const PAGE_CONTEXT = {
  '/home': '当前在工作台主页，用户可以查看项目概览和快速入口。',
  '/data': '当前在数据管理页面，用户可以导入/查看数据集，包含数据视图、变量视图、数据摘要。可帮助用户解释变量含义、数据质量、缺失值处理等。',
  '/editor': '当前在数据清洗页面，用户可以导入数据、选择清洗方式、执行清洗操作。可帮助用户处理异常值、缺失值、重复值、变量转换等。',
  '/analysis': '当前在统计分析页面，用户可以运行描述统计、回归分析、假设检验，也能在「描述图形」页签画折线/柱状/散点/直方图等。可帮助用户解读回归结果、推荐模型、解释系数含义。',
  '/heterogeneity': '当前在异质性分析页面，展示分组回归的系数与置信区间（异质性系数图）。可帮助用户选择分组维度、解读组间差异、补充组间系数差异检验。',
  '/mechanism': '当前在机制检验页面。可运行中介效应（三步法：总效应/路径a/直接效应/路径b + Sobel + Bootstrap）或调节效应（交互项 X·M + 简单斜率）。可帮用户选 Y/X/M、解读中介与调节结果、判断机制是否成立。',
  '/output': '当前在结果输出页面，用户可以管理导出的分析结果文件。',
  '/help': '当前在帮助文档页面，包含Stata命令速查和实证案例教程。',
  '/resources': '当前在资源管理页面，包含知识库（多个库 × 文献笔记/方法卡片/概念）和数据库（数据集）。可帮用户决定一篇文献该沉淀成什么、该进哪个库、数据集怎么处理。',
  '/settings': '当前在AI设置页面，用户可以配置自己的API密钥。',
}

export default function GlobalAIChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '你好！我是你的数据分析助手。我可以帮你：\n• 解读回归结果\n• 推荐分析方法\n• 解释统计概念\n• 处理数据清洗问题\n• 优化模型设定\n\n请描述你的问题。',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [kbHits, setKbHits] = useState(null)
  const messagesEndRef = useRef(null)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || loading) return

    const config = loadConfig()
    if (!config.api_url || !config.api_key) {
      message.warning('请先在设置中配置 AI API')
      navigate('/settings')
      return
    }

    const pageContext = PAGE_CONTEXT[location.pathname] || ''
    const userMsg = { role: 'user', content: input.trim() }
    // 人设和回答原则由后端 ai_service._ROLE 统一给；这里只带页面上下文，
    // 不再重复一份、也不再声称「基于连享会知识体系」——那个说法名不副实。
    const systemMsg = {
      role: 'system',
      content: pageContext
        ? `当前所在页面：${pageContext}`
        : '当前没有页面上下文。',
    }

    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    // 先查知识库。命中就把库内笔记拼进上下文，并强制 AI 标注来源；
    // 没命中也要明确告诉它「库里没有」，不许拿记忆冒充库里的内容。
    let ctx = { found: false, text: '', ids: [] }
    try {
      const r = await kbAPI.search(input.trim(), 5)
      if (r.data && r.data.hits && r.data.hits.length) {
        const parts = r.data.hits.map(h =>
          `### [${h.type_label}] ${h.title}\n`
          + `来源：${h.source_ref || '未标注'}  已核对：${h.verified ? '是' : '否'}\n`
          + (h.excerpt || ''))
        ctx = { found: true, text: parts.join('\n\n'), ids: r.data.hits.map(h => h.title) }
      }
    } catch (e) { /* 库不可用时照常聊天，只是不带库内容 */ }
    setKbHits(ctx.found ? ctx.ids : null)

    const kbMsg = ctx.found
      ? `【知识库检索结果】以下是本地笔记库里与问题相关的条目，优先依据它们回答：\n\n${ctx.text}\n\n`
        + `硬规则：\n1. 使用了上面哪几条，就在回答末尾列出来源标题。\n`
        + `2. 上面没有的信息，说明「知识库里没有，以下是通用知识」，不许把记忆伪装成库内内容。\n`
        + `3. 标注为「已核对：否」的条目，提醒用户这条笔记尚未人工验证。`
      : `【知识库检索结果】本地笔记库里没有与这个问题相关的条目。\n`
        + `硬规则：直接说明知识库中没有相关内容，然后基于通用计量知识回答，`
        + `并在开头明确标注这是通用知识、不是来自用户的知识库。`

    const apiMessages = [
      { role: 'system', content: kbMsg },
      systemMsg, ...newMessages.map(m => ({ role: m.role, content: m.content })),
    ]

    try {
      const res = await aiAPI.chat(apiMessages, config, location.pathname)
      if (res.data.error) {
        setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${res.data.error}` }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: res.data.content }])
      }
    } catch (e) {
      message.error('请求失败')
    }
    setLoading(false)
  }

  const quickQuestions = {
    '/home': ['帮我了解一下这个工具的功能', '推荐一个实证研究的入门路径'],
    '/data': ['当前数据集有哪些变量？', '如何处理缺失值？'],
    '/editor': ['如何处理异常值？', '帮我生成数据清洗代码'],
    '/analysis': ['推荐合适的回归方法', '帮我解释回归结果的含义'],
    '/heterogeneity': ['什么是异质性分析？', '异质性系数图怎么看？', '组间差异显著如何检验？'],
    '/help': ['面板数据该用固定效应还是随机效应？', 'DID的平行趋势怎么检验？'],
    '/resources': ['这篇文献该沉淀成什么？', '数据体检发现了什么问题？'],
  }

  const currentQuestions = quickQuestions[location.pathname] || ['帮我解释一下回归结果', '推荐分析方法']

  return (
    <>
      {/* 悬浮按钮：可拖动，位置记在 localStorage 里 */}
      <DraggableFab
        icon={<RobotOutlined />}
        onClick={() => setOpen(true)}
        tip="AI 分析助手（按住可拖动）"
      />

      {/* AI 对话抽屉 */}
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RobotOutlined style={{ color: '#6366f1', fontSize: 18 }} />
            <span>AI 分析助手</span>
            <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400 }}>你的知识库</span>
          </div>
        }
        placement="right"
        width={420}
        open={open}
        onClose={() => setOpen(false)}
        closable={false}
        styles={{ body: { display: 'flex', flexDirection: 'column', padding: '12px 16px', height: 'calc(100vh - 55px)' } }}
      >
        {/* 对话区 */}
        <div style={{ flex: 1, overflow: 'auto', marginBottom: 12 }}>
          {kbHits && kbHits.length > 0 && (
            <div style={{ marginBottom: 10, padding: '6px 10px', background: '#f0fdf4',
                          border: '1px solid #bbf7d0', borderRadius: 8, fontSize: 11, color: '#166534' }}>
              已检索知识库，本轮回答依据：
              {kbHits.map((t, i) => <Tag key={i} color="green" style={{ marginLeft: 4, fontSize: 11 }}>{t}</Tag>)}
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex', gap: 8, marginBottom: 12,
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                background: msg.role === 'user' ? '#6366f1' : '#e0e7ff',
                color: msg.role === 'user' ? '#fff' : '#6366f1',
              }}>
                {msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
              </div>
              <div style={{
                maxWidth: '82%', padding: '10px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.6,
                background: msg.role === 'user' ? '#6366f1' : '#f1f5f9',
                color: msg.role === 'user' ? '#fff' : '#334155',
                whiteSpace: 'pre-wrap',
              }}>
                {msg.content}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* 快捷问题 */}
        {messages.length <= 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {currentQuestions.map((q, i) => (
              <Button key={i} size="small" type="text" style={{ fontSize: 11, color: '#6366f1', border: '1px solid #e0e7ff' }}
                onClick={() => setInput(q)}>
                {q}
              </Button>
            ))}
          </div>
        )}

        {/* 输入区 */}
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            onPressEnter={handleSend}
            placeholder="输入你的问题..."
            disabled={loading}
            style={{ flex: 1 }}
          />
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} loading={loading} />
        </div>
      </Drawer>
    </>
  )
}
