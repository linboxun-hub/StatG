import React, { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { Card, Row, Col, Select, Button, Spin, message, Space, Input, Tag, Alert, Checkbox,
         Table, Tooltip as ATooltip } from 'antd'
import { DownloadOutlined, LineChartOutlined, PlusCircleOutlined, DeleteOutlined } from '@ant-design/icons'
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  AreaChart, Area, Cell, PieChart, Pie, ErrorBar, ReferenceLine,
  ComposedChart,
} from 'recharts'
import { graphAPI, dataAPI } from '../api'

// 图表按研究流程分阶段。id 用于把某一阶段的图「分配」回对应入口：
// ①统计分析嵌 descriptive、②基准嵌 trend、③稳健性嵌 dml、⑤嵌 hetero，
// 于是不再需要单独的「图形可视化」合集页。
// 侧边栏各阶段入口 → 页面里嵌入 <GraphPanel include={['descriptive']} /> 之类。
const CHART_SECTIONS = [
  {
    id: 'descriptive',
    stage: '① 回归前 · 描述统计',
    items: [
      { key: 'line', label: '折线图', icon: '📈' },
      { key: 'bar', label: '柱状图', icon: '📊' },
      { key: 'area', label: '面积图', icon: '🏔️' },
      { key: 'scatter', label: '散点图', icon: '🔵' },
      { key: 'histogram', label: '直方图', icon: '📶' },
    ],
  },
  {
    id: 'trend',
    stage: '② 基准 · 平行趋势',
    // 一个按钮两张图：上半段窄窗口做标准平行趋势检验（事前为主），
    // 下半段宽窗口做动态平行趋势检验（看全期动态效应）。
    // 顶刊标准做法：事前检验 + 动态效应展示分两段画。
    items: [
      { key: 'parallel_trends', label: '平行趋势检验', icon: '📐' },
    ],
  },
  {
    id: 'dml',
    stage: '③ 稳健性 · DML',
    // DML 稳健性：组内去均值吸收固定效应后跑 DoubleML，学习器各跑一遍
    items: [
      { key: 'dml', label: 'DML 稳健性', icon: '🧪' },
    ],
  },
  {
    id: 'hetero',
    stage: '⑤ 异质性 · 分组系数',
    // 异质性系数图：每个维度分高低两组各跑一次，系数与置信区间画在同一坐标轴上
    items: [
      { key: 'heterogeneity', label: '异质性系数图', icon: '🎯' },
    ],
  },
]

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#06b6d4']

// 一个点 = 上下两条须线 + 端帽 + 圆点。
// pxPerUnit 由父组件根据图表尺寸和 Y 轴域算好后传入，
// 不依赖 recharts 内部是否把 yAxis.scale 传到 shape props。
// 事前点画实心、事后画空心——平行趋势检验看的是事前那一段。
function CoefErrorDot(props) {
  const { cx, cy, payload, isDid, pxPerUnit } = props
  if (cx == null || cy == null || !payload) return null
  const COLOR = '#6366f1'
  const hollow = isDid && payload.rel_time >= 0
  if (payload.ci_low == null || payload.ci_high == null || !pxPerUnit) {
    return <circle cx={cx} cy={cy} r={4} fill={hollow ? '#fff' : COLOR}
                   stroke={COLOR} strokeWidth={hollow ? 1.5 : 0} />
  }
  const up = (payload.ci_high - payload.estimate) * pxPerUnit
  const dn = (payload.estimate - payload.ci_low) * pxPerUnit
  const halfW = 4
  return (
    <g stroke={COLOR} strokeWidth={1.5} fill={COLOR}>
      <line x1={cx} y1={cy - up} x2={cx} y2={cy + dn} />
      <line x1={cx - halfW} y1={cy - up} x2={cx + halfW} y2={cy - up} />
      <line x1={cx - halfW} y1={cy + dn} x2={cx + halfW} y2={cy + dn} />
      <circle cx={cx} cy={cy} r={4} fill={hollow ? '#fff' : COLOR}
              stroke={hollow ? COLOR : 'none'} strokeWidth={hollow ? 1.5 : 0} />
    </g>
  )
}

export function GraphPanel({ include }) {
  // include 指定本实例要显示哪些阶段的图表；不给就全显示（保留一个完整面板可复用）。
  const allowed = include ? CHART_SECTIONS.filter(s => include.includes(s.id)) : CHART_SECTIONS
  // 异质性拆成两个子模块：?view=chart 只画系数图，?view=table 只出分组回归表。
  // 从 useLocation 现取（同一路径下切 ?view 不重挂载）。
  const _loc = useLocation()
  const hview = new URLSearchParams(_loc.search).get('view') === 'table' ? 'table' : 'chart'
  const [chartType, setChartType] = useState(
    () => (allowed[0] && allowed[0].items[0] && allowed[0].items[0].key) || 'line')
  const [variables, setVariables] = useState([])
  const [xVar, setXVar] = useState(null)
  const [yVar, setYVar] = useState(null)
  const [groupVar, setGroupVar] = useState(null)
  const [chartData, setChartData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [policyTime, setPolicyTime] = useState(null)
  const [timePoints, setTimePoints] = useState([])
  const [idVar, setIdVar] = useState(null)
  const [cohortVar, setCohortVar] = useState(null)
  // 事后那段默认宽，事前那段默认窄。两段在右上角各改各的。
  const [preWindow, setPreWindow] = useState('-3,1')
  const [dynWindow, setDynWindow] = useState('-5,5')
  // 异质性系数图的配置。维度列表是核心：每个维度一个分组变量 + 切分方式。
  const [hYVars, setHYVars] = useState([])
  const [hCore, setHCore] = useState([])
  const [hCtrl, setHCtrl] = useState([])
  const [hDims, setHDims] = useState([
    { name: '', group_var: null, split: 'median' }
  ])
  // 确认性维度（事前假设）：单独成族用 Holm；其余探索性维度用 BH。留空视为全是探索性。
  const [hConfirm, setHConfirm] = useState(null)
  // DML 稳健性的配置
  const [dmlY, setDmlY] = useState(null)
  const [dmlD, setDmlD] = useState(null)
  const [dmlCtrl, setDmlCtrl] = useState([])
  const [dmlModel, setDmlModel] = useState('plr')
  const [dmlFolds, setDmlFolds] = useState(5)
  const [dmlTrees, setDmlTrees] = useState(false)
  const [hMethod, setHMethod] = useState('twoway_fe')
  const [hSE, setHSE] = useState('cluster')
  const [hCluster, setHCluster] = useState([])
  const [dmlCluster, setDmlCluster] = useState([])
  const [aiDiag, setAiDiag] = useState(null)    // AI 诊断结果
  const [aiDiagLoading, setAiDiagLoading] = useState(false)

  // 侧边栏「⑤ 异质性分析」直达本页的异质性系数图：按 ?chart= 预选图型。
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get('chart')
    if (c && allowed.some(sec => sec.items.some(x => x.key === c))) setChartType(c)
  }, [])

  // 变量列表只在挂载时拉一次；默认值也只在第一次给。
  // 原来这个 effect 依赖 [chartType]，每次点页签都会重跑一遍「智能默认」，
  // 把用户已经选好的 X/Y/分组又覆盖回默认值——切个图型，选好的变量就没了。
  const inited = useRef(false)
  useEffect(() => {
    dataAPI.variables().then(r => {
      const vars = (r.data.variables || []).map(v => v.name)
      setVariables(vars)
      if (inited.current) return
      inited.current = true
      const pick = (cands, fallbackIdx) => {
        // 先精确匹配，再忽略大小写——数据集变量名大小写不统一（Year vs year）
        const hit = cands.find(c => vars.includes(c))
        if (hit !== undefined) return hit
        const lower = vars.map(v => v.toLowerCase())
        const hit2 = cands.find(c => lower.includes(c.toLowerCase()))
        return hit2 !== undefined ? hit2 : (vars.length > fallbackIdx ? vars[fallbackIdx] : null)
      }
      const xd = pick(['Accper', 'year', 'Year', '年份'], 0)
      setXVar(xd)
      // Y 也优先选本数据集常见的因变量（growth/FIN/fa/roa/wage），别退回时间列
      let yd = pick(['growth', 'FIN', 'Fin_Ratio', 'fa', 'roa', 'wage', 'lwage'], 1)
      if (yd === xd) yd = vars.find(v => v !== xd) || yd
      setYVar(yd)
      setGroupVar(pick(['Treat_Post', 'treat', 'Treat', 'industry', 'Industry', 'first_treat'], -1) ?? null)
      // 事件研究/平行趋势必须知道面板个体标识，按常见命名挑一个
      const ID_HINTS = ['stkcd', 'gvkey', 'permno', 'firmid', 'firm', 'id', 'code']
      const idDefault = vars.find(v => ID_HINTS.includes(v.toLowerCase()))
      if (idDefault) setIdVar(idDefault)
    }).catch(() => {})
  }, [])

  // 换了图表类型，上一张图的配置和结果都不作数了
  // 换了图表类型：上一张图的结果作数；窗口回到该类型的默认值。
  // 平行趋势只重点看事前，默认窄窗口；事件研究要完整动态效应。
  useEffect(() => {
    setChartData(null)
    setAiDiag(null)
    setPreWindow('-3,1')
    setDynWindow('-5,5')
  }, [chartType]) // Re-fetch when chart type changes (which may trigger data reload)

  // 拉取唯一的政策时点候选值，用于「政策实施时点」下拉框
  useEffect(() => {
    if (chartType !== 'did' || !xVar) { setTimePoints([]); return }
    let cancelled = false
    ;(async () => {
      const found = new Set()
      try {
        // /api/data 的 page_size 上限是 200，用 9999 会被 FastAPI 422 拒掉，
        // 而 catch 又把错误吞了，下拉框就永远是空的——所以分页翻完。
        let page = 1
        for (;;) {
          const r = await dataAPI.get(page, 200, '')
          const rows = r.data.data || []
          rows.forEach(row => {
            const v = row[xVar]
            if (v !== null && v !== undefined && v !== '') found.add(v)
          })
          const total = r.data.total || 0
          if (!rows.length || page * 200 >= total || page > 200) break
          page += 1
        }
      } catch { /* 拉不到就让下拉框空着，不阻断其它功能 */ }
      if (cancelled) return
      const unique = [...found].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))
      setTimePoints(unique)
      // 不自动选中位数那个点了：真实政策时点应该由用户指认，
      // 猜一个错的位置比空着更糟（图上会多出一条误导性竖线）。
      if (unique.length && policyTime != null && !unique.includes(policyTime)) {
        setPolicyTime(null)
      }
    })()
    return () => { cancelled = true }
  }, [chartType, xVar])

  // 平行趋势未通过时，自动调 AI 分析原因并给出修改建议
  const triggerAiDiagnose = async (cd) => {
    const pt = cd && cd.parallel_trend
    if (!pt) { setAiDiag(null); return }
    // 只在需要人介入的两种状态下触发：
    //   violated      事前有显著偏离，假设可疑，要诊断原因
    //   not_detected  事前干净但没检出效应，要诊断是不是功效/设定问题
    // detected（绿）不用查；indeterminate（灰）是窗口设错了，
    // 那是配置问题不是分析问题，直接看图上提示就行。
    const tone = pt.tone || (pt.verdict === '通过' ? 'green' : 'red')
    if (tone === 'green' || tone === 'grey') { setAiDiag(null); return }
    let apiConfig = {}
    try { apiConfig = JSON.parse(localStorage.getItem('stata_assistant_ai_config') || '{}') } catch {}
    if (!apiConfig.api_url || !apiConfig.api_key) {
      setAiDiag({ content: '⚠️ AI 诊断需要先在「AI 设置」中配置 API 地址和密钥。' })
      return
    }
    setAiDiagLoading(true)
    setAiDiag(null)
    try {
      const r = await graphAPI.aiDiagnose(cd, apiConfig)
      if (r.data.error) {
        setAiDiag({ content: '⚠️ AI 诊断失败：' + r.data.error })
      } else {
        setAiDiag(r.data)
      }
    } catch {
      setAiDiag({ content: '⚠️ AI 诊断请求失败，请检查网络连接。' })
    }
    setAiDiagLoading(false)
  }

  const handleGenerate = async () => {
    setLoading(true)
    try {
      const config = { x_var: xVar, y_var: yVar, group_var: groupVar }
      if (chartType === 'heterogeneity') {
        if (!hYVars.length) { message.warning('请选择至少一个被解释变量'); setLoading(false); return }
        if (!hCore.length) { message.warning('请选择核心解释变量'); setLoading(false); return }
        const dims = hDims.filter(d => d.group_var).map(d => ({
          name: d.name || d.group_var, group_var: d.group_var, split: d.split || 'median'
        }))
        if (!dims.length) { message.warning('请至少添加一个异质性维度'); setLoading(false); return }
        Object.assign(config, {
          y_vars: hYVars, core_x: hCore, controls: hCtrl,
          dimensions: dims, confirmatory_dim: hConfirm,
          method: hMethod, se_type: hSE,
          cluster_vars: hSE === 'cluster' ? hCluster : [],
          id_var: idVar, time_var: xVar,
          absorb: [], title: '异质性系数比较图',
        })
      } else if (chartType === 'dml') {
        if (!dmlY) { message.warning('请选择被解释变量'); setLoading(false); return }
        if (!dmlD) { message.warning('请选择处理变量'); setLoading(false); return }
        Object.assign(config, {
          y_var: dmlY, d_var: dmlD, controls: dmlCtrl,
          model: dmlModel, n_folds: dmlFolds,
          with_trees: dmlTrees,
          cluster_vars: dmlCluster, id_var: idVar, time_var: xVar,
          absorb: [], title: 'DML 稳健性：不同学习器下的处理效应',
        })
      } else if (chartType === 'parallel_trends'
        || chartType === 'did' || chartType === 'event_study') {
        if (idVar) config.id_var = idVar
        if (cohortVar) config.cohort_var = cohortVar
        if (policyTime != null) config.policy_time = policyTime
        config.window = ((preWindow && dynWindow)
          ? `${preWindow};${dynWindow}`
          : (preWindow || dynWindow || '-3,1;-5,5'))
        .replace(/[，\s]/g, '')
      }
      const res = await graphAPI.generate(chartType, config)
      if (res.data.error) {
        message.error(res.data.error)
      } else {
        setChartData(res.data)
        // 平行趋势未通过时自动调 AI 分析
        // chart_type 顶层是 'parallel_trends'，合并响应里仍带顶层 parallel_trend
        // AI 诊断只看顶层的 verdict（来自事前那段）
        if (res.data.parallel_trend) {
          triggerAiDiagnose(res.data)
        }
      }
    } catch (e) { message.error('生成失败') }
    setLoading(false)
  }

  const handleExportPng = async () => {
    try {
      const cfg = { x_var: xVar, y_var: yVar, group_var: groupVar }
      if (chartType === 'dml') {
        Object.assign(cfg, {
          y_var: dmlY, d_var: dmlD, controls: dmlCtrl,
          model: dmlModel, n_folds: dmlFolds, with_trees: dmlTrees,
          cluster_vars: dmlCluster, id_var: idVar, time_var: xVar,
          absorb: [], title: 'DML 稳健性：不同学习器下的处理效应',
        })
      } else if (chartType === 'heterogeneity') {
        Object.assign(cfg, {
          y_vars: hYVars, core_x: hCore, controls: hCtrl,
          dimensions: hDims.filter(d => d.group_var).map(d => ({
            name: d.name || d.group_var, group_var: d.group_var, split: d.split || 'median'
          })), confirmatory_dim: hConfirm,
          method: hMethod, se_type: hSE,
          cluster_vars: hSE === 'cluster' ? hCluster : [],
          id_var: idVar, time_var: xVar, absorb: [], title: '异质性系数比较图',
        })
      }
      const res = await graphAPI.exportPng(chartType, cfg)
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = `chart_${chartType}.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) { message.error('导出失败') }
  }

  const handleExportHeteroCsv = () => {
    if (!chartData) return
    const rows = chartData.rows || []
    const diffs = chartData.diffs || []
    const q = v => `"${v == null ? '' : String(v)}"`
    const lines = [['被解释变量', '维度', '行', '值', '标准误', 'p', '备注'].map(q).join(',')]
    rows.forEach(r => lines.push([r.y, r.panel, r.label, r.coef, r.se, r.p, `N=${r.n}`].map(q).join(',')))
    diffs.forEach(d => {
      if (d.diff != null) lines.push([d.y, d.panel, '组间差异 Δ', d.diff, d.se, d.p, d.stars || ''].map(q).join(','))
      if (d.inter_coef != null) lines.push([d.y, d.panel, '交互项', d.inter_coef, d.inter_se, d.inter_p, ''].map(q).join(','))
      if (d.p_adj != null) lines.push([d.y, d.panel, `校正后 p (${d.adj_method || ''})`, d.p_adj, '', d.base_p, d.survive ? '稳健✓' : '不稳健✗'].map(q).join(','))
    })
    // BOM 让 Excel 正确识别 UTF-8 中文
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = '异质性分组回归表.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const renderChart = () => {
    if (!chartData) return <div style={{ color: '#94a3b8', textAlign: 'center', padding: 100 }}>点击「生成图表」查看结果</div>

    if (chartData.chart_type === 'coefplot') {
      // 两个子模块二选一：?view=table 出分组回归表，否则系数图
      return hview === 'table' ? renderHeteroTable(chartData) : renderCoefplot(chartData)
    }

    if (chartData.chart_type === 'line' || chartData.chart_type === 'area') {
      const dataMap = {}
      chartData.series.forEach(s => {
        s.x.forEach((x, i) => {
          if (!dataMap[x]) dataMap[x] = { name: x }
          dataMap[x][s.name] = s.y[i]
        })
      })
      const data = Object.values(dataMap)
      const Compo = chartData.chart_type === 'area' ? AreaChart : LineChart
      const Shape = chartData.chart_type === 'area' ? Area : Line
      return (
        <ResponsiveContainer width="100%" height={350}>
          <Compo data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            {chartData.series.map((s, i) => (
              <Shape key={s.name} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]} fillOpacity={0.1} strokeWidth={2} />
            ))}
          </Compo>
        </ResponsiveContainer>
      )
    }

    if (chartData.chart_type === 'bar') {
      const data = chartData.labels.map((l, i) => ({ name: l, value: chartData.values[i] }))
      return (
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )
    }

    if (chartData.chart_type === 'scatter') {
      const pts = chartData.points || []
      if (pts.length === 0) return <div>无数据</div>
      const xs = pts.map(p => p.x)
      const ys = pts.map(p => p.y)
      const xMin = Math.min(...xs), xMax = Math.max(...xs)
      const yMin = Math.min(...ys), yMax = Math.max(...ys)
      const pad = { top: 30, right: 30, bottom: 40, left: 60 }
      const w = 700, h = 380
      const plotW = w - pad.left - pad.right
      const plotH = h - pad.top - pad.bottom
      const sx = v => pad.left + ((v - xMin) / (xMax - xMin || 1)) * plotW
      const sy = v => pad.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH
      // trend line
      const n = xs.length
      const meanX = xs.reduce((a, b) => a + b, 0) / n
      const meanY = ys.reduce((a, b) => a + b, 0) / n
      let num = 0, den = 0
      xs.forEach((x, i) => { num += (x - meanX) * (ys[i] - meanY); den += (x - meanX) ** 2 })
      const slope = den ? num / den : 0
      const intercept = meanY - slope * meanX
      const trendY1 = slope * xMin + intercept
      const trendY2 = slope * xMax + intercept
      // ticks
      const xTicks = 5, yTicks = 5
      const xTickVals = Array.from({ length: xTicks + 1 }, (_, i) => xMin + (i / xTicks) * (xMax - xMin))
      const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (i / yTicks) * (yMax - yMin))
      return (
        <div>
          <div style={{ marginBottom: 8, fontSize: 12, color: '#64748b' }}>
            相关系数: <strong>{chartData.correlation}</strong>　X: {chartData.x_var}　Y: {chartData.y_var}
          </div>
          <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 380 }}>
            {/* grid */}
            {yTickVals.map(v => <line key={'gy'+v} x1={pad.left} y1={sy(v)} x2={w - pad.right} y2={sy(v)} stroke="#f1f5f9" />)}
            {/* axes */}
            <line x1={pad.left} y1={pad.top} x2={pad.left} y2={h - pad.bottom} stroke="#e2e8f0" />
            <line x1={pad.left} y1={h - pad.bottom} x2={w - pad.right} y2={h - pad.bottom} stroke="#e2e8f0" />
            {/* x ticks */}
            {xTickVals.map(v => (
              <g key={'tx'+v}>
                <line x1={sx(v)} y1={h - pad.bottom} x2={sx(v)} y2={h - pad.bottom + 4} stroke="#cbd5e1" />
                <text x={sx(v)} y={h - pad.bottom + 16} textAnchor="middle" fontSize={10} fill="#94a3b8">{Math.round(v * 10) / 10}</text>
              </g>
            ))}
            {/* y ticks */}
            {yTickVals.map(v => (
              <g key={'ty'+v}>
                <line x1={pad.left - 4} y1={sy(v)} x2={pad.left} y2={sy(v)} stroke="#cbd5e1" />
                <text x={pad.left - 8} y={sy(v) + 4} textAnchor="end" fontSize={10} fill="#94a3b8">{Math.round(v)}</text>
              </g>
            ))}
            {/* trend line */}
            <line x1={sx(xMin)} y1={sy(trendY1)} x2={sx(xMax)} y2={sy(trendY2)} stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 3" />
            {/* points */}
            {pts.map((p, i) => (
              <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3.5} fill="#6366f1" fillOpacity={0.55} />
            ))}
            {/* axis labels */}
            <text x={w / 2} y={h - 4} textAnchor="middle" fontSize={12} fill="#64748b">{chartData.x_var}</text>
            <text x={14} y={h / 2} textAnchor="middle" fontSize={12} fill="#64748b" transform={`rotate(-90, 14, ${h / 2})`}>{chartData.y_var}</text>
          </svg>
        </div>
      )
    }

    if (chartData.chart_type === 'histogram') {
      const data = chartData.labels.map((l, i) => ({ name: l, value: chartData.values[i] }))
      return (
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="name" tick={{ fontSize: 10, angle: -45 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="value" fill="#6366f1" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )
    }

    // 平行趋势检验 + 动态效应：两段画。顶刊标准做法——
    // 上面一段窄窗口做事前检验，下面一段宽窗口做全期动态展示。
    if (chartData.chart_type === 'parallel_trends'
        && chartData.pre_test && chartData.dynamic) {
      return renderParallelTrendsTwoUp(chartData)
    }

    return <div>未知图表类型</div>
  }

  // 两段图：事前检验 + 动态效应。两个窗口在图表区顶部常驻，
  // 上下分开放，各自带那一段图用的颜色标签。
  function renderParallelTrendsTwoUp(chartData) {
    const pre = chartData.pre_test
    const dyn = chartData.dynamic
    const preCoeffs = [...(pre.coefficients || [])].sort((a, b) => a.rel_time - b.rel_time)
    const dynCoeffs = [...(dyn.coefficients || [])].sort((a, b) => a.rel_time - b.rel_time)
    if (preCoeffs.length === 0 && dynCoeffs.length === 0)
      return <div>没有可估的事件期系数</div>

    return (
      <div>
        {/* 上：事前检验（窄窗口）。窗口输入框常驻在图表区顶部，
            这里只显示这段用的是哪个窗口。 */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Tag color="geekblue">事前检验</Tag>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              当前窗口: <strong>{chartData.pre_window}</strong>
            </span>
          </div>
          {preCoeffs.length > 0 ? renderCoefficientChart(pre, preCoeffs, true) : (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>无可用系数</div>
          )}
        </div>

        {/* 分界线 */}
        <div style={{ borderTop: '1px dashed #cbd5e1', margin: '24px 0' }} />

        {/* 下：动态效应（宽窗口） */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Tag color="purple">动态效应</Tag>
            <span style={{ fontSize: 12, color: '#64748b' }}>
              当前窗口: <strong>{chartData.dynamic_window}</strong>
            </span>
          </div>
          {dynCoeffs.length > 0 ? renderCoefficientChart(dyn, dynCoeffs, false) : (
            <div style={{ color: '#94a3b8', fontSize: 12 }}>无可用系数</div>
          )}
        </div>

        {/* AI 诊断：只看事前那段 */}
        {(aiDiagLoading || aiDiag) && (
          <Card
            size="small"
            style={{ marginTop: 12, border: '1px solid #fbbf24', background: '#fffbeb' }}
            title={<span style={{ fontSize: 13 }}>🤖 AI 诊断建议</span>}
          >
            {aiDiagLoading ? (
              <div style={{ textAlign: 'center', padding: 16 }}>
                <Spin size="small" /> <span style={{ color: '#94a3b8', fontSize: 12, marginLeft: 8 }}>正在分析平行趋势结果…</span>
              </div>
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: '#374151' }}>
                {aiDiag.content || '(无内容)'}
              </div>
            )}
          </Card>
        )}
      </div>
    )
  }

  // 右上角窗口期输入框：输入完 debounce 600ms，自动重跑那一段。
  // 注意：整个图表的依赖变量（x_var/y_var/group_var/cohort_var/id_var）
  // 在父组件里已经设好，这里只用两个 window 拼成 `pre;dyn` 给后端。
  const regenerateTimer = useRef(null)
  function regenerateOne(which, newPre, newDyn) {
    if (regenerateTimer.current) clearTimeout(regenerateTimer.current)
    regenerateTimer.current = setTimeout(async () => {
      try {
        const config = {
          x_var: xVar, y_var: yVar, group_var: groupVar,
          id_var: idVar || undefined,
          cohort_var: cohortVar || undefined,
          window: `${newPre || '-3,1'};${newDyn || '-5,5'}`,
        }
        const res = await graphAPI.generate('parallel_trends', config)
        if (res.data.error) { message.error(res.data.error); return }
        // 局部重跑：把响应替换到 chartData 里，AI 诊断沿用顶层 parallel_trend
        setChartData(res.data)
        if (res.data.parallel_trend && res.data.parallel_trend.verdict === '未通过') {
          triggerAiDiagnose(res.data)
        }
      } catch (e) { message.error('窗口期更新失败') }
    }, 600)
  }

  function WindowInput({ value, onChange }) {
    return (
      <Input
        size="small"
        value={value}
        onChange={e => onChange(e.target.value)}
        // flex 布局里不写 flexShrink 会被两侧文本挤成十几像素宽，
        // 用户根本输不进东西
        style={{ width: 90, flexShrink: 0 }}
        placeholder="窗口期"
      />
    )
  }

  // 单张系数图（被两段式和兼容路径复用）
  function renderCoefficientChart(chartData, coeffs, isPreTest) {
    if (coeffs.length === 0) return <div>没有可估的事件期系数</div>

    // 横轴按时间从左到右排：d_5 d_4 d_3 d_2 | current | d_1 … d_5。
    // 事前用升序（rel_time 从 -5 到 -2），即越早的在越左边，和 Stata 的
    // event_plot 一致；原来写的降序把最靠近政策的一期排到了最左，
    // 横轴会变成 -2 -3 -4 -5 0 1 2…，读起来时间在倒流。
    // 用序号而不是 label 做 X 轴——d_2/d_3 政策前后各出现一次，重复类目
    // 会让 ReferenceLine 定位失效。
    const pre = coeffs.filter(c => c.rel_time < 0).sort((a, b) => a.rel_time - b.rel_time)
    const post = coeffs.filter(c => c.rel_time >= 0).sort((a, b) => a.rel_time - b.rel_time)
    const ordered = [...pre, ...post]

    const data = ordered.map((c, i) => ({
      idx: i,
      label: c.rel_time === 0 ? 'current' : `d_${Math.abs(c.rel_time)}`,
      rel_time: c.rel_time,
      estimate: c.estimate,
      ci_low: c.ci_low, ci_high: c.ci_high,
      p_value: c.p_value,
      pre: c.rel_time < 0,
    }))
    const currentIdx = data.findIndex(d => d.rel_time === 0)
    const pt = chartData.parallel_trend
    const yMin = Math.min(...data.map(d => d.ci_low))
    const yMax = Math.max(...data.map(d => d.ci_high))
    const preSig = data.filter(d => d.pre && d.p_value != null && d.p_value < 0.05)
    const isDid = chartData.emphasis === 'pre' || isPreTest
    // 图表固定高 400px，上下边距 24+30=54px → 绘图区高 346px。
    // pxPerUnit = 绘图区高 / 数据域跨度，CoefErrorDot 用它把 ci 高度转成像素。
    const CHART_H = 400, MARGIN_TOP = 24, MARGIN_BOT = 30
    const plotH = CHART_H - MARGIN_TOP - MARGIN_BOT
    const pxPerUnit = yMax > yMin ? plotH / (yMax - yMin) : null

  const TONE_COLORS = { red: '#dc2626', green: '#16a34a', amber: '#d97706', grey: '#64748b' }
  const ptTone = pt?.tone || (pt?.verdict === '通过' ? 'green' : 'red')

  return (
    <div>
      <div style={{ marginBottom: 10, fontSize: 12, color: '#64748b', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>方法: <strong>{chartData.method || 'Sun & Abraham (2021)'}</strong></span>
        {chartData.n_cohorts != null && <span>队列数: <strong>{chartData.n_cohorts}</strong></span>}
        {pt && (
          <span>平行趋势:
            <strong style={{ color: TONE_COLORS[ptTone] || '#64748b' }}>
              {' '}{pt.verdict === '通过' ? '通过' : (pt.tone === 'amber' ? '通过（未检出效应）' : pt.verdict)}
            </strong>
            <span style={{ color: '#94a3b8', marginLeft: 4 }}>{pt.message}</span>
          </span>
        )}
        {isDid && preSig.length > 0 && (
            <span style={{ color: '#dc2626' }}>
              {preSig.length} 个事前系数显著（{preSig.map(d => d.label).join('、')}）
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={data} margin={{ top: 24, right: 40, bottom: 30, left: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="idx" type="number" domain={[0, data.length - 1]}
                   ticks={data.map(d => d.idx)}
                   tickFormatter={i => (data[i] ? data[i].label : '')}
                   tick={{ fontSize: 12 }}
                   label={{ value: chartData.cohort_var
                            ? `政策实施相对时间（基期 ${chartData.cohort_var} − 1）`
                            : '政策实施相对时间',
                            position: 'bottom', offset: 10, fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} domain={[yMin, yMax]}
                   label={{ value: isDid ? '回归系数（事前应围绕 0）' : '回归系数',
                            angle: -90, position: 'insideLeft', fontSize: 12 }} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null
                const d = payload[0].payload
                return (
                  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6,
                                padding: '8px 10px', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {d.rel_time === 0 ? '政策当期' : `相对期 ${d.rel_time > 0 ? '+' : ''}${d.rel_time}`}
                      {d.rel_time < 0 && '（政策前）'}
                    </div>
                    <div>系数: {d.estimate}</div>
                    <div>95% CI: [{d.ci_low}, {d.ci_high}]</div>
                    <div>P 值: {d.p_value}{d.p_value < 0.05 ? '（显著）' : '（不显著）'}</div>
                  </div>
                )
              }}
            />
            <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />
            {currentIdx >= 0 && (
              <ReferenceLine x={currentIdx} stroke="#94a3b8" strokeWidth={1} />
            )}
            {/* 事前检验段不连线：检验看的是每个系数离 0 多远，
                连成一条线会读出「事前有趋势」的误导。动态效应段才连线。 */}
            {!isPreTest && (
              <Line type="linear" dataKey="estimate" stroke="#6366f1" strokeWidth={2}
                    dot={false} activeDot={false} isAnimationActive={false} />
            )}
            <Scatter dataKey="estimate" shape={<CoefErrorDot isDid={isDid} pxPerUnit={pxPerUnit} />} legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
          {isDid ? (
            <>
              <b style={{ color: '#475569' }}>实心 = 政策前，空心 = 政策后。</b>
              事前系数围绕 0 且不显著，平行趋势假设成立；事前已有显著偏离，
              说明两组在政策前走势就不同，DID 的因果解释要打折。<br />
              基期（k = −1）不进入估计，所以事前最小是 d_2。
            </>
          ) : (
            <>
              基期（k = −1）不进入估计，所以图上不出现 d_1。<br />
              事后系数的走势反映处理效应持续多久——这是 DID 因果解释力的关键证据。
            </>
          )}
        </div>
        {/* 功效层：独立一行显示，不塞进 note（note 已经很密）。
            回答"这个『未被拒绝』到底排除了多大的违背"。 */}
        {pt && pt.power_summary && (
          <div style={{
            marginTop: 6, fontSize: 11.5, lineHeight: 1.7,
            color: ptTone === 'green' ? '#166534' : ptTone === 'red' ? '#991b1b' : '#92400e',
          }}>
            <b>功效：</b>{pt.power_summary}
          </div>
        )}
        {/* 黄/灰状态的补充说明。写清楚"未检出效应"和"无法判断"分别意味着什么，
            避免用户把这两种状态读成"通过"。 */}
        {pt && pt.note && pt.tone && pt.tone !== 'green' && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            lineHeight: 1.7, whiteSpace: 'pre-wrap',
            color: pt.tone === 'red' ? '#991b1b' : pt.tone === 'amber' ? '#92400e' : '#334155',
            background: pt.tone === 'red' ? '#fef2f2' : pt.tone === 'amber' ? '#fffbeb' : '#f8fafc',
            border: '1px solid ' + (pt.tone === 'red' ? '#fecaca' : pt.tone === 'amber' ? '#fde68a' : '#e2e8f0'),
          }}>
            {pt.note}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: 32 }}>
      {/* flexWrap：窗口窄于「左栏 280 + 右栏最小宽」时换行，
          否则右栏会被挤成几像素宽，ResponsiveContainer 量到 0 就画不出图。
          minWidth 兜底，让右栏至少有个能看的宽度。 */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Left: settings */}
        <div style={{ width: 280, flexShrink: 0 }}>
          <Card title="图表类型" size="small" style={{ marginBottom: 16 }}>
            {allowed.map((sec, si) => (
              <div key={sec.stage} style={{ marginBottom: si < allowed.length - 1 ? 14 : 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', letterSpacing: 0.3, marginBottom: 6 }}>
                  {sec.stage}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {sec.items.map(c => (
                    <div key={c.key}
                      onClick={() => setChartType(c.key)}
                      style={{
                        padding: '10px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center', fontSize: 12,
                        border: `1px solid ${chartType === c.key ? '#6366f1' : '#e2e8f0'}`,
                        background: chartType === c.key ? '#eef2ff' : 'transparent',
                        color: chartType === c.key ? '#4f46e5' : '#475569',
                      }}
                    >
                      <div style={{ fontSize: 18 }}>{c.icon}</div>
                      <div style={{ marginTop: 4 }}>{c.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Card>

          {chartType === 'dml' && (
            <DmlPanel
              variables={variables}
              y={dmlY} setY={setDmlY}
              d={dmlD} setD={setDmlD}
              ctrl={dmlCtrl} setCtrl={setDmlCtrl}
              cluster={dmlCluster} setCluster={setDmlCluster}
              model={dmlModel} setModel={setDmlModel}
              folds={dmlFolds} setFolds={setDmlFolds}
              trees={dmlTrees} setTrees={setDmlTrees}
              idVar={idVar} timeVar={xVar}
            />
          )}

          {chartType === 'heterogeneity' && (
            <HeteroPanel
              variables={variables}
              yVars={hYVars} setYVars={setHYVars}
              core={hCore} setCore={setHCore}
              ctrl={hCtrl} setCtrl={setHCtrl}
              dims={hDims} setDims={setHDims}
              method={hMethod} setMethod={setHMethod}
              se={hSE} setSE={setHSE}
              cluster={hCluster} setCluster={setHCluster}
              confirm={hConfirm} setConfirm={setHConfirm}
              idVar={idVar} timeVar={xVar}
            />
          )}

          <Card title="数据设置" size="small" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>X 轴</div>
              <Select value={xVar} onChange={setXVar} style={{ width: '100%' }} size="small"
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>Y 轴</div>
              <Select value={yVar} onChange={setYVar} style={{ width: '100%' }} size="small"
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>分组</div>
              <Select value={groupVar} onChange={setGroupVar} style={{ width: '100%' }} size="small" allowClear
                options={variables.map(v => ({ label: v, value: v }))} />
            </div>
          </Card>

          {(chartType === 'parallel_trends'
            || chartType === 'did' || chartType === 'event_study') && (
            <Card title="事件研究设置" size="small" style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>个体 ID 变量</div>
                <Select
                  value={idVar}
                  onChange={setIdVar}
                  style={{ width: '100%' }}
                  size="small"
                  placeholder="选择面板个体标识"
                  options={variables.map(v => ({ label: v, value: v }))}
                />
              </div>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>处理时点变量</div>
                <Select
                  value={cohortVar}
                  onChange={setCohortVar}
                  style={{ width: '100%' }}
                  size="small"
                  allowClear
                  placeholder="自动识别（first_treat / first_year）"
                  options={variables.map(v => ({ label: v, value: v }))}
                />
              </div>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>政策实施时点</div>
                <Select
                  value={policyTime}
                  onChange={setPolicyTime}
                  style={{ width: '100%' }}
                  size="small"
                  allowClear
                  placeholder="有处理时点变量时可留空"
                  options={timePoints.map(t => ({ label: String(t), value: t }))}
                />
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                窗口期分别设置在两段图的右上角。事前段默认 <strong>-3,1</strong>，
                动态段默认 <strong>-5,5</strong>，可各自改成自己想要的窗口。改完自动重跑那一段。
              </div>
            </Card>
          )}

          <Space direction="vertical" style={{ width: '100%' }}>
            <Button type="primary" icon={<LineChartOutlined />} block onClick={handleGenerate} loading={loading} size="large">
              生成图表
            </Button>
            <Button icon={<DownloadOutlined />} block onClick={handleExportPng} disabled={!chartData}>
              导出 PNG
            </Button>
          </Space>
        </div>

        {/* Right: chart */}
        <div style={{ flex: 1, minWidth: 340 }}>
          {/* 窗口期常驻：没生成图也能先选好，再点「生成图表」。
              已经有图时改输入框会 debounce 重跑对应那一段。
              两个窗口上下分开放，各自带那一段图用的颜色标签——
              并排放会被看成一组，分不清哪个输入框管哪张图。 */}
          {chartType === 'parallel_trends' && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12,
              padding: '10px 12px', background: '#f8fafc', borderRadius: 8,
              fontSize: 12, color: '#64748b',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Tag color="geekblue" style={{ margin: 0 }}>标准检验</Tag>
                <span>窗口期</span>
                <WindowInput
                  value={preWindow}
                  onChange={v => { setPreWindow(v); if (chartData) regenerateOne('pre', v, dynWindow) }}
                />
                <span style={{ color: '#94a3b8', fontSize: 11 }}>事前为主，看政策前是否平行</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Tag color="purple" style={{ margin: 0 }}>动态效应</Tag>
                <span>窗口期</span>
                <WindowInput
                  value={dynWindow}
                  onChange={v => { setDynWindow(v); if (chartData) regenerateOne('dyn', preWindow, v) }}
                />
                <span style={{ color: '#94a3b8', fontSize: 11 }}>全期动态，看处理效应持续多久</span>
              </div>
              {!chartData && (
                <span style={{ color: '#cbd5e1', fontSize: 11 }}>设好后点下方「生成图表」</span>
              )}
            </div>
          )}
          {chartType === 'heterogeneity' && chartData && hview === 'table' && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
                          fontSize: 12, color: '#64748b' }}>
              <span>分组回归表</span>
              <Button size="small" icon={<DownloadOutlined />} onClick={handleExportHeteroCsv}>导出表格 CSV</Button>
            </div>
          )}
          <Card size="small" styles={{ body: { padding: 24 } }}>
            {loading ? <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div> : renderChart()}
          </Card>
        </div>
      </div>
    </div>
  )
}


// ── 异质性系数图：配置面板 ──
// 一个维度 = 一个分组变量 + 一种切分方式。增减维度就是加减这里的一行，
// 对应 Stata 模板里 foreach 后面的那个变量列表。
function HeteroPanel({ variables, yVars, setYVars, core, setCore, ctrl, setCtrl,
                       dims, setDims, method, setMethod, se, setSE, cluster, setCluster,
                       confirm, setConfirm, idVar, timeVar }) {
  const opts = variables.map(v => ({ label: v, value: v }))
  const update = (i, patch) => setDims(d => d.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <Card title="异质性设置" size="small" style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
          被解释变量（可多选，各占一栏）
        </div>
        <Select mode="multiple" value={yVars} onChange={setYVars} style={{ width: '100%' }}
          size="small" placeholder="如 growth、TobinQ" options={opts} showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
          核心解释变量（图上要看的那个系数）
        </div>
        <Select value={core[0] || undefined} onChange={v => setCore(v ? [v] : [])}
          style={{ width: '100%' }} size="small" placeholder="如 Treat×Post"
          options={opts} showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>控制变量</div>
        <Select mode="multiple" value={ctrl} onChange={setCtrl} style={{ width: '100%' }}
          size="small" placeholder="可多选，两组用同一套控制变量" options={opts} showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <ATooltip title="理论事前指向的那个维度设为确认性，它单独成族用 Holm 控 FWER；其余维度按探索性用 BH 控 FDR。留空则全部按探索性。">
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, cursor: 'help' }}>
            确认性维度（事前假设，用 Holm；其余用 BH）
          </div>
        </ATooltip>
        <Select value={confirm || undefined} onChange={v => setConfirm(v || null)}
          style={{ width: '100%' }} size="small" allowClear placeholder="留空＝全部探索性"
          options={dims.filter(d => d.group_var)
            .map(d => ({ label: d.name || d.group_var, value: d.name || d.group_var }))}
          showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>回归设定</div>
        <Space wrap size={[6, 6]}>
          <Select value={method} onChange={setMethod} style={{ width: 128 }} size="small"
            options={[
              { value: 'twoway_fe', label: '双向固定效应' },
              { value: 'fe', label: '个体固定效应' },
              { value: 'ols', label: '混合 OLS' },
            ]} />
          <Select value={se} onChange={setSE} style={{ width: 128 }} size="small"
            options={[
              { value: 'cluster', label: '聚类稳健' },
              { value: 'robust', label: '异方差稳健' },
              { value: 'classical', label: '普通标准误' },
            ]} />
        </Space>
        {se === 'cluster' && (
          <div style={{ marginTop: 8 }}>
            <Select mode="multiple" value={cluster} onChange={setCluster}
              style={{ width: '100%' }} size="small" placeholder="聚类层级（可多选）"
              options={opts} showSearch />
          </div>
        )}
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 1.6 }}>
          面板结构沿用事件研究页的个体变量与 X 轴时间变量：
          {idVar ? `个体 ${idVar}` : '未指定个体变量'} ／ {timeVar ? `时间 ${timeVar}` : '未指定时间变量'}
        </div>
      </div>

      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4, fontWeight: 500 }}>
        异质性维度
      </div>
      {dims.map((d, i) => (
        <div key={i} style={{ border: '1px dashed #e2e8f0', borderRadius: 8,
                              padding: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input size="small" placeholder="维度名（如 金融化）" value={d.name}
              onChange={e => update(i, { name: e.target.value })} style={{ flex: 1 }} />
            {dims.length > 1 && (
              <Button size="small" type="text" danger icon={<DeleteOutlined />}
                onClick={() => setDims(x => x.filter((_, j) => j !== i))} />
            )}
          </div>
          <Select value={d.group_var || undefined} onChange={v => update(i, { group_var: v })}
            style={{ width: '100%', marginBottom: 6 }} size="small" placeholder="分组变量"
            options={opts} showSearch />
          <Select value={d.split || 'median'} onChange={v => update(i, { split: v })}
            style={{ width: '100%' }} size="small"
            options={[
              { value: 'median', label: '按中位数分高/低两组' },
              { value: 'mean', label: '按均值分高/低两组' },
              { value: 'above0', label: '是否大于 0' },
            ]} />
        </div>
      ))}
      <Button block size="small" icon={<PlusCircleOutlined />}
        onClick={() => setDims([...dims, { name: '', group_var: null, split: 'median' }])}>
        再加一个维度
      </Button>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, lineHeight: 1.7 }}>
        每个维度单独跑高、低两组回归，系数与 95% 置信区间画在同一坐标轴上；
        并列在切点上的观测归入低组，保证两组不重叠。
      </div>
    </Card>
  )
}


// ── DML 稳健性：配置面板 ──
// 一个处理变量、一套控制变量、若干学习器。定位是 DID/面板回归的稳健性检验，
// 不是另一套主回归——DoubleML 本身没有 absorb 固定效应的机制，后端会先做
// 组内去均值把个体与年份效应吸收掉，估计量才和 reghdfe 口径可比。
function DmlPanel({ variables, y, setY, d, setD, ctrl, setCtrl, cluster, setCluster,
                   model, setModel, folds, setFolds, trees, setTrees, idVar, timeVar }) {
  const opts = variables.map(v => ({ label: v, value: v }))
  return (
    <Card title="DML 稳健性设置" size="small" style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>被解释变量 (Y)</div>
        <Select value={y || undefined} onChange={setY} style={{ width: '100%' }} size="small"
          placeholder="选择因变量" options={opts} showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
          处理变量 (D)
        </div>
        <Select value={d || undefined} onChange={setD} style={{ width: '100%' }} size="small"
          placeholder="如 Treat×Post / 连续型处理变量" options={opts} showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>控制变量 (X)</div>
        <Select mode="multiple" value={ctrl} onChange={setCtrl} style={{ width: '100%' }}
          size="small" placeholder=" nuisance 要用到的协变量" options={opts} showSearch />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>模型与折数</div>
        <Space wrap size={[6, 6]}>
          <Select value={model} onChange={setModel} style={{ width: 150 }} size="small"
            options={[
              { value: 'plr', label: 'PLR（部分线性）' },
              { value: 'irm', label: 'IRM（ATE，需二值 D）' },
            ]} />
          <Select value={folds} onChange={setFolds} style={{ width: 110 }} size="small"
            options={[2, 3, 5, 10].map(v => ({ value: v, label: `${v} 折` }))} />
        </Space>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>聚类层级（单选）</div>
        <Select value={cluster[0] || undefined} onChange={v => setCluster(v ? [v] : [])}
          style={{ width: '100%' }} size="small"
          placeholder="标准误按哪个维度聚类；不选则为同方差标准误"
          options={opts} showSearch />
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, lineHeight: 1.6 }}>
          DoubleML 不支持 Cameron–Gelbach–Miller 双聚类，选多个也只会按第一个算；
          要双聚类口径请看基准回归。
        </div>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
        <Checkbox checked={trees} onChange={e => setTrees(e.target.checked)}>
          加入树模型（RF / GBM / LightGBM）
        </Checkbox>
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
        默认只跑线性族（OLS / Lasso / Ridge / ElasticNet），几秒出结果。
        勾选树模型在几万行的面板上要跑几分钟。<br />
        面板结构沿用事件研究页：{idVar ? `个体 ${idVar}` : '未指定个体变量'} ／{' '}
        {timeVar ? `时间 ${timeVar}` : '未指定时间变量'}；后端会先做组内去均值
        吸收这两组固定效应。
      </div>
    </Card>
  )
}

// ── 异质性系数图：渲染 ──
// 横向系数图（coefplot / forest plot）。x 轴是系数，每个维度一个 Panel，
// 组内两行：高点实心圆 = 高组，菱形 = 低组。所有栏共用同一个 x 尺度，
// 否则读者会在两栏之间做出离谱的横向比较。
const HI_COLOR = '#2563eb'
const LO_COLOR = '#b45309'
const PLOT_W = 250
const ROW_H = 30

function renderHeteroTable(cd) {
  const rows = cd.rows || []
  const star = p => (p == null ? '' : p < 0.01 ? '***' : p < 0.05 ? '**' : p < 0.1 ? '*' : '')
  const f4 = v => (v == null ? '—' : Number(v).toFixed(4))
  const f3 = v => (v == null ? '—' : Number(v).toFixed(3))
  const find = (y, panel, kind) => rows.find(r => r.y === y && r.panel === panel && r.kind === kind) || {}
  const diffOf = (y, panel) => (cd.diffs || []).find(d => d.y === y && d.panel === panel) || {}

  const cellBeta = (c) => (
    <div>
      <span style={{ fontWeight: 600 }}>{f4(c.coef)}</span>
      <span style={{ color: '#16a34a' }}>{c.p != null ? ' ' + star(c.p) : ''}</span>
      <div style={{ fontSize: 10, color: '#94a3b8' }}>({f4(c.se)})　N={c.n ?? '—'}</div>
    </div>
  )

  return (
    <div>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, lineHeight: 1.6 }}>
        处理变量 <b>{cd.x_var}</b> ｜ {cd.method} ｜ {cd.se_type}。
        每个维度各跑高、低两组回归；<b>Δ = 高组β − 低组β</b>（与交互项互为印证）；
        「校正后」列给出逐族校正的 p（确认性 Holm / 探索性 BH），<b>✓ = 校正后仍 &lt;0.05</b>。
      </div>
      {(cd.y_cols || []).map(y => (
        <div key={y} style={{ marginBottom: 24 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>被解释变量：{y}</div>
          <Table size="small" bordered pagination={false}
            dataSource={(cd.panels || []).map(p => ({ ...p, key: p.name }))}
            columns={[
              { title: '维度', dataIndex: 'name', key: 'name', width: 110,
                render: (v, r) => (
                  <div><b>{v}</b>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>
                      {r.split === 'mean' ? '按均值' : r.split === 'above0' ? '是否>0' : '按中位数'}
                      {r.g_varies != null && ` · 企业内变异 ${(r.g_varies * 100).toFixed(0)}%`}
                    </div>
                  </div>) },
              { title: '高组 β (SE)', key: 'hi', align: 'right', width: 130,
                render: (_, r) => cellBeta(find(y, r.name, 'high')) },
              { title: '低组 β (SE)', key: 'lo', align: 'right', width: 130,
                render: (_, r) => cellBeta(find(y, r.name, 'low')) },
              { title: 'Δ 差异', key: 'diff', align: 'right', width: 100,
                render: (_, r) => { const d = diffOf(y, r.name)
                  return d.diff != null
                    ? (<div>{f4(d.diff)}<div style={{ fontSize: 10, color: '#94a3b8' }}>p={f3(d.p)} {d.stars || ''}</div></div>)
                    : '—' } },
              { title: '校正后 p', key: 'adj', align: 'right', width: 130,
                render: (_, r) => { const d = diffOf(y, r.name)
                  if (d.p_adj == null) return '—'
                  return (<span style={{ color: d.survive ? '#16a34a' : '#b45309', fontWeight: 700 }}>
                    {d.adj_method} {f3(d.p_adj)} {d.survive ? '✓' : '✗'}</span>) } },
              { title: '交互项 p', key: 'inter', align: 'right', width: 92,
                render: (_, r) => { const d = diffOf(y, r.name)
                  return d.inter_p != null ? `${f3(d.inter_p)} ${d.inter_stars || ''}`
                    : (d.inter_skipped ? '不可识别' : '—') } },
            ]} />
        </div>
      ))}
      {cd.notes && cd.notes.length > 0 && (
        <div style={{ fontSize: 11.5, color: '#64748b', lineHeight: 1.7, borderTop: '1px dashed #e2e8f0', paddingTop: 8 }}>
          {cd.notes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}
    </div>
  )
}

function renderCoefplot(cd) {
  const rows = cd.rows || []
  if (!rows.length) {
    return <div style={{ color: '#f43f5e', padding: 24 }}>没有可画的系数</div>
  }
  // 所有栏共用一个定义域
  let lo = Infinity, hi = -Infinity
  rows.forEach(r => {
    if (r.lo != null) lo = Math.min(lo, r.lo)
    if (r.hi != null) hi = Math.max(hi, r.hi)
  })
  if (!isFinite(lo) || !isFinite(hi)) { lo = -1; hi = 1 }
  const pad = (hi - lo) * 0.08 || 0.1
  lo -= pad; hi += pad
  if (lo > 0) lo = -pad
  if (hi < 0) hi = pad
  const sx = v => ((v - lo) / (hi - lo)) * PLOT_W

  const fmt = v => (v == null ? '' : v.toFixed(4))
  const pct = v => (v == null ? '—' : (v * 100).toFixed(0) + '%')
  const ticks = []
  const step = niceStep(hi - lo)
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(t)

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap',
                    fontSize: 11, color: '#64748b', alignItems: 'center' }}>
        <Space size={16}>
          <Space size={4}>
            <svg width="12" height="12"><circle cx="6" cy="6" r="5" fill={HI_COLOR} /></svg>
            高组
          </Space>
          <Space size={4}>
            <svg width="12" height="12">
              <rect x="1.5" y="1.5" width="9" height="9" fill={LO_COLOR}
                transform="rotate(45 6 6)" />
            </svg>
            低组
          </Space>
          <span>横线为 95% 置信区间；竖虚线为 0；Δ 校正后 p&lt;0.05 记 ✓</span>
        </Space>
        <span>
          处理变量：<b>{cd.x_var}</b> ｜ {cd.method} ｜ {cd.se_type}
          {cd.method && cd.method.indexOf('DoubleML') >= 0
            ? ' ｜ 每行一个学习器，看结论会不会随 nuisance 拟合方式而变'
            : ''}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {(cd.y_cols || []).map(y => {
          const diffs = (cd.diffs || []).filter(d => d.y === y)
          return (
            <div key={y} style={{ minWidth: 420 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                被解释变量：{y}
              </div>
              {(cd.panels || []).map(p => {
                const rs = rows.filter(r => r.y === y && r.panel === p.name)
                if (!rs.length) return null
                const d = diffs.find(x => x.panel === p.name) || {}
                return (
                  <div key={p.name} style={{
                    border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 10,
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      background: '#f8fafc', padding: '5px 10px', fontSize: 12,
                      borderBottom: '1px dashed #e2e8f0',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between',
                                    alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                        <Space size={6}>
                          <b>Panel：{p.name}</b>
                          {d.family === 'confirmatory'
                            ? <Tag color="blue" style={{ fontSize: 10, margin: 0 }}>确认性 · Holm</Tag>
                            : <Tag style={{ fontSize: 10, margin: 0 }}>探索性 · BH</Tag>}
                        </Space>
                        <span style={{ fontSize: 11, color: '#64748b' }}>
                          {d.base_p != null && <span>原始 p = {d.base_p < 0.001 ? '0.000' : d.base_p.toFixed(3)}{d.stars || ''}</span>}
                          {d.inter_p != null && d.inter_p !== d.base_p && (
                            <span style={{ marginLeft: 8 }}>交互项 p = {d.inter_p < 0.001 ? '0.000' : d.inter_p.toFixed(3)}{d.inter_stars || ''}</span>
                          )}
                          {d.p_adj != null && (
                            <span style={{ marginLeft: 8, color: d.survive ? '#16a34a' : '#b45309', fontWeight: 700 }}>
                              校正后({d.adj_method}) p = {d.p_adj < 0.001 ? '0.000' : d.p_adj.toFixed(3)}{d.survive ? ' ✓' : ' ✗'}
                            </span>
                          )}
                          {!d.inter_p && d.inter_skipped && (
                            <ATooltip title={d.inter_skipped}>
                              <span style={{ marginLeft: 8, color: '#f59e0b' }}>交互项不可识别</span>
                            </ATooltip>
                          )}
                          {d.agree === false && (
                            <ATooltip title="两个口径结论不一致，见图表下方说明">
                              <Tag color="orange" style={{ marginLeft: 8, fontSize: 10 }}>口径不一致</Tag>
                            </ATooltip>
                          )}
                        </span>
                      </div>
                      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 3 }}>
                        高组 N={p.n_high}（处理占比 {pct(p.support?.high?.treated_share)} / 聚类 {p.support?.high?.clusters ?? '—'}）
                        · 低组 N={p.n_low}（处理占比 {pct(p.support?.low?.treated_share)} / 聚类 {p.support?.low?.clusters ?? '—'}）
                        {p.g_varies != null && ` · 分组企业内变异 ${pct(p.g_varies)}`}
                      </div>
                    </div>
                    {rs.map((r, i) => {
                      const c = HI_COLOR_LOCAL(r)
                      return (
                        <div key={i} style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '3px 10px',
                          borderTop: i ? '1px dotted #f1f5f9' : 'none',
                        }}>
                          <div style={{ width: 96, fontSize: 11.5, flexShrink: 0,
                                        color: r.kind === 'high' ? HI_COLOR : LO_COLOR }}>
                            {r.label}
                          </div>
                          <svg width={PLOT_W} height={ROW_H} style={{ flexShrink: 0 }}>
                            <line x1={sx(0)} y1={3} x2={sx(0)} y2={ROW_H - 3}
                              stroke="#a16207" strokeWidth="1" strokeDasharray="3 3" />
                            {r.lo != null && r.hi != null && (
                              <line x1={sx(r.lo)} y1={ROW_H / 2} x2={sx(r.hi)} y2={ROW_H / 2}
                                stroke={c} strokeWidth="1.4" strokeDasharray="4 3" />
                            )}
                            {r.lo != null && r.hi != null && [r.lo, r.hi].map((v, k) => (
                              <line key={k} x1={sx(v)} y1={ROW_H / 2 - 4}
                                x2={sx(v)} y2={ROW_H / 2 + 4} stroke={c} strokeWidth="1.4" />
                            ))}
                            {r.kind === 'high' ? (
                              <circle cx={sx(r.coef)} cy={ROW_H / 2} r="5" fill={c}
                                stroke="#fff" strokeWidth="1.2" />
                            ) : (
                              <rect x={sx(r.coef) - 4.5} y={ROW_H / 2 - 4.5} width="9" height="9"
                                fill={c} stroke="#fff" strokeWidth="1.2"
                                transform={`rotate(45 ${sx(r.coef)} ${ROW_H / 2})`} />
                            )}
                            <text x={sx(r.coef) + (r.coef >= 0 ? 8 : -8)} y="10"
                              textAnchor={r.coef >= 0 ? 'start' : 'end'}
                              style={{ fontSize: 10, fill: '#334155' }}>
                              {fmt(r.coef)}{r.stars || ''}
                            </text>
                          </svg>
                          <div style={{ fontSize: 11, color: '#94a3b8', width: 58,
                                        flexShrink: 0, textAlign: 'right' }}>
                            N={r.n}
                          </div>
                        </div>
                      )
                    })}
                    <div style={{
                      borderTop: '1px dashed #f1f5f9', padding: '3px 10px 5px',
                      display: 'flex', alignItems: 'center',
                    }}>
                      <div style={{ width: 96, flexShrink: 0 }} />
                      <svg width={PLOT_W} height="14" style={{ flexShrink: 0 }}>
                        <line x1="0" y1="7" x2={PLOT_W} y2="7" stroke="#e2e8f0" />
                        {ticks.map((t, k) => (
                          <g key={k}>
                            <line x1={sx(t)} y1="4" x2={sx(t)} y2="10" stroke="#cbd5e1" />
                            <text x={sx(t)} y="13" textAnchor="middle"
                              style={{ fontSize: 8.5, fill: '#94a3b8' }}>
                              {t.toFixed(2)}
                            </text>
                          </g>
                        ))}
                      </svg>
                      <div style={{ width: 58, flexShrink: 0 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {(cd.notes || []).length > 0 && (
        <Alert type="warning" showIcon style={{ marginTop: 8, borderRadius: 8 }}
          message="读这张图之前" description={<div>
            {cd.notes.map((n, i) => (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.9 }}>· {n}</div>
            ))}
          </div>} />
      )}
    </div>
  )
}

function HI_COLOR_LOCAL(r) { return r.kind === 'high' ? HI_COLOR : LO_COLOR }

function niceStep(span) {
  const raw = span / 5
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))))
  const n = raw / mag
  const step = n >= 5 ? 5 * mag : n >= 2 ? 2 * mag : mag
  return step
}
