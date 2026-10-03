import React, { useState, useEffect } from 'react'
import { Card, Row, Col, Select, Button, Table, Checkbox, Radio, Space, Spin, message,
         Tabs, Alert, Steps, Tag, Divider, Tooltip, Popover } from 'antd'
import { PlayCircleOutlined, DownloadOutlined, ThunderboltOutlined, CheckCircleOutlined,
         WarningOutlined } from '@ant-design/icons'
import { analysisAPI, dataAPI, exportAPI, profileAPI } from '../api'

// 每个方法自己声明需要哪些变量字段。早期版本所有方法共用「因变量 + 自变量」，
// 描述统计和交叉表拿到的是残缺参数，交叉表实际读的是 x_vars[0] 和 y_var。
const STAT_METHODS = [
  { key: 'descriptive', label: '描述性统计', icon: '📊', group: '统计',
    fields: ['vars'],
    desc: '均值 / 标准差 / 四分位 / 极值' },
  { key: 'cross_tab', label: '交叉表分析', icon: '📋', group: '统计',
    fields: ['cat', 'cat2'],
    desc: '两个分类变量的频数表 + 卡方独立性检验' },
  { key: 'correlation', label: '相关性分析', icon: '🔗', group: '统计',
    fields: ['vars'],
    desc: 'Pearson 相关系数矩阵' },
  { key: 'hypothesis_test', label: '假设检验', icon: '⚖️', group: '统计',
    fields: ['y', 'test_kind', 'test_value', 'group_var'],
    desc: '单样本 t 检验，或两组均值比较' },
  { key: 'anova', label: '方差分析', icon: '⚡', group: '统计',
    fields: ['y', 'group_var'],
    desc: '多组均值是否相等（单因素 ANOVA）' },
  { key: 'linear_regression', label: '线性回归', icon: '📈', group: '回归',
    fields: ['y', 'x', 'se'],
    desc: 'OLS，可选稳健或聚类标准误' },
  { key: 'panel_regression', label: '面板固定效应', icon: '📊', group: '回归',
    fields: ['y', 'x', 'panel', 'se'],
    desc: '个体/双向固定效应，需要指定个体与时间变量' },
  { key: 'hausman', label: '豪斯曼检验', icon: '⚖️', group: '回归',
    fields: ['y', 'x', 'panel', 'se'],
    desc: 'FE 与 RE 系数差异是否显著' },
]

const METHOD_BY_KEY = Object.fromEntries(STAT_METHODS.map(m => [m.key, m]))

// 推荐流程的 Stata 命令 → 本页方法。列在表外的一律标为「本页不支持」，
// 不再像旧版那样静默跑成普通 OLS。
const AUTO_MAP = {
  'summarize': 'descriptive',
  'xtsum': 'descriptive',
  'corr': 'correlation',
  'regress': 'linear_regression',
  'xtreg, fe': 'panel_regression',
  'xtreg, fe robust': 'panel_regression',
  'hausman': 'hausman',
}

export default function Analysis() {
  const [method, setMethod] = useState('descriptive')
  const [variables, setVariables] = useState([])
  const [cats, setCats] = useState([])
  const [yVar, setYVar] = useState(null)
  const [xVars, setXVars] = useState([])
  const [selVars, setSelVars] = useState([])
  const [rowVar, setRowVar] = useState(null)
  const [colVar, setColVar] = useState(null)
  const [groupVar, setGroupVar] = useState(null)
  const [testKind, setTestKind] = useState('one_sample')
  const [testValue, setTestValue] = useState(0)
  const [seType, setSeType] = useState('robust')
  const [clusterVars, setClusterVars] = useState([])
  const [idVar, setIdVar] = useState(null)
  const [timeVar, setTimeVar] = useState(null)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('result')
  const [profile, setProfile] = useState(null)
  const [autoSteps, setAutoSteps] = useState([])
  const [autoRunning, setAutoRunning] = useState(false)
  const [autoLog, setAutoLog] = useState([])

  useEffect(() => {
    dataAPI.variables().then(r => {
      const vs = r.data.variables || []
      setVariables(vs.map(v => v.name))
      setCats(vs.filter(v => v.type === '字符型').map(v => v.name))
    }).catch(() => {})
    profileAPI.get().then(r => {
      setProfile(r.data)
      setAutoSteps(r.data.recommendations || [])
      const d = r.data.structure_detail || {}
      if (d.id_var) setIdVar(d.id_var)
      if (d.time_var) setTimeVar(d.time_var)
      const cand = (r.data.regression_recommend || {})
      if (cand.y_var) setYVar(cand.y_var)
      if (cand.core_x?.length) setXVars(cand.core_x.slice(0, 1))
      if (cand.cluster_vars?.length) setClusterVars(cand.cluster_vars.slice(0, 2))
    }).catch(() => {})
  }, [])

  const m = METHOD_BY_KEY[method] || STAT_METHODS[0]

  const buildConfig = () => {
    const cfg = { se_type: seType, cluster_vars: clusterVars, robust: seType === 'robust' }
    if (m.fields.includes('y')) cfg.y_var = yVar
    if (m.fields.includes('x')) cfg.x_vars = xVars
    if (m.fields.includes('vars')) cfg.x_vars = selVars.length ? selVars : xVars
    if (m.fields.includes('cat')) cfg.row_var = rowVar
    if (m.fields.includes('cat2')) cfg.col_var = colVar
    if (m.fields.includes('group_var')) cfg.group_var = testKind === 'two_sample' && m.key === 'hypothesis_test'
      ? groupVar : groupVar
    if (m.key === 'hypothesis_test') {
      cfg.test_kind = testKind
      cfg.test_value = testValue
      cfg.group_var = groupVar
    }
    if (m.fields.includes('panel')) {
      cfg.id_var = idVar
      cfg.time_var = timeVar
    }
    return cfg
  }

  const validate = () => {
    const need = m.fields
    if (need.includes('y') && !yVar) return '请选择变量'
    if (need.includes('x') && (!xVars || !xVars.length)) return '请至少选择一个解释变量'
    if (need.includes('vars') && (!selVars || !selVars.length)) return '请至少选择一个变量'
    if (need.includes('cat') && !rowVar) return '请选择行变量'
    if (need.includes('cat2') && !colVar) return '请选择列变量'
    if (m.key === 'hypothesis_test' && testKind === 'two_sample' && !groupVar)
      return '两组比较需要选择分组变量'
    if (need.includes('group_var') && m.key === 'anova' && !groupVar) return '请选择分组变量'
    if (need.includes('panel') && (!idVar || !timeVar))
      return '这个方法需要面板数据，请指定个体变量与时间变量'
    if (m.fields.includes('se') && seType === 'cluster' && !clusterVars.length)
      return '聚类标准误需要至少一个聚类层级'
    return null
  }

  const handleRun = async () => {
    const err = validate()
    if (err) { message.warning(err); return }
    setLoading(true)
    try {
      const res = await analysisAPI.run(method, buildConfig())
      setResult(res.data)
      setActiveTab('result')
    } catch (e) {
      message.error('分析失败')
    }
    setLoading(false)
  }

  const buildConfigFor = (key) => {
    const t = METHOD_BY_KEY[key]
    if (!t) return null
    const prev = method
    const cfg = { se_type: seType, cluster_vars: clusterVars, robust: seType === 'robust' }
    if (t.fields.includes('y')) cfg.y_var = yVar
    if (t.fields.includes('x')) cfg.x_vars = xVars
    if (t.fields.includes('vars')) cfg.x_vars = selVars.length ? selVars : (yVar ? [yVar, ...xVars] : xVars)
    if (t.fields.includes('panel')) { cfg.id_var = idVar; cfg.time_var = timeVar }
    if (t.key === 'panel_regression' && seType !== 'cluster') cfg.se_type = 'cluster'
    void prev
    return cfg
  }

  const handleAutoRun = async () => {
    setAutoRunning(true)
    setAutoLog([])
    const log = []
    for (const step of autoSteps) {
      const key = AUTO_MAP[step.command]
      if (!key) {
        log.push({ action: step.action, command: step.command,
                   status: 'skipped',
                   why: '这一步需要回归分析页的方法（DID / IV / 时间序列检验等），本页不重复提供' })
        setAutoLog([...log])
        continue
      }
      const cfg = buildConfigFor(key)
      const needErr = (() => {
        const t = METHOD_BY_KEY[key]
        if (t.fields.includes('y') && !cfg.y_var) return '没有选定变量'
        if (t.fields.includes('x') && !cfg.x_vars?.length) return '没有选定解释变量'
        if (t.fields.includes('vars') && !cfg.x_vars?.length) return '没有选定变量'
        if (t.fields.includes('panel') && (!cfg.id_var || !cfg.time_var)) return '缺少个体/时间变量'
        return null
      })()
      if (needErr) {
        log.push({ action: step.action, command: step.command, status: 'skipped', why: needErr })
        setAutoLog([...log])
        continue
      }
      let data = null
      try {
        const res = await analysisAPI.run(key, cfg)
        data = res.data
      } catch (e) {
        data = { error: e.message }
      }
      log.push({
        action: step.action, command: step.command, status: data?.error ? 'fail' : 'ok',
        method: data?.method, error: data?.error, data,
      })
      setAutoLog([...log])
    }
    const ok = log.filter(l => l.status === 'ok')
    if (ok.length) {
      setResult(ok[ok.length - 1].data)
      setMethod(AUTO_MAP[ok[ok.length - 1].command] || method)
      setActiveTab('result')
    }
    setAutoRunning(false)
    const skip = log.filter(l => l.status === 'skipped').length
    message.success(`推荐流程：${ok.length} 步完成，${skip} 步跳过，${log.filter(l => l.status === 'fail').length} 步失败`)
  }

  const doExport = async (fmt) => {
    if (!result) { message.warning('先跑一次分析'); return }
    try {
      const r = await exportAPI.result(fmt, result)
      if (r.data?.url) {
        // 用相对路径，别写死 localhost:8000——Docker 部署时走 nginx 代理
        window.open(r.data.url, '_blank')
        message.success(`已导出 ${r.data.name}`)
      } else {
        message.error(r.data?.error || '导出失败')
      }
    } catch (e) {
      message.error(e.response?.data?.error || '导出失败')
    }
  }

  const renderField = () => {
    const varOpts = variables.map(v => ({ label: v, value: v }))
    const f = m.fields
    return (
      <>
        {(f.includes('y') || f.includes('x')) && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
              {f.includes('y') ? '被解释变量 (Y)' : '统计变量（可多选）'}
            </div>
            <Select value={yVar} onChange={setYVar} style={{ width: '100%' }}
                    placeholder="选择变量" options={varOpts} size="small" showSearch />
          </div>
        )}

        {f.includes('x') && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>解释变量 (X)</div>
            <Select mode="multiple" value={xVars} onChange={setXVars} style={{ width: '100%' }}
                    placeholder="可多选" options={varOpts} size="small" showSearch />
          </div>
        )}

        {f.includes('vars') && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>统计变量（可多选）</div>
            <Select mode="multiple" value={selVars} onChange={setSelVars} style={{ width: '100%' }}
                    placeholder="选择要统计的变量" options={varOpts} size="small" showSearch />
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
              留空则对全部数量变量做统计
            </div>
          </div>
        )}

        {f.includes('cat') && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>行变量（分类）</div>
            <Select value={rowVar} onChange={setRowVar} style={{ width: '100%' }}
                    placeholder="选择分类变量" options={varOpts} size="small" showSearch />
          </div>
        )}

        {f.includes('cat2') && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>列变量（分类）</div>
            <Select value={colVar} onChange={setColVar} style={{ width: '100%' }}
                    placeholder="选择分类变量，不能与行变量相同" options={varOpts} size="small" showSearch />
          </div>
        )}

        {f.includes('group_var') && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>分组变量（分类）</div>
            <Select value={groupVar} onChange={setGroupVar} style={{ width: '100%' }}
                    placeholder="选择分组变量" options={varOpts} size="small" showSearch
                    optionFilterProp="label" />
          </div>
        )}

        {f.includes('test_kind') && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>检验类型</div>
            <Radio.Group value={testKind} onChange={e => setTestKind(e.target.value)} size="small">
              <Radio value="one_sample">与给定值比</Radio>
              <Radio value="two_sample">两组比</Radio>
            </Radio.Group>
            {testKind === 'one_sample' ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>
                  原假设 H0：均值等于
                </div>
                <Select value={testValue} onChange={setTestValue} style={{ width: '100%' }}
                        size="small" options={[0, 1, 100].map(v => ({ value: v, label: String(v) }))} />
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8' }}>
                分组变量需恰好两个取值，使用 Welch 检验（不假设方差齐性）
              </div>
            )}
          </div>
        )}

        {f.includes('panel') && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>个体变量</div>
              <Select value={idVar} onChange={setIdVar} style={{ width: '100%' }}
                      placeholder="如 Stkcd" options={varOpts} size="small" showSearch />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>时间变量</div>
              <Select value={timeVar} onChange={setTimeVar} style={{ width: '100%' }}
                      placeholder="如 year" options={varOpts} size="small" showSearch />
            </div>
          </>
        )}

        {f.includes('se') && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>标准误</div>
              <Select value={seType} onChange={setSeType} style={{ width: '100%' }} size="small"
                      options={[
                        { value: 'robust', label: '异方差稳健 (HC1)' },
                        { value: 'cluster', label: '聚类稳健' },
                        { value: 'plain', label: '普通 OLS 标准误' },
                      ]} />
            </div>
            {seType === 'cluster' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                  聚类层级（可多选，实现双聚类）
                </div>
                <Select mode="multiple" value={clusterVars} onChange={setClusterVars}
                        style={{ width: '100%' }} placeholder="如 Stkcd、year"
                        options={varOpts} size="small" showSearch />
              </div>
            )}
          </>
        )}
      </>
    )
  }

  const nameRisks = (profile && profile.name_risks) || []

  return (
    <div style={{ padding: 32 }}>
      {nameRisks.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16, borderRadius: 10 }}
          icon={<WarningOutlined />}
          message={`有 ${nameRisks.length} 组变量名肉眼分不清，选错会让结论反过来`}
          description={<div>
            {nameRisks.slice(0, 4).map((r, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                {r.names.map(n => <Tag key={n} color="orange" style={{ marginRight: 4 }}>{n}</Tag>)}
                <span style={{ fontSize: 11, color: '#64748b' }}>{r.hint}</span>
              </div>
            ))}
          </div>} />
      )}

      {profile && profile.structure && (
        <Alert
          type="info" showIcon
          style={{ marginBottom: 20, borderRadius: 10 }}
          message={
            <div>
              <Space wrap>
                <span style={{ fontWeight: 600 }}>
                  检测到{profile.structure === 'panel' ? '面板数据' : profile.structure === 'time_series' ? '时间序列' : '截面数据'}
                </span>
                <Tag color="blue">{profile.rows} 行 × {profile.cols} 列</Tag>
                {profile.structure_detail?.n_entities && (
                  <Tag>N={profile.structure_detail.n_entities}, T={profile.structure_detail.n_periods}</Tag>
                )}
                {profile.structure_detail?.balanced && <Tag color="green">平衡面板</Tag>}
                {profile.structure_detail?.id_var && (
                  <Tag>个体: {profile.structure_detail.id_var}, 时间: {profile.structure_detail.time_var}</Tag>
                )}
                {profile.missing_pct > 5 && (
                  <Tag color="orange">缺失率 {profile.missing_pct}%</Tag>
                )}
              </Space>
              {autoSteps.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#475569' }}>推荐流程:</span>
                  {autoSteps.map((s, i) => {
                    const ok = !!AUTO_MAP[s.command]
                    return (
                      <Tooltip key={i} title={ok ? s.command : `本页不提供：${s.command}（请去回归分析页）`}>
                        <span style={{ fontSize: 12, color: ok ? '#6366f1' : '#cbd5e1',
                                       textDecoration: ok ? 'none' : 'line-through' }}>
                          {i > 0 && <span style={{ margin: '0 4px', color: '#cbd5e1' }}>→</span>}
                          {s.action}
                        </span>
                      </Tooltip>
                    )
                  })}
                  <Button type="primary" size="small" icon={<ThunderboltOutlined />}
                          loading={autoRunning} onClick={handleAutoRun}>一键执行</Button>
                </div>
              )}
            </div>
          }
        />
      )}

      {autoLog.length > 0 && (
        <Card size="small" style={{ marginBottom: 20 }} title={
          <Space>推荐流程执行记录
            <Tag color="green">{autoLog.filter(l => l.status === 'ok').length} 完成</Tag>
            <Tag color="orange">{autoLog.filter(l => l.status === 'skipped').length} 跳过</Tag>
            <Tag color="red">{autoLog.filter(l => l.status === 'fail').length} 失败</Tag>
          </Space>}
          extra={<Button size="small" type="text" onClick={() => setAutoLog([])}>清空</Button>}>
          <Steps size="small" direction="vertical" current={autoLog.length}
            items={autoLog.map((l, i) => ({
              title: <Space>
                <span>{l.action}</span>
                <Tag style={{ fontSize: 10 }}>{l.command}</Tag>
                {l.status === 'ok' && <Tag color="green" icon={<CheckCircleOutlined />}>{l.method}</Tag>}
                {l.status === 'skipped' && <Tag color="orange">跳过</Tag>}
                {l.status === 'fail' && <Tag color="red">失败</Tag>}
              </Space>,
              description: l.status === 'ok'
                ? null
                : <span style={{ fontSize: 11, color: '#f43f5e' }}>
                    {l.status === 'fail' ? l.error : l.why}
                  </span>,
              key: i,
            }))} />
        </Card>
      )}

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ width: 292, flexShrink: 0 }}>
          <Card title="分析方法" size="small" style={{ marginBottom: 16 }}>
            {['统计', '回归'].map(g => (
              <div key={g}>
                <div style={{ fontSize: 10, letterSpacing: 1, color: '#94a3b8',
                              fontWeight: 600, padding: '10px 0 4px' }}>{g}</div>
                {STAT_METHODS.filter(x => x.group === g).map(x => (
                  <div key={x.key} onClick={() => setMethod(x.key)}
                    style={{
                      padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      background: method === x.key ? '#eef2ff' : 'transparent',
                      color: method === x.key ? '#4f46e5' : '#475569',
                      fontWeight: method === x.key ? 600 : 400,
                    }}>
                    <div>{x.icon} {x.label}</div>
                    <div style={{ fontSize: 10, color: method === x.key ? '#818cf8' : '#cbd5e1',
                                 marginTop: 2 }}>{x.desc}</div>
                  </div>
                ))}
              </div>
            ))}
          </Card>

          <Card title="变量设置" size="small" style={{ marginBottom: 16 }}
                extra={<span style={{ fontSize: 11, color: '#94a3b8' }}>按方法动态显示</span>}>
            {renderField()}
          </Card>

          <Button type="primary" icon={<PlayCircleOutlined />} block onClick={handleRun}
                  loading={loading} size="large">运行分析</Button>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card size="small" style={{ marginBottom: 16 }} title="导出">
            <Space wrap>
              {[
                { fmt: 'docx', label: '导出 Word', icon: <DownloadOutlined /> },
                { fmt: 'latex', label: '导出 LaTeX' },
                { fmt: 'md', label: '导出 Markdown' },
                { fmt: 'zip', label: '打包下载 (Word+LaTeX)' },
              ].map(b => (
                <Button key={b.fmt} size="small" icon={b.icon || <DownloadOutlined />}
                        onClick={() => doExport(b.fmt)} disabled={!result}>
                  {b.label}
                </Button>
              ))}
            </Space>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
              导出的是可直接打开的真文件（.docx / .tex / .md），也会登记到「产出 · 结果输出」页签。
            </div>
          </Card>

          <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
            { key: 'result', label: '结果', children: renderResult() },
          ]} />
        </div>
      </div>
    </div>
  )

  function renderResult() {
    if (!result) return (
      <div style={{ color: '#94a3b8', textAlign: 'center', padding: 60 }}>
        在左侧选好变量后点击「运行分析」
      </div>)
    if (result.error) return (
      <div style={{ color: '#f43f5e', padding: 20 }}>❌ {result.error}</div>)

    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ padding: '2px 10px', borderRadius: 4, background: '#f0fdf4',
                         color: '#16a34a', fontSize: 12 }}>方法: {result.method}</span>
          {result.r_squared !== undefined && result.r_squared !== null && (
            <span style={{ padding: '2px 10px', borderRadius: 4, background: '#ecfdf5',
                           color: '#16a34a', fontSize: 12 }}>R² = {result.r_squared}</span>
          )}
          {result.nobs && (
            <span style={{ padding: '2px 10px', borderRadius: 4, background: '#eef2ff',
                           color: '#6366f1', fontSize: 12 }}>N = {result.nobs.toLocaleString()}</span>
          )}
          {result.se_type && (
            <span style={{ padding: '2px 10px', borderRadius: 4, background: '#fef9c3',
                           color: '#a16207', fontSize: 12 }}>{result.se_type}</span>
          )}
          {result.n_entities && (
            <span style={{ padding: '2px 10px', borderRadius: 4, background: '#f5f3ff',
                           color: '#7c3aed', fontSize: 12 }}>个体 {result.n_entities} · 期数 {result.n_periods}</span>
          )}
        </div>

        {result.conclusion && (
          <Alert showIcon style={{ marginBottom: 16 }}
            type={result.reject_re === false ? 'success' : 'info'}
            message="结论" description={result.conclusion} />
        )}

        {result.coefficients && (
          <Card size="small" title="估计结果" style={{ marginBottom: 16 }}>
            <Table
              dataSource={result.coefficients.map((c, i) => ({ ...c, key: i }))}
              rowKey="key"
              columns={[
                { title: '变量', dataIndex: 'variable',
                  render: (v, r) => <strong style={{
                    color: r.role === 'core' ? '#4f46e5' : undefined }}>{v}</strong> },
                { title: '系数', dataIndex: 'coef', render: v => v?.toFixed(4) },
                { title: '标准误', dataIndex: 'std_err', render: v => v?.toFixed(4) },
                { title: 't 值', dataIndex: 't', render: v => v?.toFixed(3) },
                { title: 'P 值', dataIndex: 'p',
                  render: v => <span style={{ color: v < 0.05 ? '#16a34a' : v < 0.1 ? '#f59e0b' : '#64748b', fontWeight: 600 }}>
                    {v?.toFixed(4)} {v < 0.01 ? '***' : v < 0.05 ? '**' : v < 0.1 ? '*' : ''}
                  </span> },
                { title: '95% 置信区间',
                  render: (_, r) => <span style={{ color: '#64748b' }}>[{r.ci_low}, {r.ci_high}]</span> },
              ]}
              pagination={false} size="small"
            />
            {result.stata_code && (
              <pre style={{ background: '#0f172a', color: '#34d399', padding: 12, borderRadius: 6,
                            fontSize: 12, marginTop: 12, marginBottom: 0, overflow: 'auto' }}>
                {result.stata_code}</pre>
            )}
          </Card>
        )}

        {result.comparison && (
          <Card size="small" title="固定效应 vs 随机效应" style={{ marginBottom: 16 }}>
            <Table rowKey="variable" pagination={false} size="small"
              dataSource={result.comparison}
              columns={[
                { title: '变量', dataIndex: 'variable' },
                { title: 'FE 系数', dataIndex: 'fe_coef' },
                { title: 'RE 系数', dataIndex: 're_coef' },
                { title: '差异', dataIndex: 'diff' },
              ]} />
            {result.chi2 === null && (
              <Alert type="warning" showIcon style={{ marginTop: 12 }}
                message="Hausman 统计量不可用"
                description={'固定效应把该变量的组间变异吸收后，V_fe − V_re 奇异，标准统计量失效。'
                  + '此时看上面的系数差异表比看 p 值可靠；差异明显就用 FE。'} />
            )}
          </Card>
        )}

        {result.table && method === 'descriptive' && (
          <Card size="small" title="描述性统计" style={{ marginBottom: 16 }}>
            <Table
              dataSource={Object.entries(result.table).map(([k, v], i) => ({ var: k, ...v, key: i }))}
              rowKey="key"
              columns={[
                { title: '变量', dataIndex: 'var', render: v => <strong>{v}</strong> },
                { title: 'Obs', dataIndex: 'obs' },
                { title: 'Mean', dataIndex: 'mean' },
                { title: 'Std.Dev.', dataIndex: 'std' },
                { title: 'Min', dataIndex: 'min' },
                { title: 'P25', dataIndex: 'p25' },
                { title: 'Median', dataIndex: 'p50' },
                { title: 'P75', dataIndex: 'p75' },
                { title: 'Max', dataIndex: 'max' },
              ]}
              pagination={false} size="small" scroll={{ x: 'max-content' }}
            />
          </Card>
        )}

        {result.matrix && (
          <Card size="small" title="相关性矩阵" style={{ marginBottom: 16 }}>
            <Table
              dataSource={result.variables.map((v, i) => ({ var: v, ...result.matrix[v], key: i }))}
              rowKey="key"
              columns={[
                { title: '', dataIndex: 'var', render: v => <strong>{v}</strong> },
                ...result.variables.map(v2 => ({
                  title: v2, dataIndex: v2, key: v2,
                  render: val => <span style={{ color: Math.abs(val) > 0.5 ? '#6366f1' : '#64748b' }}>{val?.toFixed(4)}</span>,
                })),
              ]}
              pagination={false} size="small"
            />
          </Card>
        )}

        {result.row_names && (
          <Card size="small" title={`交叉表：${result.row_var} × ${result.col_var}`}
                style={{ marginBottom: 16 }}>
            <Table
              dataSource={result.row_names.map((rn, i) => ({
                key: i, row: rn,
                ...Object.fromEntries((result.col_names || []).map(cn => [
                  cn, (result.table[cn] || {})[rn] ?? 0])),
              }))}
              rowKey="key"
              pagination={{ pageSize: 15 }}
              size="small"
              scroll={{ x: 'max-content' }}
              columns={[
                { title: result.row_var, dataIndex: 'row', fixed: 'left',
                  render: v => <strong>{String(v)}</strong> },
                ...(result.col_names || []).map(cn => ({
                  title: String(cn), dataIndex: cn, width: 90, align: 'right',
                })),
              ]} />
            <div style={{ marginTop: 8, fontSize: 12, color: '#475569' }}>
              χ² = {result.chi2}，自由度 = {result.df}，p = {result.p_value}
              {result.independent
                ? '，两变量独立（不拒绝原假设）'
                : '，两变量不独立'}
            </div>
          </Card>
        )}

        {(result.f_stat !== undefined && result.f_stat !== null
          && !result.coefficients && !result.comparison) && (
          <Card size="small" title="检验结果" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              {[
                { label: '统计量', value: result.f_stat },
                { label: 'P 值', value: result.p_value,
                  color: result.p_value < 0.05 ? '#16a34a' : undefined },
                { label: '观测数', value: result.obs },
                { label: '均值', value: result.mean?.toFixed?.(4) ?? result.mean },
              ].map((item, i) => (
                <Col span={6} key={i}>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{item.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: item.color || '#1e293b' }}>
                    {item.value ?? '—'}
                  </div>
                </Col>
              ))}
            </Row>
            {result.groups && (
              <Table rowKey="name" pagination={false} size="small" style={{ marginTop: 12 }}
                dataSource={result.groups}
                columns={[
                  { title: '组', dataIndex: 'name' },
                  { title: 'N', dataIndex: 'n' },
                  { title: '均值', dataIndex: 'mean' },
                ]} />
            )}
            {result.ci && (
              <div style={{ marginTop: 10, fontSize: 12, color: '#475569' }}>
                均值的 95% 置信区间：[{result.ci[0]}, {result.ci[1]}]
              </div>
            )}
          </Card>
        )}

        {result.notes && (
          <Card size="small" title="说明" style={{ marginBottom: 16 }}>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#475569' }}>
              {result.notes.map((n, i) => <li key={i} style={{ marginBottom: 4 }}>{n}</li>)}
            </ul>
          </Card>
        )}
      </div>
    )
  }
}
