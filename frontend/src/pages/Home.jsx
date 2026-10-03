import React, { useState, useEffect, useMemo } from 'react'
import { Card, Row, Col, Statistic, List, Tag, Button, Select, Input, Tooltip, message } from 'antd'
import {
  ImportOutlined, ScissorOutlined, BarChartOutlined,
  DatabaseOutlined, ThunderboltOutlined, FileTextOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { statsAPI, dataAPI } from '../api'

const quickActions = [
  { title: '导入数据', desc: 'CSV / Excel / DTA', icon: <ImportOutlined />, color: '#6366f1', bg: '#eef2ff', path: '/data' },
  { title: '数据清洗', desc: '清洗 / 转换 / 导出', icon: <ScissorOutlined />, color: '#10b981', bg: '#ecfdf5', path: '/editor' },
  { title: '统计分析', desc: '回归 / 检验 / 图形', icon: <BarChartOutlined />, color: '#f59e0b', bg: '#fffbeb', path: '/analysis' },
]

export default function Home() {
  const navigate = useNavigate()
  const [stats, setStats] = useState({ datasets: 0, total_rows: 0, commands_run: 0, exports: 0 })
  const [datasets, setDatasets] = useState([])
  const [spDatasets, setSpDatasets] = useState([])
  const [currentDataset, setCurrentDataset] = useState(null)
  const [loadingDs, setLoadingDs] = useState(false)
  const [switching, setSwitching] = useState(null)
  const [folderFilter, setFolderFilter] = useState('')
  const [search, setSearch] = useState('')
  const [onlyBroken, setOnlyBroken] = useState(false)

  const refresh = () => {
    statsAPI.get().then(r => setStats(r.data)).catch(() => {})
    dataAPI.list().then(r => {
      setDatasets(r.data.datasets || [])
      setCurrentDataset(r.data.current)
    }).catch(() => {})
  }

  useEffect(() => {
    refresh()
    dataAPI.statspaiDatasets()
      .then(r => setSpDatasets(r.data.datasets || []))
      .catch(() => {})
  }, [])

  // 子目录文件按目录前缀归组。同名文件在不同目录下是三份不同数据
  // （这个项目里 FS_Comins.dta 有三个版本，55512 / 61195 / 63728 行），
  // 光看文件名根本分不出来，所以目录必须跟着显示。
  const subdirs = useMemo(
    () => [...new Set(datasets.map(d => d.folder).filter(Boolean))].sort(),
    [datasets]
  )

  const shown = useMemo(() => {
    let list = datasets
    if (folderFilter) list = list.filter(d => d.folder === folderFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(d => (d.name || '').toLowerCase().includes(q))
    }
    if (onlyBroken) list = list.filter(d => !d.ok)
    return list
  }, [datasets, folderFilter, search, onlyBroken])

  const nBroken = datasets.filter(d => d.ok === false).length
  const nSubdir = datasets.filter(d => d.folder).length

  const handleLoadStatspai = async (name) => {
    setLoadingDs(true)
    try {
      await dataAPI.loadStatspai(name)
      message.success(`已加载: ${name}`)
      refresh()
    } catch (e) {
      message.error('加载失败')
    }
    setLoadingDs(false)
  }

  const handleSwitch = async (item) => {
    setSwitching(item.name)
    try {
      const r = await dataAPI.select(item.name)
      if (r.data.error) message.error(r.data.error)
      else message.success(`已切换到 ${item.file}`)
      refresh()
    } catch (e) {
      message.error('切换失败')
    }
    setSwitching(null)
  }

  return (
    <div style={{ padding: 32 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 12 }}>快速开始</h2>
      <Row gutter={16}>
        {quickActions.map(a => (
          <Col span={6} key={a.title}>
            <Card hoverable onClick={() => navigate(a.path)} style={{ cursor: 'pointer' }}
              styles={{ body: { padding: 20 } }}>
              <div style={{ width: 40, height: 40, borderRadius: 8, background: a.bg, color: a.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, marginBottom: 12 }}>
                {a.icon}
              </div>
              <div style={{ fontWeight: 500, color: '#1e293b', fontSize: 14 }}>{a.title}</div>
              <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>{a.desc}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={16} style={{ marginTop: 24 }}>
        <Col span={6}>
          <Card><Statistic title="数据集" value={stats.datasets} prefix={<DatabaseOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="数据记录" value={stats.total_rows} suffix="条" /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="运行命令" value={stats.commands_run} prefix={<ThunderboltOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="导出结果" value={stats.exports} prefix={<FileTextOutlined />} /></Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 24 }}>
        <Col span={12}>
          <Card
            title="当前数据集"
            size="small"
            extra={
              <Tooltip title={`项目目录扫描结果：${datasets.length} 个文件，其中 ${nSubdir} 个在子文件夹里`}>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  {nSubdir > 0 ? `含 ${nSubdir} 个子目录文件` : ''}
                </span>
              </Tooltip>
            }
          >
            <div style={{ marginBottom: 12 }}>
              <Tag color="blue" style={{ fontSize: 13, padding: '4px 12px' }}>
                {currentDataset ? currentDataset.split('/').pop() : '未加载'}
              </Tag>
              {nBroken > 0 && (
                <Tooltip title={`${nBroken} 个文件读不出来。切过去会告诉你是哪个、为什么`}>
                  <Tag color="red" icon={<WarningOutlined />} style={{ marginLeft: 6 }}>
                    {nBroken} 个读不出
                  </Tag>
                </Tooltip>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <Input
                size="small" allowClear placeholder="搜文件名" style={{ width: 140 }}
                value={search} onChange={e => setSearch(e.target.value)}
              />
              <Select
                size="small" allowClear placeholder="全部目录" style={{ width: 220 }}
                value={folderFilter || undefined} onChange={v => setFolderFilter(v || '')}
                options={subdirs.map(f => ({ value: f, label: f.split('/').join(' / ') }))}
              />
              <Button size="small" type={onlyBroken ? 'primary' : 'default'} danger={onlyBroken}
                      onClick={() => setOnlyBroken(v => !v)}>
                只看读不出的
              </Button>
              {/* 筛选生效时必须说清「显示了几个 / 一共有几个」。
                  否则搜索结果和完整列表长得一样，容易以为项目里就这几个文件 */}
              {(search.trim() || folderFilter || onlyBroken) && (
                <span style={{ fontSize: 11, color: shown.length ? '#6366f1' : '#ef4444' }}>
                  显示 {shown.length} / 共 {datasets.length}
                </span>
              )}
            </div>

            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              <List
                size="small"
                loading={false}
                dataSource={shown}
                locale={{ emptyText: '没有匹配的数据集' }}
                renderItem={item => (
                  <List.Item
                    actions={[
                      <Button type="link" size="small" loading={switching === item.name}
                        disabled={item.current || !item.ok}
                        onClick={() => handleSwitch(item)}>
                        {item.current ? '使用中' : '切换'}
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<DatabaseOutlined style={{
                        fontSize: 16,
                        color: item.current ? '#16a34a' : item.ok === false ? '#ef4444' : '#6366f1',
                      }} />}
                      title={
                        <span style={{ fontSize: 13 }}>
                          {item.file}
                          {item.current && <Tag color="green" style={{ marginLeft: 6, fontSize: 10 }}>当前</Tag>}
                          {/* 同样：只有明确 false 才算读不出 */}
                          {item.ok === false && (
                            <Tooltip title={item.error || '读取失败'}>
                              <Tag color="red" style={{ marginLeft: 6, fontSize: 10 }}>读不出</Tag>
                            </Tooltip>
                          )}
                        </span>
                      }
                      description={
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>
                          {item.folder
                            ? <span style={{ color: '#6366f1' }}>{item.folder.split('/').join(' / ')}</span>
                            : '项目根目录'}
                          {item.rows != null && ` · ${item.rows.toLocaleString()} 行 × ${item.cols} 列`}
                        </span>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="StatsPAI 内置数据集" size="small" extra={<Tag color="green">15 个经典数据集</Tag>}>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <List
                dataSource={spDatasets}
                loading={loadingDs}
                renderItem={item => (
                  <List.Item
                    actions={[
                      <Button type="link" size="small" onClick={() => handleLoadStatspai(item.name)}>
                        加载
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<DatabaseOutlined style={{ fontSize: 14, color: '#10b981' }} />}
                      title={<span style={{ fontSize: 13 }}>{item.name}</span>}
                      description={<span style={{ fontSize: 11 }}>{item.design} · {item.source}</span>}
                    />
                  </List.Item>
                )}
              />
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
