import React, { useState, useEffect } from 'react'
import { Card, Row, Col, Table, Button, Statistic, Tag, Space, Popconfirm, message, Empty } from 'antd'
import { DownloadOutlined, DeleteOutlined, FileTextOutlined, FilePdfOutlined, FileExcelOutlined, CodeOutlined } from '@ant-design/icons'
import { exportAPI } from '../api'

const formatIcons = {
  word: <FileTextOutlined style={{ color: '#2563eb' }} />,
  pdf: <FilePdfOutlined style={{ color: '#e11d48' }} />,
  excel: <FileExcelOutlined style={{ color: '#16a34a' }} />,
  latex: <CodeOutlined style={{ color: '#475569' }} />,
}

const formatLabels = { word: 'Word', pdf: 'PDF', excel: 'Excel', latex: 'LaTeX' }

export default function Output() {
  const [exports, setExports] = useState([])

  const fetchData = () => {
    exportAPI.list().then(r => setExports(r.data.exports || [])).catch(() => {})
  }

  useEffect(() => { fetchData() }, [])

  const handleDelete = async (id) => {
    await exportAPI.delete(id)
    message.success('已删除')
    fetchData()
  }

  const handleDownload = (item) => {
    const blob = new Blob([item.content || ''], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = item.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const wordCount = exports.filter(e => e.format === 'word').length
  const pdfCount = exports.filter(e => e.format === 'pdf').length
  const excelCount = exports.filter(e => e.format === 'excel').length
  const latexCount = exports.filter(e => e.format === 'latex').length

  const columns = [
    {
      title: '文件名', dataIndex: 'name', key: 'name',
      render: (v, r) => (
        <Space>
          {formatIcons[r.format] || <FileTextOutlined />}
          <span style={{ fontWeight: 500 }}>{v}</span>
        </Space>
      ),
    },
    {
      title: '类型', dataIndex: 'format', key: 'format',
      render: v => <Tag>{formatLabels[v] || v}</Tag>,
    },
    { title: '来源', dataIndex: 'source', key: 'source', render: v => v || '—' },
    { title: '大小', dataIndex: 'size', key: 'size' },
    { title: '时间', dataIndex: 'time', key: 'time' },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: v => <Tag color={v === 'success' ? 'success' : 'error'}>{v === 'success' ? '成功' : '失败'}</Tag>,
    },
    {
      title: '操作', key: 'action', align: 'right',
      render: (_, r) => (
        <Space>
          <Button type="text" size="small" icon={<DownloadOutlined />} onClick={() => handleDownload(r)} />
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 32 }}>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}><Card><Statistic title="导出总数" value={exports.length} /></Card></Col>
        <Col span={6}><Card><Statistic title="Word 文档" value={wordCount} valueStyle={{ color: '#2563eb' }} /></Card></Col>
        <Col span={6}><Card><Statistic title="LaTeX 文件" value={latexCount} valueStyle={{ color: '#475569' }} /></Card></Col>
        <Col span={6}><Card><Statistic title="Excel 表格" value={excelCount} valueStyle={{ color: '#16a34a' }} /></Card></Col>
      </Row>

      <Card title="导出日志">
        {exports.length === 0 ? (
          <Empty description="暂无导出记录" style={{ padding: 60 }} />
        ) : (
          <Table
            dataSource={exports.map((e, i) => ({ ...e, key: i }))}
            columns={columns}
            pagination={{ pageSize: 10, showTotal: total => `共 ${total} 条` }}
            size="small"
          />
        )}
      </Card>
    </div>
  )
}
