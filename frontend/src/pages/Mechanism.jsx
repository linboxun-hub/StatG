import React, { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, Select, Button, Table, Radio, Space, Spin, Alert, Tag, InputNumber,
         Checkbox, Divider, Empty, message } from 'antd'
import { PlayCircleOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { mechanismAPI, dataAPI } from '../api'

const SE_OPTIONS = [
  { value: 'cluster', label: '聚类稳健标准误' },
  { value: 'robust', label: '异方差稳健 (HC1)' },
  { value: 'classical', label: '普通标准误' },
]
const METHOD_OPTIONS = [
  { value: 'twoway_fe', label: '双向固定效应' },
  { value: 'fe', label: '个体固定效应' },
  { value: 'ols', label: '混合 OLS' },
]
const PANEL = ['fe', 'te', 'twoway_fe']

// TOP5 六大机制分析方法（计量经济圈），用于页面内的参考卡说明。
const SIX_METHODS = [
  { n: 1, name: '两步中介', desc: 'Y~X 得总效应，M~X 看 X→M；M→Y 借文献说明。', here: true },
  { n: 2, name: '三步法 Baron–Kenny', desc: 'Y~X+M 后 X 系数变小/不显著 ⇒ 有中介。', here: true },
  { n: 3, name: '路径拆分', desc: 'M~X 与 Y~X+M 分开算，得直接+间接效应。', here: true },
  { n: 4, name: '交互项 / 分组回归', desc: 'Y~X + M + X·M，用异质性检验机制。', here: true },
  { n: 5, name: '因果中介', desc: 'X/M 内生时用因果框架分解；进阶，见 AI 助手。', here: false },
  { n: 6, name: '残差法 + Bootstrap', desc: '残差化去中介后回归得直接效应，Bootstrap 求区间。', here: true },
]

const star = p => (p == null ? '' : p < 0.01 ? '***' : p < 0.05 ? '**' : p < 0.1 ? '*' : '')

export default function Mechanism() {
  const [search, setSearch] = useSearchParams()
  const mode = search.get('mode') === 'moderation' ? 'moderation' : 'mediation'
  const [variables, setVariables] = useState([])
  const [yVar, setYVar] = useState(null)
  const [xVar, setXVar] = useState(null)
  const [mVar, setMVar] = useState(null)
  const [controls, setControls] = useState([])
  const [method, setMethod] = useState('twoway_fe')
  const [idVar, setIdVar] = useState(null)
  const [timeVar, setTimeVar] = useState(null)
  const [seType, setSeType] = useState('cluster')
  const [cluster1, setCluster1] = useState(null)
  const [bootstrap, setBootstrap] = useState(0)
  const [center, setCenter] = useState(true)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const inited = { done: false }
    dataAPI.variables().then(r => {
      const vars = (r.data.variables || []).map(v => v.name)
      setVariables(vars)
      if (inited.done) return
      inited.done = true
      const pick = (cands, fb) => vars.find(v => cands.includes(v)) || (vars.includes(fb) ? fb : null)
      setYVar(pick(['growth', 'roa', 'FIN'], null))
      setXVar(pick(['Treat_Post', 'treat', 'did'], null))
      setMVar(pick(['fa', 'FIN', 'lev', 'size'], null))
      setIdVar(pick(['Stkcd', 'gvkey', 'id'], null))
      setTimeVar(pick(['year', 'Year'], null))
      setCluster1(pick(['PROVINCE', 'province'], null))
    }).catch(() => {})
    return () => { inited.done = true }
  }, [])

  const needsPanel = PANEL.includes(method)
  const varOpts = variables.map(v => ({ label: v, value: v }))

  const buildConfig = () => ({
    y_var: yVar, x_var: xVar, m_var: mVar, controls,
    method, id_var: idVar, time_var: timeVar, se_type: seType,
    cluster_vars: seType === 'cluster' && cluster1 ? [cluster1] : [],
    ...(mode === 'mediation' ? { bootstrap } : { center }),
  })

  const handleRun = async () => {
    if (!yVar) { message.warning('请选择被解释变量 Y'); return }
    if (!xVar) { message.warning('请选择核心解释变量 X'); return }
    if (!mVar) { message.warning(mode === 'mediation' ? '请选择中介变量 M' : '请选择调节变量 M'); return }
    setLoading(true)
    setResult(null)
    try {
      const r = mode === 'mediation'
        ? await mechanismAPI.mediation(buildConfig())
        : await mechanismAPI.moderation(buildConfig())
      setResult(r.data)
    } catch (e) {
      message.error('计算失败')
    }
    setLoading(false)
  }

  const medRows = result && result.type === 'mediation' ? [
    { key: 'c',  eff: `总效应 c（X→Y）`,   coef: result.total_effect?.coef,   se: result.total_effect?.std_err,   p: result.total_effect?.p },
    { key: 'a',  eff: `路径 a（X→M）`,      coef: result.path_a?.coef,         se: result.path_a?.std_err,         p: result.path_a?.p },
    { key: 'cp', eff: `直接效应 c′（X|M）`, coef: result.direct_effect?.coef,  se: result.direct_effect.std_err,   p: result.direct_effect?.p },
    { key: 'b',  eff: `路径 b（M→Y|X）`,   coef: result.b_path?.coef,         se: result.b_path.std_err,        p: result.b_path?.p },
  ] : []
  const coefCols = [
    { title: '效应', dataIndex: 'eff', key: 'eff' },
    { title: '系数', dataIndex: 'coef', key: 'coef', align: 'right', render: v => (v == null ? '—' : Number(v).toFixed ? Number(v).toFixed(4) : v) },
    { title: '标准误', dataIndex: 'se', key: 'se', align: 'right', render: v => (v == null ? '—' : Number(v).toFixed(4)) },
    { title: 'P 值', dataIndex: 'p', key: 'p', align: 'right', render: v => (v == null ? '—' : Number(v).toFixed(4)) },
    { title: '显著性', key: 's', align: 'center', render: (_, r) => star(r.p) },
  ]
  const modCols = [
    { title: '变量', dataIndex: 'variable', key: 'variable' },
    { title: '系数', dataIndex: 'coef', key: 'coef', align: 'right', render: v => (v == null ? '—' : v) },
    { title: '标准误', dataIndex: 'std_err', key: 'std_err', align: 'right', render: v => (v == null ? '—' : v) },
    { title: 'P 值', dataIndex: 'p', key: 'p', align: 'right', render: v => (v == null ? '—' : Number(v).toFixed(4)) },
    { title: '显著性', key: 'st', dataIndex: 'stars', align: 'center' },
  ]

  return (
    <div style={{ padding: 24, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ width: 320, flexShrink: 0 }}>
        <Card size="small" style={{ marginBottom: 16 }}>
          <Radio.Group value={mode} onChange={e => { setSearch({ mode: e.target.value }); setResult(null) }}
            buttonStyle="solid" style={{ width: '100%' }}>
            <Radio.Button value="mediation" style={{ width: '50%', textAlign: 'center' }}>中介效应</Radio.Button>
            <Radio.Button value="moderation" style={{ width: '50%', textAlign: 'center' }}>调节效应</Radio.Button>
          </Radio.Group>
        </Card>

        <Card title="变量设置" size="small" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>被解释变量 Y</div>
          <Select value={yVar} onChange={setYVar} style={{ width: '100%', marginBottom: 10 }}
            options={varOpts} showSearch allowClear size="small" placeholder="选择 Y" />
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>核心解释变量 X</div>
          <Select value={xVar} onChange={setXVar} style={{ width: '100%', marginBottom: 10 }}
            options={varOpts} showSearch allowClear size="small" placeholder="选择 X" />
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
            {mode === 'mediation' ? '中介变量 M' : '调节变量 M'}
          </div>
          <Select value={mVar} onChange={setMVar} style={{ width: '100%', marginBottom: 10 }}
            options={varOpts} showSearch allowClear size="small" placeholder="选择 M" />
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>控制变量（可多选）</div>
          <Select mode="multiple" value={controls} onChange={setControls} style={{ width: '100%' }}
            options={varOpts} showSearch allowClear size="small" placeholder="控制变量" />
        </Card>

        <Card title="估计与标准误" size="small" style={{ marginBottom: 16 }}>
          <Select value={method} onChange={setMethod} style={{ width: '100%', marginBottom: 10 }}
            options={METHOD_OPTIONS} size="small" />
          {needsPanel && (
            <Space direction="vertical" style={{ width: '100%', marginBottom: 10 }}>
              <Select value={idVar} onChange={setIdVar} style={{ width: '100%' }} size="small"
                placeholder="个体变量" options={varOpts} showSearch allowClear />
              <Select value={timeVar} onChange={setTimeVar} style={{ width: '100%' }} size="small"
                placeholder="时间变量" options={varOpts} showSearch allowClear />
            </Space>
          )}
          <Radio.Group value={seType} onChange={e => setSeType(e.target.value)} style={{ marginBottom: 8 }}>
            <Space direction="vertical">
              {SE_OPTIONS.map(o => <Radio key={o.value} value={o.value}>{o.label}</Radio>)}
            </Space>
          </Radio.Group>
          {seType === 'cluster' && (
            <Select value={cluster1} onChange={setCluster1} style={{ width: '100%' }} size="small"
              placeholder="聚类层级" options={varOpts} showSearch allowClear />
          )}
        </Card>

        <Card title="选项" size="small" style={{ marginBottom: 16 }}>
          {mode === 'mediation' ? (
            <>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                Bootstrap 重抽样次数（0=只用 Sobel；面板 FE 下较慢）
              </div>
              <InputNumber value={bootstrap} onChange={setBootstrap} min={0} max={2000} step={100}
                style={{ width: '100%' }} size="small" />
            </>
          ) : (
            <Checkbox checked={center} onChange={e => setCenter(e.target.checked)}>
              对 M 按均值中心化（缓解共线、使 X 系数=M 均值处效应）
            </Checkbox>
          )}
        </Card>

        <Button type="primary" icon={<PlayCircleOutlined />} block size="large" loading={loading}
          onClick={handleRun}>
          {mode === 'mediation' ? '运行中介效应分析' : '运行调节效应分析'}
        </Button>
      </div>

      <div style={{ flex: 1, minWidth: 420 }}>
        {loading && <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}
        {!loading && !result && (
          <Empty description="选择 Y / X / M 后点「运行」" style={{ marginTop: 60 }} />
        )}
        {!loading && result && result.error && <Alert type="error" message={result.error} showIcon style={{ marginBottom: 16 }} />}

        {!loading && result && !result.error && result.type === 'mediation' && (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 16 }}
              message={<span>中介效应 · {result.method}（N={result.n}，{result.se_type}）</span>}
              description={<span style={{ fontSize: 12 }}>
                X=<b>{result.x}</b> → M=<b>{result.m}</b> → Y=<b>{result.dep_var}</b></span>} />
            <Card size="small" title="三步回归" style={{ marginBottom: 16 }}>
              <Table size="small" pagination={false} columns={coefCols}
                dataSource={medRows.map(r => ({ ...r, key: r.key }))} />
            </Card>
            <Card size="small" title="间接效应与检验" style={{ marginBottom: 16 }}>
              <Space size="large" wrap>
                <span>a·b = <b>{result.indirect.point}</b></span>
                <span>总−直接 c−c′ = <b>{result.indirect.diff_method}</b></span>
                <span>Sobel z = <b>{result.indirect.sobel_z}</b>，p = <b>{result.indirect.sobel_p}</b>
                  {result.indirect.stars && <Tag color="green" style={{ marginLeft: 6 }}>{result.indirect.stars}</Tag>}</span>
                {result.indirect.proportion != null && <span>中介占比 = <b>{(result.indirect.proportion * 100).toFixed(1)}%</b></span>}
              </Space>
              <Divider style={{ margin: '12px 0' }} />
              <div style={{ fontSize: 13 }}>
                {result.indirect.sobel_p != null && result.indirect.sobel_p < 0.05
                  ? <Tag color="green">Sobel 显著：存在中介效应</Tag>
                  : <Tag>Sobel 不显著：按此口径未见明显中介</Tag>}
              </div>
              {result.bootstrap && !result.bootstrap.error && (
                <Alert type="success" showIcon style={{ marginTop: 12 }}
                  message={`Bootstrap 间接效应 95% 区间 [${result.bootstrap.ci_low}, ${result.bootstrap.ci_high}]（${result.bootstrap.n_ok} 次有效重抽样）`}
                  description={result.bootstrap.note} />
              )}
              {result.bootstrap && result.bootstrap.error && (
                <Alert type="warning" showIcon style={{ marginTop: 12 }} message={result.bootstrap.error} />
              )}
            </Card>
            {result.notes && (
              <Alert type="info" showIcon icon={<InfoCircleOutlined />} style={{ marginBottom: 16 }}
                message="说明" description={<ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.notes.map((n, i) => <li key={i} style={{ fontSize: 12 }}>{n}</li>)}</ul>} />
            )}
          </>
        )}

        {!loading && result && !result.error && result.type === 'moderation' && (
          <>
            <Alert type="info" showIcon style={{ marginBottom: 16 }}
              message={<span>调节效应 · {result.method}（N={result.n}，{result.se_type}）</span>}
              description={<span style={{ fontSize: 12 }}>
                Y=<b>{result.dep_var}</b> ~ X=<b>{result.x}</b> × M=<b>{result.m}</b>
                {result.center ? '（M 已按均值中心化）' : ''}</span>} />
            <Card size="small" title="回归结果" style={{ marginBottom: 16 }}>
              <Table size="small" pagination={false} columns={modCols}
                dataSource={(result.coefficients || []).map((r, i) => ({ ...r, key: i }))} />
            </Card>
            <Card size="small" title="交互项与简单斜率" style={{ marginBottom: 16 }}>
              <Space size="large" wrap>
                <span>X·M = <b>{result.interaction.coef}</b>（se {result.interaction.std_err}，p {Number(result.interaction.p).toFixed(4)}）
                  {result.interaction.stars && <Tag color="green" style={{ marginLeft: 6 }}>{result.interaction.stars}</Tag>}</span>
                <span>X 在 M 均值处效应 = <b>{result.effect_at_mean}</b></span>
                <span>M +1sd ≈ <b>{result.simple_slope_hi}</b>，−1sd ≈ <b>{result.simple_slope_lo}</b></span>
              </Space>
              <Divider style={{ margin: '12px 0' }} />
              <div style={{ fontSize: 13 }}>
                {result.interaction.p != null && result.interaction.p < 0.05
                  ? <Tag color="green">交互显著：X 的作用随 M 变化（调节/机制成立）</Tag>
                  : <Tag>交互不显著：未见 M 的调节作用</Tag>}
              </div>
            </Card>
            {result.notes && (
              <Alert type="info" showIcon icon={<InfoCircleOutlined />} style={{ marginBottom: 16 }}
                message="说明" description={<ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.notes.map((n, i) => <li key={i} style={{ fontSize: 12 }}>{n}</li>)}</ul>} />
            )}
          </>
        )}

        <Card size="small" title="参考：TOP5 六大机制分析方法" style={{ marginTop: 8 }}>
          {(SIX_METHODS.map(m => (
            <div key={m.n} style={{ display: 'flex', gap: 8, padding: '5px 0', borderTop: '1px dashed #f0f0f0', fontSize: 12.5 }}>
              <b style={{ minWidth: 18, color: '#6366f1' }}>M{m.n}</b>
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span style={{ color: '#64748b' }}> — {m.desc}</span>
              </div>
              {m.here
                ? <Tag color="blue" style={{ marginLeft: 8 }}>已实现</Tag>
                : <Tag style={{ marginLeft: 8 }}>见 AI 助手</Tag>}
            </div>
          )))}
        </Card>
      </div>
    </div>
  )
}
