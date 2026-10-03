import React, { useState, useRef, useEffect } from 'react'
import { Input, Button, message, Typography } from 'antd'
import { SendOutlined, RobotOutlined, UserOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { aiAPI } from '../api'

const { Text } = Typography
const STORAGE_KEY = 'stata_assistant_ai_config'

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}

export default function AIChat({ contextInfo = '' }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: '你好！我是你的数据分析助手。我可以帮你：\n- 解读回归结果\n- 推荐分析方法\n- 解释统计概念\n- 优化模型设定\n\n请描述你的问题。',
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef(null)
  const navigate = useNavigate()

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

    const userMsg = { role: 'user', content: input.trim() }
    const systemMsg = {
      role: 'system',
      content: `你是一个专业的计量经济学和实证研究助手。你帮助用户理解数据分析、模型选择和结果解读。\n\n当前数据信息：\n${contextInfo}\n\n请用中文回答，简洁专业。`,
    }

    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    const apiMessages = [systemMsg, ...newMessages.map(m => ({ role: m.role, content: m.content }))]

    try {
      const res = await aiAPI.chat(apiMessages, config)
      if (res.data.error) {
        message.error(res.data.error)
        setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${res.data.error}` }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: res.data.content }])
      }
    } catch (e) {
      message.error('请求失败')
    }
    setLoading(false)
  }

  const quickQuestions = [
    '帮我解释一下当前数据的结构',
    '推荐合适的分析方法',
    '如何处理缺失值？',
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
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
              maxWidth: '80%', padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.6,
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

      {/* Quick questions */}
      {messages.length <= 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {quickQuestions.map((q, i) => (
            <Button key={i} size="small" type="text" style={{ fontSize: 11, color: '#6366f1' }}
              onClick={() => { setInput(q) }}>
              {q}
            </Button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Input
          value={input}
          onChange={e => setInput(e.target.value)}
          onPressEnter={handleSend}
          placeholder="输入你的问题..."
          disabled={loading}
          style={{ flex: 1 }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleSend}
          loading={loading}
        />
      </div>
    </div>
  )
}
