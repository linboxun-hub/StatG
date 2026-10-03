import React, { useState, useEffect, useCallback } from 'react'
import { Card, Row, Col, Table, Button, Input, Upload, Tabs, Statistic, message, Space, Select, Divider, Tooltip } from 'antd'
import { UploadOutlined, DownloadOutlined, SearchOutlined, DatabaseOutlined } from '@ant-design/icons'
import { dataAPI } from '../api'

export default function Data() {
  const [pageData, setPageData] = useState({ data: [], total: 0, columns: [] })
  const [info, setInfo] = useState({})
  const [variables, setVariables] = useState([])
  const [summary, setSummary] = useState({})
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('data')
  const [spDatasets, setSpDatasets] = useState([])

  const refreshAll = useCallback(async () => {
    try {
      const [infoRes, varsRes, summaryRes] = await Promise.all([
        dataAPI.info(), dataAPI.variables(), dataAPI.summary(),
      ])
      setInfo(infoRes.data)
      setVariables(varsRes.data.variables || [])
      setSummary(summaryRes.data.summary || {})
    } catch (e) {}
  }, [])

  const fetchData = useCallback(async (p = page, s = search) => {
    setLoading(true)
    try {
      const res = await dataAPI.get(p, 20, s)
      setPageData(res.data)
    } catch (e) { message.error('加载数据失败') }
    setLoading(false)
  }, [page, search])

  useEffect(() => {
    // 先尝试同步项目数据（如果 data_service 为空但项目有数据）
    dataAPI.syncProject().catch(() => {}).finally(() => {
      fetchData()
      refreshAll()
      dataAPI.statspaiDatasets().then(r => setSpDatasets(r.data.datasets || [])).catch(() => {})
    })
  }, [])

  const handleLoadSpDataset = async (name) => {
    try {
      await dataAPI.loadStatspai(name)
      message.success(`已加载: ${name}`)
      fetchData(1, '')
      setPage(1)
      setSearch('')
      refreshAll()
    } catch (e) { message.error('加载失败') }
  }

  const handleUpload = async (file) => {
    try {
      await dataAPI.upload(file)
      message.success('数据导入成功')
      fetchData(1, '')
      setPage(1)
      setSearch('')
      dataAPI.info().then(r => setInfo(r.data))
      dataAPI.variables().then(r => setVariables(r.data.variables || []))
      dataAPI.summary().then(r => setSummary(r.data.summary || {}))
    } catch (e) { message.error('导入失败') }
    return false
  }

  const handleExport = async () => {
    try {
      const res = await dataAPI.exportCsv()
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = (info.name || 'data') + '.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) { message.error('导出失败') }
  }

  const columns = (pageData.columns || []).map(c => ({
    title: c, dataIndex: c, key: c,
    render: v => v === null || v === undefined ? <span style={{ color: '#d4d4d4' }}>—</span> : String(v),
  }))

  const varColumns = [
    { title: '变量名', dataIndex: 'name', key: 'name', render: v => <strong>{v}</strong> },
    { title: '类型', dataIndex: 'type', key: 'type', render: v => <span style={{ color: v === '数值型' ? '#6366f1' : '#f59e0b' }}>{v}</span> },
    { title: '标签', dataIndex: 'label', key: 'label' },
    { title: '缺失值', dataIndex: 'missing', key: 'missing', render: v => v > 0 ? <span style={{ color: '#f59e0b' }}>{v}</span> : '0' },
    { title: '唯一值', dataIndex: 'unique', key: 'unique' },
  ]

  const summaryColumns = [
    { title: '变量', dataIndex: 'var', key: 'var', render: v => <strong>{v}</strong> },
    { title: 'Obs', dataIndex: 'obs', key: 'obs' },
    { title: 'Mean', dataIndex: 'mean', key: 'mean' },
    { title: 'Std.Dev.', dataIndex: 'std', key: 'std' },
    { title: 'Min', dataIndex: 'min', key: 'min' },
    { title: 'P25', dataIndex: 'p25', key: 'p25' },
    { title: 'P50', dataIndex: 'p50', key: 'p50' },
    { title: 'P75', dataIndex: 'p75', key: 'p75' },
    { title: 'Max', dataIndex: 'max', key: 'max' },
  ]
  const summaryData = Object.entries(summary).map(([k, v]) => ({ var: k, ...v }))

  return (
    <div style={{ padding: 32 }}>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        {[
          { title: '观测数', value: info.rows || 0 },
          { title: '变量数', value: info.cols || 0 },
          { title: '缺失值', value: info.missing || 0, color: info.missing > 0 ? '#f59e0b' : undefined },
          // size_kb 现在是磁盘上那个文件的大小；内存占用另外给一个字段。
          // 之前这里直接显示 DataFrame 的内存占用，25 MB 的文件显示 38 MB，
          // 标题写「文件大小」是假的。
          { title: '文件大小', value: info.size_kb ? `${info.size_kb} KB` : '—',
            tip: info.ram_kb ? `磁盘文件大小。这份数据在内存里约占 ${Math.round(info.ram_kb / 1024)} MB` : undefined },
        ].map((s, i) => (
          <Col span={6} key={i}>
            <Card><Statistic title={s.tip
              ? <Tooltip title={s.tip}><span style={{ borderBottom: '1px dotted #94a3b8' }}>{s.title}</span></Tooltip>
              : s.title}
              value={s.value} valueStyle={s.color ? { color: s.color } : undefined} /></Card>
          </Col>
        ))}
      </Row>

      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <DatabaseOutlined style={{ color: '#10b981' }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>StatsPAI 数据集:</span>
          <Select
            style={{ width: 300 }}
            placeholder="选择 StatsPAI 内置数据集加载"
            onChange={handleLoadSpDataset}
            options={spDatasets.map(d => ({ label: `${d.name} (${d.design})`, value: d.name }))}
            showSearch
            filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
            size="small"
          />
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{spDatasets.length} 个可用</span>
        </div>
      </Card>

      <Card
        title={info.name ? `当前数据集: ${info.name}` : '数据管理'}
        extra={
          <Space>
            <Upload beforeUpload={handleUpload} showUploadList={false} accept=".csv,.xlsx,.xls,.dta">
              <Button type="primary"><UploadOutlined /> 导入数据</Button>
            </Upload>
            <Button onClick={handleExport}><DownloadOutlined /> 导出 CSV</Button>
          </Space>
        }
      >
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          {
            key: 'data', label: '数据视图',
            children: (
              <>
                <Input
                  prefix={<SearchOutlined />} placeholder="搜索变量..."
                  style={{ width: 240, marginBottom: 16 }}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onPressEnter={() => { setPage(1); fetchData(1, search) }}
                  allowClear
                />
                <Table
                  columns={columns}
                  dataSource={(pageData.data || []).map((r, i) => ({ ...r, _key: i }))}
                  rowKey="_key"
                  loading={loading}
                  pagination={{
                    current: page, pageSize: 20, total: pageData.total,
                    onChange: p => { setPage(p); fetchData(p, search) },
                    showTotal: total => `共 ${total} 条`,
                    showSizeChanger: false,
                  }}
                  size="small" scroll={{ x: 'max-content' }}
                />
              </>
            ),
          },
          {
            key: 'vars', label: '变量视图',
            children: <Table columns={varColumns} dataSource={variables.map((v, i) => ({ ...v, key: i }))} pagination={false} size="small" />,
          },
          {
            key: 'summary', label: '数据摘要',
            children: <Table columns={summaryColumns} dataSource={summaryData.map((s, i) => ({ ...s, key: i }))} pagination={false} size="small" />,
          },
        ]} />
      </Card>
    </div>
  )
}
