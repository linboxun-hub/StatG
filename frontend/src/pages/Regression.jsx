import React, { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { Card, Row, Col, Select, Button, Table, Checkbox, Radio, Space, Spin, message,
         Alert, Steps, Tag, Divider, Tooltip, Empty, InputNumber, Input, Typography,
         Tabs, Popconfirm } from 'antd'
import { PlayCircleOutlined, ThunderboltOutlined, DownloadOutlined, InfoCircleOutlined,
         ArrowRightOutlined, PlusCircleOutlined, DeleteOutlined, ArrowUpOutlined,
         ArrowDownOutlined, EditOutlined, TableOutlined } from '@ant-design/icons'
import { regressionAPI, dataAPI, profileAPI, exportAPI } from '../api'

const { Text, Paragraph } = Typography

const SE_OPTIONS = [
  { value: 'cluster', label: '聚类稳健标准误' },
  { value: 'robust', label: '异方差稳健 (HC1)' },
  { value: 'classical', label: '普通标准误' },
]

// 侧边栏把「基准回归 / 稳健性检验 / 机制检验」拆成三个入口，都指向本页；
// 靠 ?stage= 区分，各自只显示对应阶段的方法（后端 METHOD_CATALOG 的 group.stage）。
// stage 在组件内从 useLocation 现取：client 端在同一路径下切换 ?stage= 不会重挂载组件，
// 写成模块常量会导致阶段不更新（点完仍停留在上一个阶段的方法列表）。
const STAGE_META = {
  baseline: {
    title: '基准回归',
    desc: '先用核心设定把主效应做扎实：OLS / 固定效应 / 双重差分 / IV / PSM 等。'
        + '右侧「一键跑基准序列」一口气跑 (1)–(n) 列并合并成 esttab 对照表；'
        + '平行趋势图见左侧「② 基准回归 → 平行趋势」。',
  },
  robust: {
    title: '稳健性检验',
    desc: '换估计量、换 DID 纠偏、换模型形式，验证结论稳不稳。'
        + 'DML 稳健性见左侧「③ 稳健性检验 → DML」；缩尾在「数据准备 → 数据清洗」。',
  },
  mechanism: {
    title: '机制检验',
    desc: '门槛回归检验非线性机制；调节效应（交互项 X×M）直接在「② 基准回归」里加乘积项；'
        + '中介效应用 AI 助手的 sgmediation / medeff（bootstrap）跑。',
  },
}

function ParamField({ spec, value, onChange, variables }) {
  if (spec.type === 'var') {
    return (
      <Select value={value || undefined} onChange={onChange} style={{ width: '100%' }}
        placeholder={`请选择${spec.label}`} size="small" allowClear showSearch
        options={variables.map(v => ({ label: v, value: v }))} />
    )
  }
  if (spec.type === 'vars') {
    return (
      <Select mode="multiple" value={value || []} onChange={onChange} style={{ width: '100%' }}
        placeholder={`请选择${spec.label}`} size="small" allowClear showSearch
        options={variables.map(v => ({ label: v, value: v }))} />
    )
  }
  if (spec.type === 'select') {
    return (
      <Select value={value || spec.default} onChange={onChange} style={{ width: '100%' }} size="small"
        options={(spec.options || []).map(o => ({ label: String(o), value: String(o) }))} />
    )
  }
  if (spec.type === 'number') {
    return (
      <InputNumber value={value === undefined || value === null || value === '' ? undefined : value}
        onChange={onChange} style={{ width: '100%' }} size="small"
        placeholder={spec.placeholder || '请输入'} />
    )
  }
  return <Input value={value ?? spec.default ?? ''} onChange={e => onChange(e.target.value)}
    size="small" placeholder={spec.placeholder || '请输入'} />
}

export default function Regression() {
  // 阶段从路由现取：同一路径下切换 ?stage= 不重挂载组件，写死成常量会停留旧阶段
  const _loc = useLocation()
  const stage = new URLSearchParams(_loc.search).get('stage') || 'baseline'
  const stageInfo = STAGE_META[stage] || STAGE_META.baseline
  const stageHas = (g) => {
    const s = Array.isArray(g.stage) ? g.stage : (g.stage ? [g.stage] : ['baseline'])
    return s.includes(stage)
  }

  const [catalog, setCatalog] = useState([])
  const [paramSpecs, setParamSpecs] = useState({})
  const [variables, setVariables] = useState([])
  const [profile, setProfile] = useState(null)
  const [rec, setRec] = useState(null)
  const [staggered, setStaggered] = useState(null)

  const [group, setGroup] = useState('面板回归')
  const [method, setMethod] = useState('twoway_fe')
  const [yVar, setYVar] = useState(null)
  const [coreX, setCoreX] = useState([])
  const [controls, setControls] = useState([])
  const [idVar, setIdVar] = useState(null)
  const [timeVar, setTimeVar] = useState(null)
  const [absorb, setAbsorb] = useState([])
  const [seType, setSeType] = useState('cluster')
  const [cluster1, setCluster1] = useState(null)
  const [cluster2, setCluster2] = useState(null)
  const [params, setParams] = useState({})

  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [recApplied, setRecApplied] = useState(false)

  // 多模型对照表（esttab）。篮子放 localStorage，刷新页面不丢——
  // 跑五列回归要半分钟，不该因为手滑刷新就得重来。
  const [basket, setBasket] = useState(() => {
    try { return JSON.parse(localStorage.getItem('stata-reg-basket') || '[]') }
    catch (e) { return [] }
  })
  const [matrix, setMatrix] = useState(null)
  const [estLoading, setEstLoading] = useState(false)
  const [rowMode, setRowMode] = useState('core_const')
  const [rowAliases, setRowAliases] = useState(() => {
    try { return JSON.parse(localStorage.getItem('stata-reg-row-aliases') || '{}') }
    catch (e) { return {} }
  })
  const [editingRow, setEditingRow] = useState(null)
  const [activeTab, setActiveTab] = useState('single')

  useEffect(() => {
    localStorage.setItem('stata-reg-basket', JSON.stringify(basket))
  }, [basket])
  useEffect(() => {
    localStorage.setItem('stata-reg-row-aliases', JSON.stringify(rowAliases))
  }, [rowAliases])

  useEffect(() => {
    regressionAPI.methods().then(r => {
      setCatalog(r.data.catalog || [])
      setParamSpecs(r.data.param_specs || {})
    }).catch(() => {})
    dataAPI.variables().then(r => setVariables((r.data.variables || []).map(v => v.name))).catch(() => {})
    profileAPI.get().then(r => {
      setProfile(r.data)
      const rc = r.data.regression_recommend
      if (rc && rc.available) setRec(rc)
      if (r.data.staggered) setStaggered(r.data.staggered)
    }).catch(() => {})
  }, [])

  // 阶段/目录就绪后，把默认分组与方法落在当前阶段第一组：
  // 基准默认停在面板回归的双向固定效应，其余阶段取该阶段第一组第一种方法。
  // 依赖 [stage, catalog]——在同一路径下从 ②③④ 切换时也会跟着改。
  useEffect(() => {
    if (!catalog.length) return
    const vis = catalog.filter(stageHas)
    const g0 = (stage === 'baseline'
      ? (vis.find(g => g.group === '面板回归') || vis[0])
      : (vis[0] || catalog[0]))
    if (g0) {
      setGroup(g0.group)
      setMethod(g0.methods.find(m => m.key === 'twoway_fe')?.key || g0.methods[0].key)
    }
  }, [stage, catalog])

  // 方法切换时，自动带入该方法的参数默认值
  useEffect(() => {
    const specs = paramSpecs[method] || []
    setParams(prev => {
      const next = { ...prev }
      specs.forEach(s => {
        if (next[s.name] === undefined && s.default !== undefined) next[s.name] = s.default
      })
      return next
    })
  }, [method, paramSpecs])

  const currentGroup = catalog.find(g => g.group === group)
  const currentMethod = (currentGroup?.methods || []).find(m => m.key === method)
  // 只看当前阶段的分组（基准/稳健/机制各一组）；阶段由侧边栏 ?stage= 决定
  const visibleGroups = catalog.filter(stageHas)
  const needsPanel = ['fe', 'te', 'twoway_fe', 're', 'fd', 'between', 'gmm', 'threshold',
                      'did', 'event_study'].includes(method)

  const STAGGERED = ['csdid', 'sunab', 'bacon', 'did2s']

  const switchMethod = (k) => {
    setMethod(k)
    // 交错采纳方法自己构造处理指示变量，core_x 只该放内生解释变量，故清空
    if (STAGGERED.includes(k)) {
      setCoreX([])
      setResult(null)
      // 预填检测到的处理时点变量，省一次手选
      if (staggered?.cohort_var && !params.cohort_var) {
        setParams(p => ({ ...p, cohort_var: staggered.cohort_var }))
      }
    }
  }
  const switchGroup = (g) => {
    setGroup(g)
    const first = catalog.find(gg => gg.group === g)?.methods[0]
    if (first) switchMethod(first.key)
  }

  const applyRecommendation = (rc) => {
    setMethod(rc.method)
    const g = catalog.find(gg => gg.methods.some(m => m.key === rc.method))
    if (g) setGroup(g.group)
    setYVar(rc.y_var)
    setCoreX(rc.core_x || [])
    setControls(rc.controls || [])
    setIdVar(rc.id_var || null)
    setTimeVar(rc.time_var || null)
    setAbsorb(rc.absorb || [])
    setSeType(rc.se_type || 'cluster')
    setCluster1((rc.cluster_vars || [])[0] || null)
    setCluster2((rc.cluster_vars || [])[1] || null)
    setParams(rc.params || {})
    setRecApplied(true)
    setResult(null)
  }
  // 当前页面上的设定。篮子里每一列存的就是这一份快照，所以各列可以
  // 有各自的因变量/控制变量/标准误——机制检验、换被解释变量的稳健性，
  // 都是这样并排列进同一张表的。
  const currentConfig = () => ({
    y_var: yVar, core_x: coreX, controls,
    id_var: idVar, time_var: timeVar, absorb,
    se_type: seType,
    cluster_vars: [cluster1, cluster2].filter(Boolean),
    ...params,
  })

  const needsCore = () => {
    const specs = paramSpecs[method] || []
    // DID / 交错采纳这几类自己构造处理指示变量，不需要核心解释变量
    return !(STAGGERED.includes(method) || specs.some(p => p.name === 'treat_var'))
  }

  // 增删列后重新编号成 (1)(2)(3)——论文表格不会出现 (1)(3)(4)
  const basketSet = (fn) => setBasket(b => fn(b).map((m, i) => ({ ...m, label: `(${i + 1})` })))

  const handleRun = async () => {
    if (!yVar) { message.warning('请选择因变量'); return }
    if (needsCore() && !coreX.length) {
      message.warning('请选择核心解释变量'); return
    }
    setLoading(true)
    try {
      const res = await regressionAPI.run(method, currentConfig())
      setResult(res.data)
    } catch (e) {
      message.error('回归失败')
    }
    setLoading(false)
  }

  // ── 多模型对照表（esttab）──

  const addToBasket = () => {
    if (!yVar) { message.warning('请先选择因变量'); return }
    if (needsCore() && !coreX.length) {
      message.warning('请先选择核心解释变量'); return
    }
    const label = `(${basket.length + 1})`
    setBasket(b => [...b, { id: Date.now(), label, method, config: currentConfig() }])
    message.success(`已加入对照表 ${label}`)
  }

  const moveItem = (i, d) => basketSet(b => {
    const j = i + d
    if (j < 0 || j >= b.length) return b
    const c = [...b]
    const t = c[i]; c[i] = c[j]; c[j] = t
    return c
  })

  const renameRow = (rawName, newName) => {
    setRowAliases(a => {
      const next = { ...a }
      if (!newName || newName === rawName) delete next[rawName]
      else next[rawName] = newName
      return next
    })
    setEditingRow(null)
  }

  const runEsttab = async (models) => {
    const list = models || basket
    if (!list.length) {
      message.warning('篮子还是空的：先「加入对照表」，或点「一键跑基准序列」');
      return
    }
    setEstLoading(true)
    try {
      const r = await regressionAPI.esttab({
        models: list.map(m => ({ label: m.label, method: m.method, config: m.config })),
        row_aliases: rowAliases,
      })
      if (r.data.error) { message.error(r.data.error); setMatrix(null) }
      else { setMatrix(r.data); setActiveTab('multi') }
    } catch (e) {
      message.error('生成对照表失败')
    }
    setEstLoading(false)
  }

  // 基准序列：无控制 → 加控制 → 个体 FE → 双向 FE → 双 FE + 聚类。
  // 规则在后端(_esttab.standard_sequence)，前端只负责发起和入篮。
  const applyStandardSequence = async () => {
    if (!yVar) { message.warning('请先选择因变量'); return }
    setEstLoading(true)
    try {
      const r = await regressionAPI.standardSequence(currentConfig())
      const models = (r.data.models || []).map((m, i) => ({ id: Date.now() + i, ...m }))
      setBasket(models)
      setMatrix(null)
      message.success(`已生成 ${models.length} 列基准序列，正在计算…`)
      await runEsttab(models)
    } catch (e) {
      message.error('生成基准序列失败')
    }
    setEstLoading(false)
  }

  const exportEsttab = async (fmt) => {
    if (!matrix) return
    try {
      const r = await exportAPI.esttab(
        fmt, matrix,
        `多模型对照表_${(matrix.columns && matrix.columns[0] && matrix.columns[0].dep_var) || ''}`,
        rowMode)
      if (r.data && r.data.url) {
        window.open(r.data.url, '_blank')
        message.success(`已导出 ${r.data.name}`)
      } else {
        message.error((r.data && r.data.error) || '导出失败')
      }
    } catch (e) {
      message.error(e.response?.data?.error || '导出失败')
    }
  }

  const handleExport = async (fmt) => {
    if (!result) return
    try {
      await exportAPI.create({
        name: `${result.method_key || 'reg'}.${fmt === 'word' ? 'docx' : fmt}`,
        format: fmt, content: JSON.stringify(result, null, 2),
        source: result.method || '',
      })
      message.success('已加入结果输出')
    } catch (e) { message.error('导出失败') }
  }

  const columns = (result?.coefficients || []).length
    ? [
        {
          title: '变量', dataIndex: 'variable', key: 'variable', width: 220,
          render: (v, r) => (
            <span style={{ fontWeight: r.role === 'core' ? 700 : 400 }}>
              {v}
              {r.role === 'core' && <Tag color="geekblue" style={{ marginLeft: 6, fontSize: 10 }}>核心</Tag>}
              {r.role === 'stat' && <Tag style={{ marginLeft: 6, fontSize: 10 }}>统计量</Tag>}
            </span>
          ),
        },
        { title: '系数', dataIndex: 'coef', key: 'coef', align: 'right',
          render: v => v === null || v === undefined ? '—' : Number(v).toFixed(4) },
        { title: '标准误', dataIndex: 'std_err', key: 'std_err', align: 'right',
          render: v => v === null || v === undefined ? '—' : Number(v).toFixed(4) },
        { title: 't / z', dataIndex: 't', key: 't', align: 'right',
          render: v => v === null || v === undefined ? '—' : Number(v).toFixed(3) },
        {
          title: 'P>|t|', dataIndex: 'p', key: 'p', align: 'right',
          render: v => v === null || v === undefined ? '—' : (Number(v) < 0.001 ? '0.000' : Number(v).toFixed(4)),
        },
        {
          title: '显著性', dataIndex: 'stars', key: 'stars', align: 'center',
          render: (v, r) => (
            <span style={{ color: r.p < 0.05 ? '#16a34a' : r.p < 0.1 ? '#f59e0b' : '#94a3b8',
                           fontWeight: 700 }}>
              {v || ''}
            </span>
          ),
        },
      ]
    : []

// ── 多模型对照表 ──
// 表头三行：列号 / 被解释变量 / 方法。被解释变量必须出现在表头，
// 这是论文回归表的通行排法，也是各列因变量可以不同的前提。
const renderEsttab = () => {
  const m = matrix
  if (estLoading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  }
  if (!m) {
    return <Empty description={
      basket.length
        ? '点「生成对照表」把篮子里的列并成一张表'
        : '篮子为空：先「加入对照表」，或用「一键跑基准序列」'
    } style={{ padding: 80 }} />
  }
  if (m.error) return <div style={{ color: '#f43f5e', padding: 24 }}>❌ {m.error}</div>

  const cols = m.columns || []
  const rows = filterRows(m.rows || [], rowMode)

  const cellText = (cell, isVar) => {
    if (!cell) return null
    if ('value' in cell) return <span>{cell.value}</span>
    const coef = cell.coef == null ? '' : Number(cell.coef).toFixed(4)
    const se = cell.se == null ? null : `(${Number(cell.se).toFixed(4)})`
    return (
      <div style={{ lineHeight: 1.35 }}>
        <span style={{ fontWeight: cell.p != null && cell.p < 0.05 ? 700 : 400 }}>
          {coef}
          {cell.stars ? <sup style={{ color: '#16a34a' }}>{cell.stars}</sup> : null}
        </span>
        {isVar && se ? <div style={{ color: '#64748b' }}>{se}</div> : null}
      </div>
    )
  }

  const columns = [
    {
      title: '', dataIndex: 'name', key: 'name', width: 190, fixed: 'left',
      render: (v, r) => {
        const editing = editingRow === r.raw_name
        if (!editing) {
          return (
            <span style={{ fontWeight: r.kind === 'core' ? 700 : 400 }}>
              {v}
              {r.kind === 'core' && (
                <Tooltip title="改名：不同列里同一概念叫不同名字时，改成一致就能并到一行">
                  <EditOutlined style={{ marginLeft: 6, color: '#94a3b8', fontSize: 11 }}
                    onClick={() => setEditingRow(r.raw_name)} />
                </Tooltip>
              )}
            </span>
          )
        }
        return (
          <Input size="small" defaultValue={v} autoFocus
            onPressEnter={e => renameRow(r.raw_name, e.target.value.trim())}
            onBlur={e => renameRow(r.raw_name, e.target.value.trim())} />
        )
      },
    },
    ...cols.map((c, j) => ({
      title: (
        <div style={{ lineHeight: 1.4 }}>
          <div style={{ fontWeight: 700 }}>{c.label}</div>
          <div style={{ fontWeight: 600 }}>{c.dep_var}</div>
          <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>{c.method}</div>
        </div>
      ),
      key: 'c' + j, align: 'right', width: 132,
      render: (_, r) => {
        if (c.error) return <span style={{ color: '#f43f5e' }}>失败</span>
        return cellText((r.cells || [])[j], r.kind !== 'spec' && r.kind !== 'stat')
      },
    })),
  ]

  const data = [
    ...rows.map((r, i) => ({ ...r, key: 'r' + i })),
    ...(m.spec_rows || []).map((r, i) => ({ ...r, key: 's' + i })),
    ...(m.stat_rows || []).map((r, i) => ({ ...r, key: 't' + i })),
  ]

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center',
                    flexWrap: 'wrap' }}>
        <Radio.Group value={rowMode} onChange={e => setRowMode(e.target.value)} size="small">
          <Radio.Button value="core">只看核心变量</Radio.Button>
          <Radio.Button value="core_const">核心 + 常数项</Radio.Button>
          <Radio.Button value="all">全部系数</Radio.Button>
        </Radio.Group>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          行名旁的铅笔可改名，把不同列里同一概念并到一行
        </span>
      </div>

      <Table
        columns={columns}
        dataSource={data}
        pagination={false}
        size="small"
        bordered
        style={{ marginBottom: 16 }}
        scroll={{ x: 'max-content' }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={cols.length + 1}>
                <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.8 }}>
                  注：括号内为该列标准误；*** p&lt;0.01，** p&lt;0.05，* p&lt;0.1。
                  {cols.filter(c => c.error).length
                    ? `其中 ${cols.filter(c => c.error).length} 列运行失败，详见表下方说明。`
                    : ''}
                </div>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />

      {(m.notes || []).length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16, borderRadius: 8 }}
          message="合并前必须知道的几件事"
          description={<div>
            {m.notes.map((n, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.9 }}>{n}</div>
            ))}
          </div>} />
      )}

      <Space wrap>
        <Button icon={<DownloadOutlined />} onClick={() => exportEsttab('esttab_tex')}>
          导出 LaTeX（booktabs）
        </Button>
        <Button icon={<DownloadOutlined />} onClick={() => exportEsttab('esttab_docx')}>
          导出 Word
        </Button>
        <Button icon={<DownloadOutlined />} onClick={() => exportEsttab('esttab_xlsx')}>
          导出 Excel
        </Button>
      </Space>

      <Card size="small" title="各列等价的 Stata 命令" style={{ marginTop: 16 }}>
        {cols.map((c, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: '#64748b' }}>
              {c.label} ｜ {c.dep_var} ｜ {c.method}
            </div>
            <pre style={{
              background: '#0f172a', color: '#e2e8f0', padding: 10, borderRadius: 6,
              fontSize: 11, overflow: 'auto', margin: '4px 0 0', lineHeight: 1.6,
            }}>
              {c.stata_code || '（该方法不生成 Stata 命令）'}</pre>
          </div>
        ))}
      </Card>
    </div>
  )
}

  return (
    <div style={{ padding: 32 }}>
      {/* 推荐方案横幅 */}
      {rec && rec.available && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20, borderRadius: 10 }}
          message={
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                            marginBottom: rec.reasons ? 8 : 0 }}>
                <span style={{ fontWeight: 600 }}>推荐方案</span>
                <Tag color="blue">{rec.method_label}</Tag>
                {rec.confidence === 'high'
                  ? <Tag color="green">置信度高</Tag>
                  : <Tag color="orange">供参考</Tag>}
                <Button type="primary" size="small" icon={<ThunderboltOutlined />}
                  onClick={() => applyRecommendation(rec)}
                  disabled={recApplied && method === rec.method}>
                  {recApplied ? '已套用（可继续修改）' : '一键套用推荐设定'}
                </Button>
              </div>
              {rec.reasons?.length > 0 && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: '#475569' }}>
                  {rec.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </div>
          }
        />
      )}

      {profile?.structure && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20, borderRadius: 10 }}
          message={
            <Space wrap>
              <span style={{ fontWeight: 600 }}>
                检测到{profile.structure === 'panel' ? '面板数据' : profile.structure === 'time_series' ? '时间序列' : '截面数据'}
              </span>
              <Tag color="blue">{profile.rows} 行 × {profile.cols} 列</Tag>
              {profile.structure_detail?.n_entities && (
                <Tag>N={profile.structure_detail.n_entities}, T={profile.structure_detail.n_periods}</Tag>
              )}
              {profile.structure_detail?.id_var && (
                <Tag>个体: {profile.structure_detail.id_var}, 时间: {profile.structure_detail.time_var}</Tag>
              )}
            </Space>
          }
        />
      )}

      {/* 交错采纳警告：TWFE 类估计量在此情形下不可解释 */}
      {staggered?.is_staggered && !staggered.twfe_reliable &&
        ['did', 'event_study', 'twoway_fe', 'fe'].includes(method) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 20, borderRadius: 10 }}
          message="检测到交错采纳处理，当前方法的 TWFE 系数不可解释"
          description={
            <div>
              <div style={{ marginBottom: 8 }}>{staggered.reason}</div>
              <Space wrap size={[6, 6]}>
                <span style={{ fontSize: 12, color: '#475569' }}>建议改用：</span>
                {['csdid', 'sunab', 'did2s', 'bacon'].map(k => {
                  const g = catalog.find(gg => gg.methods.some(m => m.key === k))
                  const mm = g?.methods.find(m => m.key === k)
                  return (
                    <Tag key={k} color="blue" style={{ cursor: 'pointer' }}
                      onClick={() => { if (g) { setGroup(g.group); switchMethod(k) } }}>
                      {mm?.label || k}
                    </Tag>
                  )
                })}
                <Tag color="magenta" style={{ cursor: 'pointer' }}
                  onClick={() => { const g = catalog.find(gg => gg.methods.some(m => m.key === 'bacon'));
                                   if (g) { setGroup(g.group); switchMethod('bacon') } }}>
                  先用 Bacon 分解看 TWFE 被什么污染
                </Tag>
              </Space>
              {staggered.cohort_table?.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 11, color: '#64748b' }}>
                  处理时点变量 <b>{staggered.cohort_var}</b> 共 {staggered.n_cohorts} 个队列；
                  从未处理占 {(staggered.never_treated_share * 100).toFixed(1)}%；
                  最小队列 {Math.min(...staggered.cohort_table.map(c => c.n_obs))} 个观测。
                </div>
              )}
            </div>
          }
        />
      )}

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* 左侧：方法 + 变量设置 */}
        <div style={{ width: 340, flexShrink: 0 }}>
          <Alert type="info" showIcon style={{ marginBottom: 12, borderRadius: 8 }}
            message={<span style={{ fontWeight: 600 }}>{stageInfo.title}</span>}
            description={<span style={{ fontSize: 12, color: '#475569', lineHeight: 1.6 }}>{stageInfo.desc}</span>} />
          <Card title="回归方法" size="small" style={{ marginBottom: 16 }}>
            <Steps
              direction="vertical" size="small" current={visibleGroups.findIndex(g => g.group === group)}
              items={visibleGroups.map(g => ({ title: g.group }))}
              onChange={undefined}
              style={{ display: 'none' }}
            />
            <Select style={{ width: '100%', marginBottom: 10 }} size="small"
              value={group} onChange={switchGroup}
              options={visibleGroups.map(g => ({ label: `${g.group}（${g.methods.length}）`, value: g.group }))} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(currentGroup?.methods || []).map(m => (
                <Tooltip key={m.key} title={m.desc} placement="right">
                  <div onClick={() => switchMethod(m.key)}
                    style={{
                      padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      background: method === m.key ? '#eef2ff' : 'transparent',
                      color: method === m.key ? '#4f46e5' : '#475569',
                      fontWeight: method === m.key ? 600 : 400,
                      border: method === m.key ? '1px solid #c7d2fe' : '1px solid transparent',
                    }}>
                    {m.icon} {m.label}
                  </div>
                </Tooltip>
              ))}
            </div>
            {currentGroup?.hint && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
                💡 {currentGroup.hint}
              </div>
            )}
          </Card>

          <Card title="变量设置" size="small" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 500 }}>
                因变量 (Y)
              </div>
              <Select value={yVar} onChange={setYVar} style={{ width: '100%' }}
                placeholder="选择因变量" size="small" showSearch allowClear
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 500 }}>
                核心解释变量 (X)
              </div>
              <Select mode="multiple" value={coreX} onChange={setCoreX} style={{ width: '100%' }}
                placeholder="选择核心解释变量" size="small" showSearch allowClear
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 500 }}>
                控制变量 (Controls)
              </div>
              <Select mode="multiple" value={controls} onChange={setControls}
                style={{ width: '100%' }} placeholder="选择控制变量（可多选）" size="small"
                showSearch allowClear
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>

            {needsPanel && (
              <>
                <Divider style={{ margin: '8px 0' }} />
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 500 }}>
                  面板结构
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <Select value={idVar} onChange={setIdVar} style={{ flex: 1 }}
                    placeholder="个体变量" size="small" showSearch allowClear
                    options={variables.map(v => ({ label: v, value: v }))} />
                  <Select value={timeVar} onChange={setTimeVar} style={{ flex: 1 }}
                    placeholder="时间变量" size="small" showSearch allowClear
                    options={variables.map(v => ({ label: v, value: v }))} />
                </div>
              </>
            )}

            {(method === 'fe' || method === 'te' || method === 'twoway_fe') && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 500 }}>
                  高维固定效应（可选）
                </div>
                <Select mode="multiple" value={absorb} onChange={setAbsorb} style={{ width: '100%' }}
                  placeholder="如行业、省份、省份×年份" size="small" showSearch allowClear
                  options={variables.map(v => ({ label: v, value: v }))} />
              </div>
            )}
          </Card>

          <Card title="标准误与聚类" size="small" style={{ marginBottom: 16 }}>
            <Radio.Group value={seType} onChange={e => setSeType(e.target.value)}
              style={{ marginBottom: 12 }}>
              <Space direction="vertical">
                {SE_OPTIONS.map(o => <Radio key={o.value} value={o.value}>{o.label}</Radio>)}
              </Space>
            </Radio.Group>
            {seType === 'cluster' && (
              <Row gutter={8}>
                <Col span={12}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>聚类层级 1</div>
                  <Select value={cluster1} onChange={setCluster1} style={{ width: '100%' }}
                    placeholder="必选" size="small" showSearch allowClear
                    options={variables.map(v => ({ label: v, value: v }))} />
                </Col>
                <Col span={12}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                    聚类层级 2（选填）
                  </div>
                  <Select value={cluster2} onChange={setCluster2} style={{ width: '100%' }}
                    placeholder="选填→双聚类" size="small" showSearch allowClear
                    options={variables.map(v => ({ label: v, value: v }))} />
                </Col>
              </Row>
            )}
            {seType === 'cluster' && cluster1 && cluster2 && (
              <Alert type="success" style={{ marginTop: 10, borderRadius: 6 }}
                message={`将按 ${cluster1} + ${cluster2} 双聚类计算标准误`} showIcon />
            )}
          </Card>

          {/* 方法专属参数 */}
          {(paramSpecs[method] || []).length > 0 && (
            <Card title={`${currentMethod?.label || ''} · 参数`} size="small"
              style={{ marginBottom: 16 }}>
              {(paramSpecs[method] || []).map(s => (
                <div key={s.name} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4,
                                display: 'flex', alignItems: 'center', gap: 4 }}>
                    {s.label}
                    {s.hint && (
                      <Tooltip title={s.hint}>
                        <InfoCircleOutlined style={{ color: '#94a3b8', fontSize: 11 }} />
                      </Tooltip>
                    )}
                  </div>
                  <ParamField spec={s} value={params[s.name]}
                    onChange={v => setParams(p => ({ ...p, [s.name]: v }))}
                    variables={variables} />
                </div>
              ))}
            </Card>
          )}

          <Button type="primary" icon={<PlayCircleOutlined />} block size="large"
            onClick={handleRun} loading={loading}>
            运行回归
          </Button>
          <Button icon={<PlusCircleOutlined />} block size="large" style={{ marginTop: 8 }}
            onClick={addToBasket} disabled={!yVar}>
            加入对照表（eststo）
          </Button>

          <Card size="small" style={{ marginTop: 16 }}
            title={<Space>模型篮子
              <Tag color={basket.length ? 'blue' : 'default'}>{basket.length} 列</Tag>
            </Space>}
            extra={basket.length ? (
              <Popconfirm title="清空篮子？" onConfirm={() => { setBasket([]); setMatrix(null) }}>
                <Button size="small" type="text" danger>清空</Button>
              </Popconfirm>
            ) : null}>
            {!basket.length ? (
              <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.8 }}>
                每调好一列点一次「加入对照表」，最后一起出表。<br />
                也可以直接「一键跑基准序列」。
              </div>
            ) : (
              <>
                {basket.map((m, i) => (
                  <div key={m.id} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0',
                    borderTop: i ? '1px dashed #e2e8f0' : 'none',
                  }}>
                    <Tag color="geekblue" style={{ margin: 0, minWidth: 30, textAlign: 'center' }}>
                      {m.label}
                    </Tag>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600,
                                    overflow: 'hidden', textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap' }}>
                        {m.config.y_var}
                      </div>
                      <div style={{ fontSize: 10, color: '#94a3b8' }}>
                        {(catalog.flatMap(g => g.methods).find(x => x.key === m.method)
                          || {}).label || m.method}
                      </div>
                    </div>
                    <Space size={0}>
                      <Button size="small" type="text" icon={<ArrowUpOutlined />}
                        disabled={i === 0} onClick={() => moveItem(i, -1)} />
                      <Button size="small" type="text" icon={<ArrowDownOutlined />}
                        disabled={i === basket.length - 1} onClick={() => moveItem(i, 1)} />
                      <Button size="small" type="text" danger icon={<DeleteOutlined />}
                        onClick={() => basketSet(b => b.filter(x => x.id !== m.id))} />
                    </Space>
                  </div>
                ))}
                <Button type="primary" block style={{ marginTop: 12 }}
                  icon={<TableOutlined />} loading={estLoading}
                  onClick={() => runEsttab()}>
                  生成对照表
                </Button>
              </>
            )}
          </Card>

          <Button block size="large" style={{ marginTop: 8 }}
            icon={<ThunderboltOutlined />} loading={estLoading}
            onClick={applyStandardSequence}>
            一键跑基准序列
          </Button>
        </div>

        {/* 右侧：结果 */}
        <div style={{ flex: 1, minWidth: 0 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          { key: 'single', label: '单次结果',
            children: (
          <Card size="small">
            {loading ? (
              <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
            ) : !result ? (
              <Empty description={
                rec ? '点击「一键套用推荐设定」后直接运行，或手动选择方法与变量' : '请选择方法与变量'
              } style={{ padding: 80 }} />
            ) : result.error ? (
              <div style={{ color: '#f43f5e', padding: 24, fontSize: 13 }}>
                ❌ {result.error}
              </div>
            ) : (
              <div>
                {/* 标题与关键统计 */}
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700 }}>
                    {result.method}
                  </h3>
                  <Space wrap size={[6, 6]}>
                    <Tag color="blue">因变量: {result.dep_var}</Tag>
                    <Tag>N = {result.nobs?.toLocaleString()}</Tag>
                    {result.n_entities && <Tag>个体 = {result.n_entities.toLocaleString()}</Tag>}
                    {result.n_periods && <Tag>时间 = {result.n_periods}</Tag>}
                    <Tag color="purple">{result.se_type}</Tag>
                    {result.r_squared != null && <Tag color="green">R² = {result.r_squared}</Tag>}
                    {result.within_r_squared != null &&
                      <Tag color="green">Within R² = {result.within_r_squared}</Tag>}
                    {result.f_stat != null &&
                      <Tag>F = {result.f_stat} (p = {result.f_pvalue?.toFixed?.(4) ?? result.f_pvalue})</Tag>}
                  </Space>
                </div>

                {/* 核心效应卡片 */}
                {(result.att || result.rd_effect) && (
                  <Card size="small" style={{ marginBottom: 16, background: '#f5f3ff',
                                               borderColor: '#ddd6fe' }}>
                    <Row gutter={24}>
                      {[
                        { label: '估计值', value: (result.att || result.rd_effect).estimate,
                          big: true },
                        { label: '标准误', value: (result.att || result.rd_effect).std_err },
                        { label: 't / z', value: (result.att || result.rd_effect).t },
                        { label: 'P 值', value: (result.att || result.rd_effect).p },
                      ].map((it, i) => (
                        <Col span={6} key={i}>
                          <div style={{ fontSize: 11, color: '#7c3aed' }}>{it.label}</div>
                          <div style={{ fontSize: it.big ? 22 : 16, fontWeight: 700,
                                        color: '#1e293b' }}>
                            {it.value == null ? '—' : Number(it.value).toFixed(4)}
                            {it.big && <span style={{ color: '#16a34a', marginLeft: 4 }}>
                              {(result.att || result.rd_effect).stars}
                            </span>}
                          </div>
                        </Col>
                      ))}
                    </Row>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#6d28d9' }}>
                      {(result.att || result.rd_effect).interpretation}
                      {result.rd_effect?.bandwidth &&
                        ` ｜ 带宽 h = ${result.rd_effect.bandwidth}，${result.rd_effect.kernel}核，` +
                        `${result.rd_effect.poly_order} 阶`}
                    </div>
                  </Card>
                )}

                {/* 系数表 */}
                <Table
                  columns={columns}
                  dataSource={(result.coefficients || []).map((c, i) => ({ ...c, key: i }))}
                  pagination={false} size="small" style={{ marginBottom: 16 }}
                  summary={pageData => {
                    if (!pageData.length) return null
                    return (
                      <Table.Summary fixed>
                        <Table.Summary.Row>
                          <Table.Summary.Cell index={0}>
                            <Text type="secondary">注：*** p&lt;0.01，** p&lt;0.05，* p&lt;0.1；
                              {result.se_type}。绿色为核心解释变量。</Text>
                          </Table.Summary.Cell>
                          <Table.Summary.Cell index={1} colSpan={5} />
                        </Table.Summary.Row>
                      </Table.Summary>
                    )
                  }}
                />

                {/* Stata 代码 */}
                <Card size="small" title="等价的 Stata 命令" style={{ marginBottom: 16 }}>
                  <pre style={{
                    background: '#0f172a', color: '#e2e8f0', padding: 14, borderRadius: 8,
                    fontSize: 12, overflow: 'auto', margin: 0, lineHeight: 1.7,
                  }}>
                    {result.stata_code}
                  </pre>
                </Card>

                {/* 平行趋势检验 */}
                {result.parallel_trend_test && (
                  <Card size="small" title="平行趋势假设检验" style={{ marginBottom: 16 }}>
                    <Alert
                      type={result.parallel_trend_test.verdict === '通过' ? 'success' : 'warning'}
                      showIcon style={{ marginBottom: 12 }}
                      message={result.parallel_trend_test.message} />
                    <Table size="small" pagination={false}
                      dataSource={(result.events || []).map(e => ({ ...e, key: e.period }))}
                      columns={[
                        { title: '事件期', dataIndex: 'period', key: 'period',
                          render: v => `t${v >= 0 ? '+' : ''}${v}` },
                        { title: '系数', dataIndex: 'coef', key: 'coef', align: 'right',
                          render: v => v == null ? '—' : Number(v).toFixed(4) },
                        { title: '标准误', dataIndex: 'std_err', key: 'std_err', align: 'right',
                          render: v => v == null ? '—' : Number(v).toFixed(4) },
                        { title: '95% CI', key: 'ci',
                          render: (_, r) => `[${r.ci_low ?? '—'}, ${r.ci_high ?? '—'}]` },
                        { title: 'P 值', dataIndex: 'p', key: 'p', align: 'right',
                          render: v => v == null ? '—' : (v < 0.001 ? '0.000' : Number(v).toFixed(4)) },
                        { title: '', dataIndex: 'stars', key: 'stars', align: 'center',
                          render: v => <b style={{ color: '#16a34a' }}>{v}</b> },
                      ]} />
                    {result.dynamic_effect && (
                      <Paragraph style={{ marginTop: 10, marginBottom: 0, fontSize: 12,
                                          color: '#475569' }}>
                        {result.dynamic_effect.summary}
                      </Paragraph>
                    )}
                  </Card>
                )}

                {/* 第一阶段 */}
                {result.first_stage && (
                  <Card size="small" title="第一阶段回归" style={{ marginBottom: 16 }}>
                    {Object.entries(result.first_stage).map(([k, v]) => (
                      <Alert key={k} type={v.weak_iv?.includes('不存在') ? 'success' : 'warning'}
                        showIcon style={{ marginBottom: 8 }}
                        message={`${k}: F = ${v.f_stat}，p = ${v.f_pvalue} — ${v.weak_iv}`} />
                    ))}
                  </Card>
                )}

                {/* 诊断信息 */}
                {[
                  { key: 'threshold_value', title: '门槛效应' },
                  { key: 'selection_test', title: '选择性偏误检验' },
                  { key: 'ar_tests', title: '扰动项自相关检验' },
                  { key: 'common_support', title: '共同支撑' },
                  { key: 'match_setting', title: '匹配设置' },
                ].filter(x => result[x.key]).map(x => (
                  <Card size="small" title={x.title} key={x.key} style={{ marginBottom: 16 }}>
                    <DescriptionsWrap data={result[x.key]} />
                  </Card>
                ))}

                {/* 合成控制 */}
                {result.donor_weights?.length > 0 && (
                  <Card size="small" title="对照单位权重" style={{ marginBottom: 16 }}>
                    <Table size="small" pagination={false}
                      dataSource={result.donor_weights.map((d, i) => ({ ...d, key: i }))}
                      columns={[
                        { title: '对照单位', dataIndex: 'unit', key: 'unit' },
                        { title: '权重', dataIndex: 'weight', key: 'weight', align: 'right',
                          render: v => Number(v).toFixed(4) },
                        { title: '占比', key: 'pct', align: 'right',
                          render: (_, r) => `${(r.weight * 100).toFixed(1)}%` },
                      ]} />
                    <div style={{ marginTop: 10, fontSize: 12, color: '#475569' }}>
                      政策前 MSPE = {result.pre_mspe}，政策后 MSPE = {result.post_mspe}，
                      MSPE 比率 = {result.mspe_ratio}，安慰剂检验 p = {result.placebo_p}
                    </div>
                  </Card>
                )}

                {/* 备注与说明 */}
                {result.absorbed?.length > 0 && (
                  <Card size="small" title="固定效应吸收说明" style={{ marginBottom: 16 }}>
                    {result.absorbed.map((a, i) =>
                      <div key={i} style={{ fontSize: 12, color: '#475569' }}>• {a}</div>)}
                  </Card>
                )}
                {result.notes?.length > 0 && (
                  <Card size="small" title="模型说明与注意事项" style={{ marginBottom: 16 }}>
                    {result.notes.map((a, i) =>
                      <div key={i} style={{ fontSize: 12, color: '#475569', lineHeight: 1.9 }}>
                        {i + 1}. {a}
                      </div>)}
                  </Card>
                )}

                {/* Bacon / staggered 判定 */}
                {result.verdict && (
                  <Card size="small" style={{ marginBottom: 16 }}>
                    <Alert
                      type={result.verdict.message?.includes('基本可解释') ? 'success' : 'warning'}
                      showIcon
                      style={{ marginBottom: result.forbidden_share != null ? 12 : 0 }}
                      message={result.verdict.message} />
                    <Row gutter={16}>
                      {result.twfe_coef != null && (
                        <Col span={6}>
                          <div style={{ fontSize: 11, color: '#64748b' }}>TWFE 系数</div>
                          <div style={{ fontSize: 18, fontWeight: 700 }}>{result.twfe_coef}</div>
                        </Col>
                      )}
                      {result.forbidden_share != null && (
                        <Col span={6}>
                          <div style={{ fontSize: 11, color: '#64748b' }}>forbidden 权重占比</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>
                            {(result.forbidden_share * 100).toFixed(1)}%
                          </div>
                        </Col>
                      )}
                      {result.estimate_dispersion && (
                        <Col span={12}>
                          <div style={{ fontSize: 11, color: '#64748b' }}>2×2 估计离散度</div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>
                            {result.estimate_dispersion.min} ~ {result.estimate_dispersion.max}
                            <span style={{ color: '#f43f5e', marginLeft: 6 }}>
                              （极差 {result.estimate_dispersion.spread}）
                            </span>
                          </div>
                        </Col>
                      )}
                    </Row>
                  </Card>
                )}

                {/* 队列级 / 动态效应表 */}
                {result.extra_tables?.cohort?.length > 0 && (
                  <Card size="small" title={`各队列 ATT（${result.cohort_var}）`}
                    style={{ marginBottom: 16 }}>
                    <Table size="small" pagination={false}
                      dataSource={result.extra_tables.cohort.map((c, i) => ({ ...c, key: i }))}
                      columns={[
                        { title: '队列', dataIndex: 'g', key: 'g',
                          render: v => <b>{v}</b> },
                        { title: 'ATT', dataIndex: 'att', key: 'att', align: 'right',
                          render: v => v == null ? '—' : Number(v).toFixed(4) },
                        { title: '标准误', dataIndex: 'se', key: 'se', align: 'right',
                          render: v => v == null ? '—' : Number(v).toFixed(4) },
                        { title: '企业/观测数', dataIndex: 'n_units', key: 'n_units',
                          align: 'right', render: (v, r) => v ?? r.n_g ?? '—' },
                        { title: '覆盖期', dataIndex: 't_max', key: 't_max', align: 'right',
                          render: (v, r) => r.t_min != null ? `${r.t_min}–${v}` : '—' },
                      ]} />
                  </Card>
                )}

                {result.cohort_table?.length > 0 && (
                  <Card size="small" title={`各队列 DID（${result.cohort_var}）`}
                    style={{ marginBottom: 16 }}>
                    <Table size="small" pagination={false}
                      dataSource={result.cohort_table.map((c, i) => ({ ...c, key: i }))}
                      columns={[
                        { title: '队列', dataIndex: 'g', key: 'g', render: v => <b>{v}</b> },
                        { title: 'DID', dataIndex: 'att', key: 'att', align: 'right',
                          render: v => v == null ? '—' : Number(v).toFixed(4) },
                        { title: '标准误', dataIndex: 'se', key: 'se', align: 'right',
                          render: v => v == null ? '—' : Number(v).toFixed(4) },
                        { title: '观测数', dataIndex: 'n_units', key: 'n_units', align: 'right' },
                      ]} />
                  </Card>
                )}

                <Space>
                  <Button icon={<DownloadOutlined />} onClick={() => handleExport('word')}>导出 Word</Button>
                  <Button icon={<DownloadOutlined />} onClick={() => handleExport('latex')}>导出 LaTeX</Button>
                  <Button icon={<DownloadOutlined />} onClick={() => handleExport('excel')}>导出 Excel</Button>
                </Space>
              </div>
            )}
          </Card>
            ),
          },
          { key: 'multi', label: <Space>多模型对照表
              {matrix ? <Tag color="blue">{matrix.n_cols} 列</Tag> : null}
            </Space>,
            children: (
          <Card size="small">{renderEsttab()}</Card>
            ),
          },
        ]} />
        </div>
      </div>
    </div>
  )
}

// 与后端 _esttab.ROW_MODES 保持一致：core / core_const / all
function filterRows(rows, mode) {
  if (mode === 'all') return rows
  if (mode === 'core_const') return rows.filter(r => r.kind === 'core' || r.kind === 'const')
  return rows.filter(r => r.kind === 'core')
}

function DescriptionsWrap({ data }) {
  if (data == null) return null
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined)
  if (!entries.length) return null
  return (
    <Row gutter={[12, 10]}>
      {entries.map(([k, v], i) => (
        <Col span={8} key={i}>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {({ placebo_p: '安慰剂 p 值', imr_coef: 'IMR 系数', imr_se: 'IMR 标准误',
                verdict: '结论', note: '说明', rho: '残差自相关系数', ar2_p: 'AR(2) p 值',
                overlap_ok: '共同支撑成立', min_ps_treated: '处理组最小 PS',
                max_ps_treated: '处理组最大 PS', min_ps_control: '对照组最小 PS',
                max_ps_control: '对照组最大 PS', method: '方法', k: '匹配个数',
                caliper: '卡尺', covariates: '协变量' })[k] || k}
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all' }}>
            {typeof v === 'boolean' ? (v ? '是' : '否')
              : typeof v === 'number' ? (Math.abs(v) < 1e-4 ? v.toExponential(2) : v)
              : Array.isArray(v) ? v.join(', ')
              : typeof v === 'object' ? JSON.stringify(v)
              : String(v)}
          </div>
        </Col>
      ))}
    </Row>
  )
}
