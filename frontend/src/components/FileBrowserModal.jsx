import React, { useState, useEffect } from 'react'
import { Modal, List, Button, Input, Space, Breadcrumb, Spin, message, Empty } from 'antd'
import { FolderOutlined, FolderOpenOutlined, HomeOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import { browseAPI } from '../api'

export default function FileBrowserModal({ open, onOk, onCancel }) {
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState([])

  useEffect(() => {
    if (open) {
      // 起始目录由后端决定：Windows 是 D:\，容器里是挂载点。
      // 传空路径让 /api/browse 用它的默认值，返回的 path 才是真实根。
      setCurrentPath('')
      setHistory([])
      loadDir('')
    }
  }, [open])

  const loadDir = async (path) => {
    setLoading(true)
    try {
      const res = await browseAPI.list(path)
      setCurrentPath(res.data.path || path)
      setEntries(res.data.entries || [])
      setHistory(prev => {
        const idx = prev.indexOf(res.data.path || path)
        if (idx >= 0) return prev.slice(0, idx + 1)
        return [...prev, res.data.path || path]
      })
    } catch (e) {
      message.error('读取目录失败')
    }
    setLoading(false)
  }

  const handleClickEntry = (entry) => {
    loadDir(entry.path)
  }

  const handleGoBack = () => {
    if (history.length > 1) {
      const parent = history[history.length - 2]
      setCurrentPath(parent)
      loadDir(parent)
    }
  }

  return (
    <Modal
      title="选择文件夹"
      open={open}
      onCancel={onCancel}
      width={600}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={handleGoBack} disabled={history.length <= 1}>
            <ArrowLeftOutlined /> 返回上级
          </Button>
          <Space>
            <Button onClick={onCancel}>取消</Button>
            <Button type="primary" onClick={() => onOk(currentPath)}>
              选择此文件夹: {currentPath}
            </Button>
          </Space>
        </div>
      }
    >
      {/* 当前路径 */}
      <div style={{
        padding: '8px 12px', background: '#f8fafc', borderRadius: 6, marginBottom: 12,
        fontFamily: 'monospace', fontSize: 12, color: '#475569',
      }}>
        📁 {currentPath}
      </div>

      {/* 目录列表 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : entries.length === 0 ? (
        <Empty description="此文件夹为空（或无子目录）" />
      ) : (
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {entries.map(entry => (
            <div
              key={entry.path}
              onClick={() => handleClickEntry(entry)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', cursor: 'pointer', borderRadius: 6,
                transition: 'background 0.15s',
                border: '1px solid transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f1f5f9'; e.currentTarget.style.borderColor = '#e2e8f0' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
            >
              <FolderOutlined style={{ color: '#f59e0b', fontSize: 16 }} />
              <span style={{ fontSize: 13 }}>{entry.name}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
