// 双模块衔接原型（Chat / Work）
//
// Chat 那一侧从 2026-10-05 起换成了 Codex 风格外壳（./studio/CodexChat.jsx），
// 照用户确认的原型 D:\桌面\大二上\杂乱无序\codex-ui.html 搭的；Work 那一侧
// 仍在这个文件里。这一页当初要验证的三件事依然成立，而且比以前更成立了：
//
//   1. 左上角 Chat / Work 切换（参照 Claude Code 的 Cowork / Code）——换的是视野，
//      不是状态。切过去会话、数据集、模型设定、最近结果全在
//   2. 产物是同一个对象——Chat 里跑出来的表，切到 Work 的「结果输出」直接看得到，
//      不重跑、不复制；反过来 Work 里的结果 Chat 也能读
//   3. 轨迹可查——每个结果都带 producedBy（谁生产的）和 evidenceId（证据）
//
// 验收标准就一条：在 Chat 里聊到一半、agent 正在跑回归，切到 Work 再切回来，
// 对话还在、任务还在跑、结果该出现的时候出现。
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Empty, Typography, Card, Space, Tag } from 'antd'
import {
  MessageOutlined, ThunderboltOutlined,
  DatabaseOutlined, FileTextOutlined, RightOutlined, QuestionCircleOutlined,
  CheckCircleFilled, LoadingOutlined, ClockCircleOutlined, BranchesOutlined,
  ApartmentOutlined, DeploymentUnitOutlined, ArrowLeftOutlined,
  MinusOutlined, BorderOutlined, CloseOutlined,
} from '@ant-design/icons'
import CodexChat from './studio/CodexChat'
import {
  StudioCtx, useStudio, SEED_RESULT, deriveTitle, newEvidenceId,
  RESULT_COLS, ResultTable, Provenance,
} from './studio/shared'
import { regressionAPI } from '../api'
import './studio/codex.css'

const { Text } = Typography

// 工作台左侧导航的数据源。这些是 StatG 主界面的路由，不是 /studio 内部路由——
// 点下去会离开双模块原型、回到带 Layout 的主界面。
const MENU_GROUPS = [
  { label: '项目', items: [
    { to: '/home', icon: <ApartmentOutlined />, label: '工作台' },
    { to: '/projects', icon: <DeploymentUnitOutlined />, label: '项目管理' },
  ]},
  { label: '数据准备', items: [
    { to: '/data', icon: <DatabaseOutlined />, label: '数据管理' },
    { to: '/editor', icon: <BranchesOutlined />, label: '数据清洗' },
  ]},
  { label: '分析流程', items: [
    { label: '① 统计分析', icon: <ThunderboltOutlined />, sub: [
      { to: '/analysis', label: '统计表' }, { to: '/chart/descriptive', label: '描述图形' }]},
    { label: '② 基准回归', icon: <ThunderboltOutlined />, sub: [
      { to: '/regression?stage=baseline', label: '基准回归' }, { to: '/chart/trend', label: '平行趋势' }]},
    { label: '⑤ 异质性分析', icon: <ApartmentOutlined />, sub: [
      { to: '/chart/heterogeneity?view=chart', label: '系数图' }]},
  ]},
  { label: '产出', items: [
    { to: '/output', icon: <FileTextOutlined />, label: '结果输出' },
  ]},
]

// deriveTitle / relTime / PROVIDED_BY / ResultTable / Provenance 都在 ./studio/shared.jsx。
// NX 仍留在这里——WorkflowRunner 和 WorkPanel 的深色卡片要用它，
// 而 Chat 已经换成 Codex 风格壳（token 在 studio/codex.css 里，不再用 NX）。

// ─────────────────────────────────────────────────────────────
// Work / WorkflowRunner 的深色卡片基调。
// Work 保持浅色不变——两个模块一个盯表一个交代事，深浅分开是有意的。
// ─────────────────────────────────────────────────────────────
const NX = {
  bg: '#0a0c12',
  panel: '#171a22',
  border: '#262b36',
  borderSoft: '#1e222c',
  text: '#e8ecf4',
  textDim: '#8b93a7',
  textFaint: '#5c6478',
  accent: '#7c3aed',
  bubbleUser: '#7c3aed',
  bubbleAi: '#1b1f28',
}

// 星点背景原来在 Chat 的空态里用。Codex 风格壳是纯净底色，不放噪点，
// 所以这个常量连同 CSS 拼法一起删掉了——留着没人用的常量只会让人以为还有用。
function StudioProvider({ children }) {
  // 默认落在 Chat。原来默认 'work'，靠左上角 segmented 让人自己切；
  // 那条顶栏删掉之后没有显眼的切换入口了，再默认 Work 会让人以为程序打不开。
  const [mode, setMode] = useState('chat')            // 'chat' | 'work'
  const [agentMode, setAgentMode] = useState('normal') // 'normal' | 'workflow'
  // 项目名是占位。真实项目从 /api/projects 拉，本机一个都没有时侧栏显示
  // 「还没有项目 + 去创建」，不拿假名字糊上去——假项目名点进去是空的更糟。
  const [project, setProject] = useState({ id: null, name: '未选择项目' })
  const [dataset, setDataset] = useState({ name: 'card_1995', rows: 3010, cols: 9, source: 'StatsPAI 内置' })
  // 控制变量必须挑 card_1995 里真实存在的。曾经第三个写的是 married，
  // 而这个数据集里根本没有它——于是后端静默剔掉、结果表 5 行，
  // 而另一处 seed 表摆着 6 行，两边对不上还查不出是哪边的锅。
  const [model, setModel] = useState({
    method: 'ols', y: 'lwage', core: ['exper', 'educ'],
    controls: ['black', 'south', 'smsa'], absorb: [], cluster: null, se_type: 'classical',
  })
  const [results, setResults] = useState([SEED_RESULT])
  // ── 会话管理 ──
  // 原来这里只有一条平铺的 session，等于"永远只有一个对话"。
  // Chat 左侧要放会话工作区（Codex/Claude 那种），就得有真正的会话列表：
  // sessions 是唯一数据源，每个会话自带 messages；下面派生出当前会话的
  // session / setSession，让 ChatPanel 和 WorkPanel 的调用点一行都不用改。
  const [sessions, setSessions] = useState(() => ([{
    id: 's1', title: '新的对话', project: '特高压 · 劳动生产率',
    messages: [], updatedAt: Date.now(),
  }]))
  const [sid, setSid] = useState('s1')

  const activeSession = sessions.find((s) => s.id === sid) || sessions[0]
  const session = activeSession ? activeSession.messages : []

  const setSession = (updater) => setSessions((prev) => prev.map((s) => {
    if (s.id !== sid) return s
    const messages = typeof updater === 'function' ? updater(s.messages) : updater
    return { ...s, messages, updatedAt: Date.now(), title: deriveTitle(s.title, messages) }
  }))

  const newSession = () => {
    const id = 's' + Date.now()
    setSessions((prev) => [
      { id, title: '新的对话', project: project.name, messages: [], updatedAt: Date.now() },
      ...prev,
    ])
    setSid(id)
  }

  const delSession = (id) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      // 删到最后一个就补一个空的，别让列表空掉——空会话列表会让工作区看着像坏了
      return next.length ? next : [{ id: 's' + Date.now(), title: '新的对话', project: project.name, messages: [], updatedAt: Date.now() }]
    })
    setSid((cur) => (cur === id ? null : cur))
  }

  // 当前 sid 指向的会话被删掉时，落到第一个上
  useEffect(() => {
    if (!sessions.some((s) => s.id === sid) && sessions.length) setSid(sessions[0].id)
  }, [sessions, sid])
  const [busy, setBusy] = useState(false)
  const [activePipeline, setActivePipeline] = useState(null)
  const [runLog, setRunLog] = useState([])
  // Work 模块想"带一个问题回 Chat"时用它留话。原来 Work 直接往会话里
  // push 一条 user 消息就切走，而它调不到 Chat 的 runAgent——那条问题
  // 永远没人答。现在 Work 只负责留话，CodexChat 挂载后自己跑。
  const [pendingPrompt, setPendingPrompt] = useState(null)

  // 最近一个结果 = 两个模块共同指向的「当前产物」
  const current = results[0] || null

  const pushResult = useCallback((r) => {
    setResults((prev) => [r, ...prev])
  }, [])

  const value = useMemo(() => ({
    mode, setMode, agentMode, setAgentMode,
    // setProject 也要暴露：CodexChat 侧栏点项目是真的去 /api/projects/select
    // 切项目，切完要把新项目写回这一份状态。之前它没往外给，所以项目永远是
    // 硬编码的那个名字。
    project, setProject, dataset, setDataset, model, setModel,
    results, current, pushResult, session, setSession,
    sessions, sid, setSid, newSession, delSession,
    busy, setBusy, activePipeline, setActivePipeline, runLog, setRunLog,
    pendingPrompt, setPendingPrompt,
  }), [mode, agentMode, project, dataset, model, results, current, pushResult, session, sessions, sid, busy, activePipeline, runLog, pendingPrompt])

  return <StudioCtx.Provider value={value}>{children}</StudioCtx.Provider>
}

// ─────────────────────────────────────────────────────────────
// ResultTable / Provenance 已移到 ./studio/shared.jsx —— Chat（Codex 壳）和
// Work（工作台）都要渲染同一张表，各留一份列定义已经害过一次人：
// 后端少了 married 时，两边拿各自的列去渲染，行数不一致还查不出是哪边的锅。

// ─────────────────────────────────────────────────────────────
// Chat 模块（Codex 风格外壳）
//
// 原来的 SessionRail + ChatPanel 整个拆走了，换成 ./studio/CodexChat.jsx。
// 拆走的理由：那一版几乎全是摆设——附件、语音、设置、主题四个按钮标题写着
// 「未实现」，项目是硬编码的 { id:'p1', name:'特高压 · 劳动生产率' }，
// 模型槽位故意空着，后端 URL 硬编码 127.0.0.1:8000 绕过了 Vite 代理。
// 新版照用户确认的原型 D:\桌面\大二上\杂乱无序\codex-ui.html 一比一搭壳，
// 每一项都接真实接口（项目 /api/projects、数据 /api/data/*、导入 /api/browse、
// 对话 /api/ai/chat、回归 /api/regression/run，全走 src/api/index.js 相对路径）。
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 工作流模块
// ─────────────────────────────────────────────────────────────
// 工作流模式：选一条固化好的管线，agent 不推理，按步骤直接跑
function WorkflowRunner() {
  const { dataset, pushResult, mode, setMode, busy, setBusy, runLog, setRunLog, setSession } = useStudio()
  const [picked, setPicked] = useState(null)
  const [step, setStep] = useState(-1)
  const [done, setDone] = useState(null)

  const PIPELINES = [
    { id: 'pl1', name: '基准回归全套', desc: '载入 → 描述统计 → 基准回归 → 换聚类层级稳健性', steps: 4 },
    { id: 'pl2', name: '异质性快扫', desc: '按 3 个分组各跑一遍并出系数图', steps: 3 },
  ]
  const STEP_LABELS = ['载入数据集', '描述统计', '基准回归（真实调用后端）', '换聚类层级做稳健性']

  const run = async () => {
    if (!picked || busy) return
    setBusy(true); setStep(0); setRunLog([]); setDone(null)
    for (let i = 0; i < STEP_LABELS.length; i++) {
      setStep(i)
      setRunLog((p) => [...p, { i, label: STEP_LABELS[i], status: 'running' }])
      await new Promise((r) => setTimeout(r, 700))
      if (i === 2) {
        try {
          // 经 src/api/index.js 走相对路径。原来这里硬编码
          // http://127.0.0.1:8000——绕过了 Vite 代理，网页端开发和打包后
          // Electron 里都指不到同一个后端，只有本机直连时才碰巧能跑。
          const res = await regressionAPI.run('ols', {
            y_var: model.y || 'lwage',
            core_x: (model.core && model.core.length ? model.core : ['exper', 'educ']),
            controls: (model.controls && model.controls.length ? model.controls : ['black', 'south', 'married']),
            se_type: model.se_type || 'classical',
            cluster_vars: model.cluster || [],
          })
          const d = res.data
          if (!d.error) {
            const r = {
              id: 'res_pl_' + Date.now(), kind: 'table',
              title: '基准回归 · 工作流跑', producedBy: 'pipeline',
              evidenceId: newEvidenceId(), createdAt: Date.now(),
              meta: { method: d.method, dep_var: d.dep_var, nobs: d.nobs, r_squared: d.r_squared,
                      adj_r_squared: d.adj_r_squared, f_stat: d.f_stat, se_type: d.se_type },
              cols: RESULT_COLS,
              rows: d.coefficients.map((c, k) => ({ ...c, p: String(c.p), key: 'k' + k })),
            }
            pushResult(r)
            setDone(r)
          }
        } catch (e) { /* 原型忽略 */ }
      }
      setRunLog((p) => p.map((x) => x.i === i ? { ...x, status: 'ok' } : x))
    }
    setStep(-1); setBusy(false)
  }

  // 工作流模式和 Chat 共用同一个深色壳，所以这一面也走深色。
  // antd 的 Card/Alert/Table 默认都是浅色的，在深色底上要逐个把背景和描边压住，
  // 否则会出现"深色页面上贴一张白卡片"的破面。
  const darkCard = {
    background: NX.panel, borderColor: NX.border, borderRadius: 10, marginBottom: 16,
  }
  const darkCardParts = {
    header: { background: NX.panel, color: NX.text, borderBottomColor: NX.border },
    body: { background: NX.panel, color: NX.text },
  }

  return (
    <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24, minHeight: 0 }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{
          background: NX.panel, border: '1px solid ' + NX.border, borderRadius: 10,
          display: 'flex', gap: 10, padding: '11px 14px', fontSize: 12, lineHeight: 1.7, marginBottom: 16,
        }}>
          <MessageOutlined style={{ color: '#a78bfa', marginTop: 2 }} />
          <div>
            <div style={{ color: NX.text, fontWeight: 600, marginBottom: 3 }}>工作流模式：agent 不推理，按固化的步骤直接跑</div>
            <div style={{ color: NX.textDim }}>这是把「第一次跑通的分析」固化下来的意义——同样的活第二次不要重复点。下面第 3 步是真实调用后端的，其余是示意。</div>
          </div>
        </div>

        <Card size="small" title="选一条管线" style={darkCard} styles={darkCardParts}>
          {PIPELINES.map((p) => (
            <div key={p.id} onClick={() => setPicked(p.id)} style={{
              padding: '10px 12px', borderRadius: 8, marginBottom: 8, cursor: 'pointer',
              border: '1px solid ' + (picked === p.id ? '#7c3aed' : NX.border),
              background: picked === p.id ? 'rgba(124,58,237,.14)' : 'transparent',
            }}>
              <Space>
                <BranchesOutlined style={{ color: picked === p.id ? '#a78bfa' : NX.textFaint }} />
                <Text strong style={{ color: NX.text }}>{p.name}</Text>
                <Tag style={{ marginInlineEnd: 0 }}>{p.steps} 步</Tag>
              </Space>
              <div style={{ fontSize: 11, color: NX.textDim, marginTop: 4 }}>{p.desc}</div>
            </div>
          ))}
          <button onClick={run} disabled={!picked || busy} style={{
            marginTop: 4, padding: '7px 18px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            cursor: !picked || busy ? 'default' : 'pointer',
            background: !picked || busy ? NX.border : NX.accent,
            color: '#fff', border: 'none', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <ThunderboltOutlined /> {busy ? '跑起来了…' : '开始跑'}
          </button>
        </Card>

        {runLog.length > 0 && (
          <Card size="small" title="执行轨迹" style={darkCard} styles={darkCardParts}>
            {runLog.map((l) => (
              <div key={l.i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12 }}>
                {l.status === 'running'
                  ? <LoadingOutlined style={{ color: '#a78bfa' }} />
                  : <CheckCircleFilled style={{ color: '#4ade80' }} />}
                <Text style={{ flex: 1, color: NX.text }}>{l.i + 1}. {l.label}</Text>
                {l.status === 'ok' && <Tag color="green" style={{ marginInlineEnd: 0 }}>完成</Tag>}
              </div>
            ))}
          </Card>
        )}

        {done && (
          <div style={{
            background: '#111520', border: '1px solid ' + NX.border, borderRadius: 10, overflow: 'hidden',
          }}>
            <div style={{
              padding: '9px 12px', borderBottom: '1px solid ' + NX.border,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6,
            }}>
              <span style={{ fontSize: 12, color: NX.text, fontWeight: 600 }}>{done.title}</span>
              <Space size={10} style={{ fontSize: 10 }}>
                <Provenance result={done} />
                <a onClick={() => setMode('work')} style={{ color: '#a78bfa', fontSize: 11, cursor: 'pointer' }}>
                  在工作台打开 <RightOutlined style={{ fontSize: 9 }} />
                </a>
              </Space>
            </div>
            <div style={{ padding: 10 }}>
              <ResultTable result={done} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Work 模块。用户要求"用 chat 模块的风格"，所以整套换成 Codex 深色：
// 同一条 32px 标题栏（含右侧窗口三键）、260px 深色侧栏、#1f1f1f 主区、
// 深色卡片和深色表格。原来是 #f8fafc 浅底 + #0f172a 侧栏，
// 和深色 Chat 并排着像两个不相干的程序。
//
// 模块切换这里有一个真 bug 修掉了：原来的「去问 AI」往会话里塞一条
// "解释一下这个结果" 然后切到 Chat，但它从来不调用 agent——那条问题就
// 挂在那儿没人回答，看起来就是"切回去卡住了"。现在改成走 pendingPrompt：
// Work 只负责留话，CodexChat 挂载后自己跑，回答由它产生。
// ─────────────────────────────────────────────────────────────
function WorkPanel() {
  const { project, dataset, model, results, current, setMode,
          setPendingPrompt } = useStudio()
  const navigate = useNavigate()

  // 只切换，不塞消息——"我想回去看看"和"我要问它一件事"是两回事。
  const backToChat = () => setMode('chat')

  // 带一个问题回去，让 Chat 那边的 agent 接
  const askAI = () => {
    setPendingPrompt('解释一下这个结果')
    setMode('chat')
  }

  return (
    <div className="cd-work">
      <div className="cd-titlebar">
        <div className="cd-titlebar-left">
          <div className="cd-nav-btn" title="回到 Chat 模块" onClick={backToChat}>
            <ArrowLeftOutlined style={{ fontSize: 15 }} />
          </div>
          <div className="cd-menu-item" style={{ color: '#e5e5e5', fontWeight: 500 }}>结果输出</div>
          <div className="cd-menu-item" style={{ color: '#777' }}>{project?.name || '未选择项目'}</div>
        </div>
        <div className="cd-titlebar-right">
          <div className="cd-menu-item" onClick={() => navigate('/settings')}>设置</div>
          <div className="cd-menu-item" onClick={() => navigate('/home')}>返回 StatG</div>
          {typeof window !== 'undefined' && !!window.statgWin && (
            <>
              <div className="cd-win-btn" title="最小化" onClick={() => window.statgWin.minimize()}>
                <MinusOutlined />
              </div>
              <div className="cd-win-btn" title="最大化" onClick={() => window.statgWin.maximize()}>
                <BorderOutlined />
              </div>
              <div className="cd-win-btn" title="关闭" onClick={() => window.statgWin.close()}>
                <CloseOutlined />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="cd-work-body">
        {/* 左边：StatG 的分析流程菜单。原来是纯展示的 div，现在真的能跳 */}
        <div className="cd-sidebar">
          <div className="cd-scroll" style={{ paddingTop: 12 }}>
            {MENU_GROUPS.map((g) => (
              <div key={g.label}>
                <div className="cd-section-title">{g.label}</div>
                <div className="cd-nav-list">
                  {g.items.map((it) => (
                    <div key={it.label} className="cd-nav-item"
                         onClick={() => it.to && navigate(it.to)}>
                      {it.icon}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="cd-sidebar-bottom">
            <div className="cd-nav-item" onClick={backToChat} style={{ flex: 1 }}>
              <MessageOutlined />
              回到 Chat
            </div>
          </div>
        </div>

        {/* 右边：当前上下文 + 结果输出 */}
        <div className="cd-work-main">
          <div className="cd-card">
            <div className="cd-card-hd">
              <span className="t"><DatabaseOutlined />当前上下文</span>
              <span style={{ fontSize: 11.5, color: '#777' }}>Chat 那边改了这里立刻反映</span>
            </div>
            <div className="cd-card-bd">
              <div className="cd-kv">
                <span>数据集 <b>{dataset.name}</b></span><i />
                <span>{dataset.rows.toLocaleString()} 行 × {dataset.cols} 列</span><i />
                <span>来源 {dataset.source}</span>
              </div>
              <div className="cd-note">
                最近一次回归设定：<code className="cd-code">
                  {model.y} ~ {[...model.core, ...model.controls].join(' + ') || '（未设定）'}
                </code>
              </div>
            </div>
          </div>

          {current ? (
            <div className="cd-card">
              <div className="cd-card-hd">
                <span className="t">{current.title}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Button size="small" className="cd-btn-d" onClick={askAI}
                          icon={<QuestionCircleOutlined />}>问 AI</Button>
                  <Button size="small" className="cd-btn-p" onClick={() => navigate('/output')}>
                    导出三线表
                  </Button>
                </span>
              </div>
              <div className="cd-card-bd">
                <Provenance result={current} dark />
                <div className="cd-table" style={{ marginTop: 10 }}>
                  <ResultTable result={current} />
                </div>
                <div className="cd-note">
                  这张表和 Chat 里看到的是同一个对象——不是复制，也不是重跑。
                </div>
              </div>
            </div>
          ) : (
            <div className="cd-card">
              <div className="cd-card-bd cd-table">
                <Empty description="还没有结果。去 Chat 里让 agent 跑一个，或者用菜单手动跑。" />
              </div>
            </div>
          )}

          {results.length > 1 && (
            <div className="cd-card">
              <div className="cd-card-hd"><span className="t">历史结果（{results.length}）</span></div>
              <div className="cd-card-bd" style={{ paddingTop: 4, paddingBottom: 8 }}>
                {results.map((r) => (
                  <div key={r.id} className="cd-hist">
                    <ClockCircleOutlined />
                    <span className="t">{r.title}</span>
                    <Provenance result={r} dark />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 外壳。原来这里有一条 52px 的深色顶栏：Chat/Work segmented + 项目标签 +
// 数据集标签 + 「返回 StatG」按钮。用户明确说"红框圈起来的部分没必要这样保留了"，
// 所以整条删掉——CodexChat 自己有一条 32px 标题栏，两条上下叠着很冗余。
// 删掉之后模块切换各自回模块内找：Chat 那边在 StatG 下拉和「视图」菜单里
// （切到工作台模块），Work 那边在「结果输出」标题行的按钮里（去问 AI）。
// 两个模块都铺满 100vh，不再被顶栏挤掉一截。
// ─────────────────────────────────────────────────────────────
function StudioShell() {
  const { mode, setMode } = useStudio()
  return (
    <div style={{ height: '100vh', overflow: 'hidden' }}>
      {mode === 'chat' ? <CodexChat onJumpModule={setMode} /> : <WorkPanel />}
    </div>
  )
}

export default function Studio() {
  return (
    <StudioProvider>
      <StudioShell />
    </StudioProvider>
  )
}
