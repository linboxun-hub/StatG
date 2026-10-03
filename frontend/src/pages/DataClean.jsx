import React, { useState, useEffect, useCallback } from 'react'
import { Card, Table, Button, Select, InputNumber, Upload, Tag, Space, message, Input, Tooltip, Popconfirm } from 'antd'
import {
  UploadOutlined, DownloadOutlined, UndoOutlined, PlayCircleOutlined,
  DeleteOutlined, FilterOutlined, EditOutlined, SwapOutlined,
  ScissorOutlined, RiseOutlined, CloudUploadOutlined, CompressOutlined,
} from '@ant-design/icons'
import { dataAPI } from '../api'

const CLEAN_METHODS = [
  { key: 'missing', label: '处理缺失值', icon: <DeleteOutlined />, color: '#f59e0b' },
  { key: 'duplicate', label: '删除重复行', icon: <ScissorOutlined />, color: '#ef4444' },
  { key: 'outlier', label: '处理异常值', icon: <RiseOutlined />, color: '#8b5cf6' },
  { key: 'filter', label: '筛选行', icon: <FilterOutlined />, color: '#3b82f6' },
  { key: 'rename', label: '重命名变量', icon: <EditOutlined />, color: '#10b981' },
  { key: 'drop_var', label: '删除变量', icon: <DeleteOutlined />, color: '#f97316' },
  { key: 'convert', label: '类型转换', icon: <SwapOutlined />, color: '#06b6d4' },
  { key: 'normalize', label: '标准化 / 归一化', icon: <RiseOutlined />, color: '#6366f1' },
  { key: 'winsorize', label: '缩尾（Winsorize）', icon: <CompressOutlined />, color: '#8b5cf6' },
]

const MISSING_STRATEGIES = [
  { label: '删除含缺失值的行', value: 'drop' },
  { label: '均值填充', value: 'mean' },
  { label: '中位数填充', value: 'median' },
  { label: '众数填充', value: 'mode' },
  { label: '前向填充', value: 'ffill' },
  { label: '常数填充', value: 'constant' },
]

const FILTER_OPS = [
  { label: '大于 (>)', value: 'gt' },
  { label: '小于 (<)', value: 'lt' },
  { label: '等于 (=)', value: 'eq' },
  { label: '大于等于 (>=)', value: 'gte' },
  { label: '小于等于 (<=)', value: 'lte' },
  { label: '不等于 (!=)', value: 'neq' },
]

const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

export default function DataClean() {
  const [variables, setVariables] = useState([])
  const [tableData, setTableData] = useState({ data: [], total: 0, columns: [] })
  const [selectedMethod, setSelectedMethod] = useState('missing')
  const [cleanLog, setCleanLog] = useState([])
  const [loading, setLoading] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [missingInfo, setMissingInfo] = useState({ total: 0, details: {} })
  const [summary, setSummary] = useState({})
  const [page, setPage] = useState(1)

  // Config states
  const [missingVar, setMissingVar] = useState('全部变量')
  const [missingStrategy, setMissingStrategy] = useState('drop')
  const [missingConstant, setMissingConstant] = useState(null)
  const [filterCol, setFilterCol] = useState(null)
  const [filterOp, setFilterOp] = useState('gt')
  const [filterVal, setFilterVal] = useState(null)
  const [renameFrom, setRenameFrom] = useState(null)
  const [renameTo, setRenameTo] = useState('')
  const [dropVar, setDropVar] = useState(null)
  const [normalizeVar, setNormalizeVar] = useState(null)
  const [normalizeMethod, setNormalizeMethod] = useState('zscore')
  const [outlierVar, setOutlierVar] = useState('全部变量')
  const [convertVar, setConvertVar] = useState(null)
  const [convertTo, setConvertTo] = useState('numeric')
  const [winsorVar, setWinsorVar] = useState('全部变量')
  const [winsorLo, setWinsorLo] = useState(0.01)
  const [winsorHi, setWinsorHi] = useState(0.99)

  const fetchData = useCallback(async (p = 1) => {
    setLoading(true)
    try {
      const [dataRes, varsRes, summaryRes] = await Promise.all([
        dataAPI.get(p, 20, ''),
        dataAPI.variables(),
        dataAPI.summary(),
      ])
      setTableData(dataRes.data)
      setVariables((varsRes.data.variables || []).map(v => v.name))
      setSummary(summaryRes.data.summary || {})
      // Count missing
      const vars = varsRes.data.variables || []
      const totalMissing = vars.reduce((s, v) => s + (v.missing || 0), 0)
      const details = {}
      vars.forEach(v => { if (v.missing > 0) details[v.name] = v.missing })
      setMissingInfo({ total: totalMissing, details })
    } catch (e) { message.error('加载失败') }
    setLoading(false)
  }, [])

  useEffect(() => { fetchData() }, [])

  const handleUpload = async (file) => {
    try {
      await dataAPI.upload(file)
      message.success('导入成功')
      setCleanLog([])
      fetchData()
    } catch (e) { message.error('导入失败') }
    return false
  }

  /**
   * 按当前选中的清洗方式收集参数并做前端校验。
   * 返回 { error } 表示配置不完整，不该发请求。
   */
  const buildConfig = () => {
    switch (selectedMethod) {
      case 'missing':
        return { var: missingVar, strategy: missingStrategy, constant: missingConstant }
      case 'duplicate':
        return {}
      case 'outlier':
        return { var: outlierVar }
      case 'filter':
        if (!filterCol) return { error: '请选择要筛选的变量' }
        if (filterVal === null || filterVal === '') return { error: '请填写用来比较的值' }
        return { col: filterCol, op: filterOp, val: filterVal }
      case 'rename':
        if (!renameFrom) return { error: '请选择要重命名的变量' }
        if (!renameTo.trim()) return { error: '请填写新的变量名' }
        return { from: renameFrom, to: renameTo.trim() }
      case 'drop_var':
        if (!dropVar) return { error: '请选择要删除的变量' }
        return { var: dropVar }
      case 'convert':
        if (!convertVar) return { error: '请选择要转换的变量' }
        return { var: convertVar, to: convertTo }
      case 'normalize':
        if (!normalizeVar) return { error: '请选择要标准化的变量' }
        return { var: normalizeVar, method: normalizeMethod }
      case 'winsorize':
        if (!(winsorLo > 0 && winsorHi < 1 && winsorLo < winsorHi)) {
          return { error: '上下分位数必须在 (0, 1) 之间且下 < 上' }
        }
        return { var: winsorVar, lower: winsorLo, upper: winsorHi }
      default:
        return { error: `清洗方式 ${selectedMethod} 还没有实现` }
    }
  }

  const descOf = () => {
    const stratLabel = MISSING_STRATEGIES.find(s => s.value === missingStrategy)?.label
    switch (selectedMethod) {
      case 'missing':  return `处理缺失值 · ${missingVar}`
      case 'duplicate': return '删除重复行'
      case 'outlier':  return `处理异常值 · ${outlierVar}`
      case 'filter':   return `筛选行 · ${filterCol} ${filterOp} ${filterVal}`
      case 'rename':   return `重命名 · ${renameFrom} → ${renameTo.trim()}`
      case 'drop_var': return `删除变量 · ${dropVar}`
      case 'convert':  return `类型转换 · ${convertVar} → ${convertTo === 'numeric' ? '数值' : convertTo === 'text' ? '文本' : '日期'}`
      case 'normalize': return `标准化 · ${normalizeVar}`
      case 'winsorize': return `缩尾 · ${winsorVar} (${(winsorLo * 100).toFixed(0)}% / ${(winsorHi * 100).toFixed(0)}%)`
      default: return selectedMethod
    }
  }

  /**
   * 执行一步清洗。
   *
   * 之前这个函数是假的：它不调后端，只在本地数组里追加一条描述，
   * 数据一个字节都没动。所以同一个步骤能反复出现（连点三次日志里三行
   * 一模一样的「影响 45977」），而缺失值始终不降、导出的还是原始数据。
   * 现在 affected === 0 就明确说这步什么都没改，不往日志里塞假记录。
   */
  const handleClean = async () => {
    const cfg = buildConfig()
    if (cfg.error) { message.warning(cfg.error); return }
    setCleaning(true)
    try {
      const res = await dataAPI.clean(selectedMethod, cfg)
      const r = res.data
      if (r.error) { message.error(r.error); return }
      if (!r.applied) {
        message.info(`${r.detail || '这一步没有改变任何数据'}，未记入日志`)
        return
      }
      setCleanLog(prev => [...prev, {
        step: r.step, method: selectedMethod, desc: descOf(),
        detail: r.detail, time: nowTime(),
      }])
      message.success(`步骤 ${r.step}：${r.detail}`)
      fetchData(page)
    } catch (e) {
      message.error('清洗失败')
    } finally {
      setCleaning(false)
    }
  }

  // 撤销全部：把第一次清洗之前那份数据放回来，而不是只把日志数组清空
  const handleUndoAll = async () => {
    try {
      const res = await dataAPI.cleanUndo()
      if (res.data.error) { message.info(res.data.error); setCleanLog([]); return }
      setCleanLog([])
      message.success(res.data.detail || '已撤销全部清洗')
      fetchData(page)
    } catch (e) { message.error('撤销失败') }
  }

  const handleExport = async () => {
    try {
      const res = await dataAPI.exportCsv()
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = 'cleaned_data.csv'
      a.click()
      URL.revokeObjectURL(url)
      message.success('导出成功')
    } catch (e) { message.error('导出失败') }
  }

  const columns = (tableData.columns || []).map(c => ({
    title: c, dataIndex: c, key: c, ellipsis: true,
    render: (v) => {
      if (v === null || v === undefined || v === '') return <span style={{ color: '#f59e0b' }}>—</span>
      return String(v)
    },
  }))

  const renderConfig = () => {
    switch (selectedMethod) {
      case 'missing':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>选择变量</label>
              <Select value={missingVar} onChange={setMissingVar} style={{ width: '100%', marginTop: 4 }} size="small"
                options={[{ label: '全部变量', value: '全部变量' }, ...variables.map(v => ({ label: v, value: v }))]} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>处理方式</label>
              <Select value={missingStrategy} onChange={setMissingStrategy} style={{ width: '100%', marginTop: 4 }} size="small"
                options={MISSING_STRATEGIES} />
            </div>
            {missingStrategy === 'constant' && (
              <div>
                <label style={{ fontSize: 12, color: '#64748b' }}>用来填充的值</label>
                <Input value={missingConstant ?? ''} onChange={e => setMissingConstant(e.target.value)}
                       style={{ marginTop: 4 }} size="small" placeholder="例如 0" />
              </div>
            )}
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#475569' }}>
                <span>当前缺失值</span><span style={{ fontWeight: 600, color: '#f59e0b' }}>{missingInfo.total} 个</span>
              </div>
              {Object.entries(missingInfo.details).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'spaceBetween', color: '#475569', marginTop: 4 }}>
                  <span>{k}</span><span style={{ fontWeight: 500 }}>{v}</span>
                </div>
              ))}
            </div>
          </>
        )
      case 'filter':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>变量</label>
              <Select value={filterCol} onChange={setFilterCol} style={{ width: '100%', marginTop: 4 }} size="small"
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>条件</label>
              <Select value={filterOp} onChange={setFilterOp} style={{ width: '100%', marginTop: 4 }} size="small"
                options={FILTER_OPS} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>值</label>
              <InputNumber value={filterVal} onChange={setFilterVal} style={{ width: '100%', marginTop: 4 }} size="small" />
            </div>
          </>
        )
      case 'rename':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>原变量名</label>
              <Select value={renameFrom} onChange={setRenameFrom} style={{ width: '100%', marginTop: 4 }} size="small"
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>新变量名</label>
              <Input value={renameTo} onChange={e => setRenameTo(e.target.value)} style={{ marginTop: 4 }} size="small" placeholder="输入新名称" />
            </div>
          </>
        )
      case 'drop_var':
        return (
          <div>
            <label style={{ fontSize: 12, color: '#64748b' }}>选择要删除的变量</label>
            <Select value={dropVar} onChange={setDropVar} style={{ width: '100%', marginTop: 4 }} size="small"
              options={variables.map(v => ({ label: v, value: v }))} />
          </div>
        )
      case 'normalize':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>选择变量</label>
              <Select value={normalizeVar} onChange={setNormalizeVar} style={{ width: '100%', marginTop: 4 }} size="small"
                options={variables.filter(v => summary[v]).map(v => ({ label: v, value: v }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>方法</label>
              <Select value={normalizeMethod} onChange={setNormalizeMethod} style={{ width: '100%', marginTop: 4 }} size="small"
                options={[{ label: 'Z-Score 标准化', value: 'zscore' }, { label: 'Min-Max 归一化', value: 'minmax' }]} />
            </div>
          </>
        )
      case 'outlier':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>检查哪些变量</label>
              <Select value={outlierVar} onChange={setOutlierVar} style={{ width: '100%', marginTop: 4 }} size="small"
                options={[{ label: '全部变量', value: '全部变量' }, ...variables.map(v => ({ label: v, value: v }))]} />
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, fontSize: 12, color: '#475569' }}>
              按 IQR 规则判定：超出 [Q1 − 1.5×IQR, Q3 + 1.5×IQR] 的行会被删除。
              缺失值不算异常值。
            </div>
          </>
        )
      case 'convert':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>选择变量</label>
              <Select value={convertVar} onChange={setConvertVar} style={{ width: '100%', marginTop: 4 }} size="small"
                placeholder="选择要转换的变量"
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>转换成</label>
              <Select value={convertTo} onChange={setConvertTo} style={{ width: '100%', marginTop: 4 }} size="small"
                options={[
                  { label: '数值', value: 'numeric' },
                  { label: '文本', value: 'text' },
                  { label: '日期', value: 'datetime' },
                ]} />
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, fontSize: 12, color: '#475569' }}>
              转数值或日期时，解析不出来的值会变成缺失值，日志里会说明有几个。
            </div>
          </>
        )
      case 'winsorize':
        return (
          <>
            <div>
              <label style={{ fontSize: 12, color: '#64748b' }}>选择变量</label>
              <Select value={winsorVar} onChange={setWinsorVar} style={{ width: '100%', marginTop: 4 }} size="small"
                options={[{ label: '全部数值变量', value: '全部变量' }, ...variables.map(v => ({ label: v, value: v }))]} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: '#64748b' }}>下分位</label>
                <InputNumber value={winsorLo} onChange={setWinsorLo}
                  min={0.001} max={0.499} step={0.005} precision={3}
                  style={{ width: '100%', marginTop: 4 }} size="small" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: '#64748b' }}>上分位</label>
                <InputNumber value={winsorHi} onChange={setWinsorHi}
                  min={0.501} max={0.999} step={0.005} precision={3}
                  style={{ width: '100%', marginTop: 4 }} size="small" />
              </div>
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: 12, fontSize: 12, color: '#475569' }}>
              <b>顶刊惯例是 1% / 99%</b>。缩尾会保留行数，只把极端值压回分位数边界本身（不是删除）。
              建议在主回归和事件研究图<b>之前</b>做这一步，这样两边用的就是同一份数据。
              缺失值不动（缺失不该被错误地顶成边界值）。
            </div>
          </>
        )
      default:
        return <div style={{ fontSize: 12, color: '#94a3b8' }}>配置选项开发中...</div>
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: tools */}
        <div style={{ width: 288, borderRight: '1px solid #e2e8f0', background: '#fff', overflowY: 'auto', flexShrink: 0 }}>
          {/* Import */}
          <div style={{ padding: 16, borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 12 }}>
              <CloudUploadOutlined style={{ color: '#6366f1', marginRight: 8 }} />导入数据
            </div>
            <Upload beforeUpload={handleUpload} showUploadList={false} accept=".csv,.xlsx,.xls,.dta">
              <div style={{ border: '2px dashed #e2e8f0', borderRadius: 8, padding: 20, textAlign: 'center', cursor: 'pointer', transition: 'border-color 0.2s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#6366f1'}
                onMouseLeave={e => e.currentTarget.style.borderColor = '#e2e8f0'}>
                <CloudUploadOutlined style={{ fontSize: 24, color: '#cbd5e1', marginBottom: 8 }} />
                <div style={{ fontSize: 12, color: '#64748b' }}>拖拽文件或点击上传</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>支持 CSV / Excel / DTA</div>
              </div>
            </Upload>
          </div>

          {/* Methods */}
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 12 }}>
              <ScissorOutlined style={{ color: '#f59e0b', marginRight: 8 }} />清洗方式
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {CLEAN_METHODS.map(m => (
                <div key={m.key} onClick={() => setSelectedMethod(m.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 6,
                    cursor: 'pointer', fontSize: 13,
                    background: selectedMethod === m.key ? '#eef2ff' : 'transparent',
                    color: selectedMethod === m.key ? '#4f46e5' : '#475569',
                    fontWeight: selectedMethod === m.key ? 600 : 400,
                  }}>
                  <span style={{ color: selectedMethod === m.key ? m.color : '#94a3b8' }}>{m.icon}</span>
                  {m.label}
                </div>
              ))}
            </div>
          </div>

          {/* Config */}
          <div style={{ padding: 16, borderTop: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 12 }}>
              {CLEAN_METHODS.find(m => m.key === selectedMethod)?.label}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {renderConfig()}
            </div>
            <Button type="primary" icon={<PlayCircleOutlined />} block style={{ marginTop: 16 }}
              loading={cleaning} onClick={handleClean}>执行清洗</Button>
          </div>
        </div>

        {/* Right: data + log */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Table */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            <Table
              columns={columns}
              dataSource={(tableData.data || []).map((r, i) => ({ ...r, _key: i }))}
              rowKey="_key"
              loading={loading}
              pagination={{
                current: page, pageSize: 20, total: tableData.total,
                onChange: p => { setPage(p); fetchData(p) },
                showTotal: t => `共 ${t} 条`,
                showSizeChanger: false,
              }}
              size="small" scroll={{ x: 'max-content' }}
              rowClassName={(record) => {
                if (selectedMethod === 'missing' && Object.keys(missingInfo.details).length > 0) {
                  return ''
                }
                return ''
              }}
            />
          </div>

          {/* Log */}
          <div style={{ borderTop: '1px solid #e2e8f0', background: '#fff', maxHeight: 180, overflowY: 'auto' }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
              <span style={{ marginRight: 8 }}>🕐</span>清洗日志
            </div>
            {cleanLog.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#94a3b8' }}>执行清洗操作后，日志将在此显示</div>
            ) : (
              <div style={{ padding: '8px 16px' }}>
                {cleanLog.map((log, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', borderBottom: '1px solid #f8fafc', fontSize: 12 }}>
                    <Tag color={log.method === 'missing' ? 'orange' : log.method === 'filter' ? 'blue' : 'purple'} style={{ margin: 0, fontSize: 11 }}>
                      步骤 {log.step}
                    </Tag>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: '#1e293b', fontWeight: 500 }}>{log.desc}</div>
                      <div style={{ color: '#94a3b8', marginTop: 2 }}>{log.detail}</div>
                    </div>
                    <span style={{ color: '#94a3b8', whiteSpace: 'nowrap' }}>{log.time}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Status bar */}
          <div style={{ borderTop: '1px solid #e2e8f0', background: '#fff', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#64748b' }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <span>📊 {tableData.total || 0} 行 × {(tableData.columns || []).length} 列</span>
              <span>⚠️ 缺失值: <span style={{ color: '#f59e0b', fontWeight: 600 }}>{missingInfo.total}</span></span>
              <span>🔄 已执行: <span style={{ color: '#6366f1', fontWeight: 600 }}>{cleanLog.length}</span> 步</span>
            </div>
            <Space>
              <Popconfirm title="确认撤销全部清洗步骤？数据会恢复到第一次清洗之前" onConfirm={handleUndoAll}>
                <Button size="small" icon={<UndoOutlined />} disabled={cleanLog.length === 0}>撤销全部</Button>
              </Popconfirm>
              <Button size="small" type="primary" icon={<DownloadOutlined />} onClick={handleExport}>导出 CSV</Button>
            </Space>
          </div>
        </div>
      </div>
    </div>
  )
}
