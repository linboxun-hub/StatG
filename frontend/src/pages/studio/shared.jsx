// Chat 模块共享件：上下文、结果对象、共用的展示组件、设计令牌。
//
// 拆出来是因为 Chat（Codex 风格外壳）和 Work（工作台）都要用同一份结果结构
// 和同一套 Provenance 展示，而两者互不 import——共用的东西必须有第三个落脚点，
// 否则 Studio.jsx ←→ Chat 会绕成循环 import。
//
// 颜色令牌不是估的，是从用户确认的那份 HTML 原型里逐值抄的。改这里全局生效。
import React from 'react'
import { Table, Tag, Space, Typography } from 'antd'

const { Text } = Typography

// ─────────────────────────────────────────────────────────────
// 上下文：Chat / Work 两个模块读写同一份状态。
// ─────────────────────────────────────────────────────────────
const StudioCtx = React.createContext(null)
const useStudio = () => React.useContext(StudioCtx)

const PROVIDED_BY = {
  manual:   { label: '工作台手动跑', color: 'default' },
  agent:    { label: 'Chat 里 agent 跑', color: 'purple' },
  pipeline: { label: '固化的工作流跑', color: 'geekblue' },
}

// 证据编号。曾经有三处各写各的：种子 ev_20261004_001、Chat 'ev_' + Date.now().toString(36)
// （实测渲染成 ev_mutruces）、工作流 'ev_pl_' + ...。base36 那种对人没信息量，
// 也没法按字符串排序。统一成 日期_时分秒_随机后缀——能读、能排、能对上具体哪一次跑。
function newEvidenceId() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `ev_${stamp}_${Math.random().toString(36).slice(2, 6)}`
}

// 从会话内容推标题：取第一条用户消息的前 18 个字。
// 没有人愿意在列表里看到"新的对话"排成一列——那等于没有标题。
// 一直没说过话的就保留原标题，不要显示成空字符串。
function deriveTitle(current, messages) {
  if (current && current !== '新的对话') return current
  const first = messages.find((m) => m.role === 'user')
  if (!first) return current || '新的对话'
  const t = first.text.replace(/\s+/g, ' ').trim()
  return t.length > 18 ? t.slice(0, 18) + '…' : t
}

// 相对时间。会话列表里用"3 分钟前"而不是绝对时间戳——
// 人要的是"这个对话新不新"，不是"它诞生于几点几分"。
function relTime(ts) {
  const d = Date.now() - ts
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前'
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前'
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前'
  return new Date(ts).toLocaleDateString('zh-CN')
}

// ─────────────────────────────────────────────────────────────
// 设计令牌：Codex 风格深色壳。
// 逐值取自用户确认的原型 D:\桌面\大二上\杂乱无序\codex-ui.html，
// 不是我估的——那一次估错了好几轮。
// ─────────────────────────────────────────────────────────────
const CD = {
  // 三层底色：标题栏最深，侧栏次之，主区最浅。深浅关系不能反，
  // 反了侧栏会像浮在上面而不是嵌在窗口里。
  titlebar:   '#1a1a1a',
  sidebar:    '#181818',
  main:       '#1f1f1f',
  line:       '#2a2a2a',   // 所有 1px 描边共用一个值
  text:       '#e5e5e5',
  textNav:    '#d0d0d0',   // 导航项 / 项目 / chip
  textSub:    '#b0b0b0',   // 子项 / 底部用户
  textMenu:   '#bbb',      // 菜单项
  muted:      '#888',      // 分区标题、图标按钮、窗口按钮
  ph:         '#777',      // 输入框 placeholder
  hover:      '#2a2a2a',
  hoverSoft:  '#333333',
  focusRing:  '#3a3a3a',
  inputBox:   '#2a2a2a',
  inputBoxHi: '#2e2e2e',
  sendIdleBg: '#4a4a4a',
  sendIdleFg: '#888888',
  blue:       '#2c7be5',
  blueHi:     '#3b82f6',
  userBubble: '#2c7be5',
  aiBubble:   '#262626',
  accent:     '#2c7be5',
}

// 结构尺寸，同样逐值抄自原型
const CD_SIZE = {
  sidebarW: 260,
  titlebarH: 32,
  welcomeIcon: 120,
  welcomeText: 30,
}

// 种子结果的行。放在 SEED_RESULT 后面定义，所以对象里直接用 SEED_ROWS 引用——
// 顺序不能颠倒。
const SEED_ROWS = [
  { variable: '_cons',  role: 'stat',    coef: 4.9855,  std_err: 0.0639, t: 78.05,  p: '0.000', stars: '***', key: 'r1' },
  { variable: 'exper',  role: 'core',    coef: 0.0389,  std_err: 0.0022, t: 17.393, p: '0.000', stars: '***', key: 'r2' },
  { variable: 'educ',   role: 'core',    coef: 0.0781,  std_err: 0.0036, t: 21.862, p: '0.000', stars: '***', key: 'r3' },
  { variable: 'black',  role: 'control', coef: -0.1763, std_err: 0.0181, t: -9.768, p: '0.000', stars: '***', key: 'r4' },
  { variable: 'south',  role: 'control', coef: -0.1554, std_err: 0.0153, t: -10.165, p: '0.000', stars: '***', key: 'r5' },
  { variable: 'smsa',   role: 'control', coef: 0.1359,  std_err: 0.0171, t: 7.947,  p: '0.000', stars: '***', key: 'r6' },
]

const SEED_RESULT = {
  id: 'res_seed_1',
  kind: 'table',
  title: '基准回归 · lwage ~ exper + educ',
  producedBy: 'manual',          // manual | agent | pipeline
  evidenceId: 'ev_seed',
  createdAt: Date.now() - 1000 * 60 * 42,
  meta: {
    method: '最小二乘回归 (OLS)', dep_var: 'lwage', nobs: 3010,
    r_squared: 0.2523, adj_r_squared: 0.2513, f_stat: 253.496,
    se_type: '普通标准误',
  },
  rows: SEED_ROWS,
}

// 结果表的列。放共享件里是因为 Chat 和 Work 都渲染同一张表，
// 而两处各自声明一份列定义已经害过一次人（后端缺 married 时两边行数不一致）。
const RESULT_COLS = [
  { title: '变量', dataIndex: 'variable', key: 'variable', width: 110 },
  { title: '角色', dataIndex: 'role', key: 'role', width: 76,
    render: (v) => ({ core: <Tag color="blue">核心</Tag>, control: <Tag>控制</Tag>, stat: <Tag color="default">常数</Tag> }[v] || v) },
  { title: '系数', dataIndex: 'coef', key: 'coef', width: 92, align: 'right' },
  { title: '标准误', dataIndex: 'std_err', key: 'std_err', width: 88, align: 'right' },
  { title: 't 值', dataIndex: 't', key: 't', width: 78, align: 'right' },
  { title: 'P>|t|', dataIndex: 'p', key: 'p', width: 80, align: 'right' },
  { title: '显著性', dataIndex: 'stars', key: 'stars', width: 78, align: 'right' },
]

function ResultTable({ result, compact }) {
  if (!result || result.kind !== 'table') return null
  const { meta } = result
  return (
    <div>
      <Table
        size="small"
        columns={RESULT_COLS}
        dataSource={result.rows}
        pagination={false}
        bordered
        style={{ marginBottom: 8 }}
      />
      {!compact && (
        <Space split={<span style={{ color: '#94a3b8' }}>|</span>} wrap style={{ fontSize: 11, color: '#64748b' }}>
          <span>N = {meta.nobs}</span>
          <span>R² = {meta.r_squared}</span>
          <span>Adj-R² = {meta.adj_r_squared}</span>
          <span>F = {meta.f_stat}</span>
          <span>{meta.se_type}</span>
        </Space>
      )}
    </div>
  )
}

function Provenance({ result, dark }) {
  const p = PROVIDED_BY[result.producedBy] || PROVIDED_BY.manual
  const dim = dark ? '#8f8f8f' : undefined
  return (
    <Space size={6} wrap style={{ fontSize: 10 }}>
      <Tag color={p.color} style={{ marginInlineEnd: 0 }}>{p.label}</Tag>
      <Text type="secondary" style={{ fontSize: 10, color: dim }}>证据 {result.evidenceId}</Text>
      <Text type="secondary" style={{ fontSize: 10, color: dim }}>
        {new Date(result.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </Space>
  )
}

export {
  StudioCtx, useStudio, PROVIDED_BY, deriveTitle, relTime, newEvidenceId,
  CD, CD_SIZE, SEED_RESULT, RESULT_COLS, SEED_ROWS, ResultTable, Provenance,
}
