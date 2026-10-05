// Chat 模块：Codex 风格深色外壳。
//
// 这一份不是另起一套设计，是照用户确认的原型 D:\桌面\大二上\杂乱无序\codex-ui.html
// 一比一照搬的结构与配色，然后把原来标着「未实现」的地方换成真功能。
//
// 与旧版 ChatPanel 的关键差别：旧版几乎全是摆设——附件、语音、设置、主题四个按钮
// 写着「未实现」，项目是硬编码的 { id:'p1', name:'特高压 · 劳动生产率' }，
// 模型槽位故意空着，后端 URL 硬编码 127.0.0.1:8000 绕过了 Vite 代理。
// 这里每一项都接到真实接口：项目走 /api/projects、数据集走 /api/data/*、
// 导入走 /api/browse + /api/data/upload、对话走 /api/ai/chat（配了模型才有）、
// 回归走 /api/regression/run，全部经 src/api/index.js 的相对路径。
//
// 布局沿用原型的三段：标题栏 32px / 侧栏 260px / 主区。
// 深浅关系固定为 标题栏最深 → 侧栏次之 → 主区最浅，反了侧栏会像浮着而不是嵌着。
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import {
  Dropdown, Input, Tag, Spin, Modal, message,
} from 'antd'
import {
  ArrowLeftOutlined, ArrowRightOutlined, MinusOutlined, BorderOutlined,
  CloseOutlined, DownOutlined, BellOutlined, SearchOutlined, EditOutlined,
  ClockCircleOutlined, SettingOutlined, FolderOutlined,
  FileTextOutlined, DownloadOutlined, PlusOutlined, SendOutlined,
  RobotOutlined, LoadingOutlined, CheckCircleFilled, ExclamationCircleOutlined,
  ThunderboltOutlined, DatabaseOutlined, EyeOutlined, DeleteOutlined,
  ReloadOutlined, UploadOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  useStudio, ResultTable, Provenance, relTime, newEvidenceId,
} from './shared'
import { projectAPI, dataAPI, aiAPI, regressionAPI } from '../../api'
import { PRESETS } from '../Settings'
import './codex.css'

const { TextArea } = Input
const AI_CONFIG_KEY = 'stata_assistant_ai_config'

// 机型配置只存在浏览器本地（与 Settings 页同一个 key）。
// 读不到就不假装有模型——直接告诉用户去配，而不是拿一个假模型名糊在界面上。
function loadAiConfig() {
  try { return JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '{}') } catch { return {} }
}

function saveAiConfig(patch) {
  const next = { ...loadAiConfig(), ...patch }
  try { localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(next)) } catch { /* 隐私模式下写不进去 */ }
  return next
}

// 当前预设有哪些模型可选。预设来自 Settings 页导出的 PRESETS，不复制一份。
// 找不到匹配预设（用户手填的自定义）时返回空数组，由界面提示去设置页填。
function presetModelsOf(cfg) {
  if (!cfg.model && !cfg.preset) return []
  const hit = PRESETS.find((p) => p.name === cfg.preset)
  return hit ? (hit.models || []) : (cfg.model ? [cfg.model] : [])
}

// ─────────────────────────────────────────────────────────────
// 标题栏
// ─────────────────────────────────────────────────────────────
function TitleBar({ onBack, onFwd, canBack, canFwd, onToggleSide, onMenu }) {
  // 窗口控制按钮只在 Electron 里有意义。浏览器里原生 chrome 自己管这三个键，
  // 再画一遍就是两套关闭按钮。所以整个 .cd-titlebar-right 按运行环境整组隐藏。
  const inElectron = typeof window !== 'undefined' && !!window.statgWin

  const winBtn = (kind, node) => (
    <div
      className="cd-win-btn"
      title={kind}
      onClick={() => window.statgWin?.[
        kind === '最小化' ? 'minimize' : kind === '最大化' ? 'maximize' : 'close'
      ]?.()}
    >{node}</div>
  )

  return (
    <div className="cd-titlebar">
      <div className="cd-titlebar-left">
        <div
          className="cd-nav-btn"
          title="后退（上一个会话）"
          style={{ opacity: canBack ? 1 : .35, pointerEvents: canBack ? 'auto' : 'none' }}
          onClick={onBack}
        >
          <ArrowLeftOutlined style={{ fontSize: 15 }} />
        </div>
        <div
          className="cd-nav-btn"
          title="前进（下一个会话）"
          style={{ opacity: canFwd ? 1 : .35, pointerEvents: canFwd ? 'auto' : 'none' }}
          onClick={onFwd}
        >
          <ArrowRightOutlined style={{ fontSize: 15 }} />
        </div>
        <div className="cd-nav-btn" title="显示/隐藏侧边栏 Ctrl+Shift+S" onClick={onToggleSide}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="5" width="22" height="14" rx="6" />
            <line x1="9" y1="5" x2="9" y2="19" />
          </svg>
        </div>

        {[
          { key: '文件', items: [
            { key: 'new',  icon: <PlusOutlined />,     label: '新建对话' },
            { key: 'imp',  icon: <UploadOutlined />,   label: '导入项目文件夹…' },
            { key: 'data', icon: <DatabaseOutlined />, label: '导入数据文件…' },
            { type: 'divider' },
            { key: 'back', icon: <ArrowLeftOutlined />, label: '返回 StatG 主界面' },
          ]},
          { key: '编辑', items: [
            { key: 'clear', icon: <DeleteOutlined />, label: '清空当前会话' },
            { key: 'rename', icon: <EditOutlined />, label: '重命名当前会话' },
          ]},
          { key: '视图', items: [
            { key: 'side',  icon: <EyeOutlined />,    label: '切换侧边栏' },
            { key: 'work',  icon: <ThunderboltOutlined />, label: '切到工作台模块' },
          ]},
          { key: '帮助', items: [
            { key: 'help', icon: <FileTextOutlined />, label: '打开使用说明' },
            { key: 'about', icon: <RobotOutlined />,  label: '关于 StatG' },
          ]},
        ].map((m) => (
          <Dropdown
            key={m.key}
            trigger={['click']}
            menu={{ items: m.items, onClick: ({ key }) => onMenu(key) }}
          >
            <div className="cd-menu-item">{m.key}</div>
          </Dropdown>
        ))}
      </div>

      {inElectron && (
        <div className="cd-titlebar-right">
          {winBtn('最小化', <MinusOutlined />)}
          {winBtn('最大化', <BorderOutlined />)}
          {winBtn('关闭', <CloseOutlined />)}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 侧栏
// ─────────────────────────────────────────────────────────────
function Sidebar({
  projects, currentProjectId, onPickProject,
  projectsLoading, sessions, sid, setSid, newSession, delSession,
  datasets, datasetsLoading, onRescan, onOpenDatasets, onListProjectData,
  notifications, onClearNotifications, onJumpModule,
}) {
  const navigate = useNavigate()
  const [navKey, setNavKey] = useState('chat')
  const [projExpanded, setProjExpanded] = useState(false)
  const [panel, setPanel] = useState(null)   // 'bell' | 'search' | null
  const [q, setQ] = useState('')
  const [appMenu, setAppMenu] = useState(false)
  const [userMenu, setUserMenu] = useState(false)

  // 四个导航项各自指向 StatG 里真实存在的能力，不搞「三个都跳同一个地方」。
  // 原型的 定时任务/插件/探索 是 Nuphus 的概念，StatG 里没有对应物，
  // 所以按 StatG 自己的功能重挂：
  //   新聊天   → 新建会话
  //   定时任务 → 工作流模块（固化后一键重跑，是 StatG 最接近"定时"的东西）
  //   插件     → 知识库（导入的文献/方法就是可复用的"插件"）
  //   探索     → 数据管理（翻数据集）
  //
  // 图标一律照原型原样：新聊天 = 铅笔、定时任务 = 时钟、插件 = 三层叠、
  // 探索 = 齿轮。**插件原来被我换成了 AntD 的 AppstoreOutlined（九宫格），
  // 那不是原型的图标，已改回三层叠的 SVG 原文。**
  const NAV = [
    { key: 'chat',     icon: <EditOutlined />,        label: '新聊天',   to: null },
    { key: 'flow',     icon: <ClockCircleOutlined />, label: '定时任务', to: 'work' },
    {
      key: 'kb', label: '插件', to: '/resources',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 7L12 3 4 7l8 4 8-4z" />
          <path d="M4 12l8 4 8-4" />
          <path d="M4 17l8 4 8-4" />
        </svg>
      ),
    },
    { key: 'explore',  icon: <SettingOutlined />,     label: '探索',     to: '/data' },
  ]
  const onNav = (n) => {
    setNavKey(n.key)
    if (n.key === 'chat') newSession()
    else if (n.to === 'work') onJumpModule('work')
    else if (n.to) navigate(n.to)
  }

  const shownProjects = projExpanded ? projects : projects.slice(0, 5)
  const filteredSessions = useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return sessions
    return sessions.filter((s) =>
      s.title.toLowerCase().includes(k) ||
      (s.messages || []).some((m) => m.text.toLowerCase().includes(k)))
  }, [sessions, q])

  return (
    <div className="cd-sidebar">
      <div className="cd-sidebar-top">
        <Dropdown
          trigger={['click']}
          open={appMenu}
          onOpenChange={setAppMenu}
          menu={{ items: [
            { key: 'work',   icon: <ThunderboltOutlined />, label: '切到工作台模块' },
            { key: 'reload', icon: <ReloadOutlined />,      label: '重载项目列表' },
            { type: 'divider' },
            { key: 'home',   icon: <ArrowLeftOutlined />,   label: '返回 StatG 主界面' },
          ], onClick: ({ key }) => {
            setAppMenu(false)
            if (key === 'work') onJumpModule('work')
            if (key === 'home') navigate('/home')
            if (key === 'reload') onRescan()
          } }}
        >
          <div className="cd-app-name">
            StatG
            <DownOutlined className="cd-chev" />
          </div>
        </Dropdown>

        <div
          className={`cd-icon-btn${panel === 'bell' ? ' on' : ''}`}
          title={notifications.length ? `通知（${notifications.length}）` : '通知'}
          onClick={() => { setPanel(panel === 'bell' ? null : 'bell'); setQ('') }}
        >
          <BellOutlined />
          {notifications.length > 0 && <i className="cd-dot" />}
        </div>
        <div
          className={`cd-icon-btn${panel === 'search' ? ' on' : ''}`}
          title="搜索会话"
          onClick={() => { setPanel(panel === 'search' ? null : 'search'); setQ('') }}
        >
          <SearchOutlined />
        </div>
      </div>

      {/* 通知 / 搜索面板：占住侧栏顶部，不弹窗——弹窗会盖住正在看的东西 */}
      {panel === 'bell' && (
        <div className="cd-panel">
          <div className="cd-panel-hd">
            <span>通知</span>
            {notifications.length > 0 && (
              <a onClick={onClearNotifications}>全部已读</a>
            )}
          </div>
          {notifications.length === 0
            ? <div className="cd-panel-empty">还没有通知</div>
            : notifications.map((n) => (
              <div key={n.id} className={`cd-note ${n.kind}`}>
                {n.kind === 'err' ? <ExclamationCircleOutlined /> : <CheckCircleFilled />}
                <div><div className="cd-note-t">{n.text}</div>
                  <div className="cd-note-time">{relTime(n.at)}</div></div>
              </div>
            ))}
        </div>
      )}

      {panel === 'search' && (
        <div className="cd-panel">
          <input
            className="cd-search"
            autoFocus
            placeholder="搜索会话标题或内容"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {filteredSessions.length === 0
            ? <div className="cd-panel-empty">没有匹配的会话</div>
            : filteredSessions.map((s) => (
              <div key={s.id} className="cd-search-hint"
                   onClick={() => { setSid(s.id); setPanel(null) }}>
                <EditOutlined /> {s.title}
              </div>
            ))}
        </div>
      )}

      <div className="cd-nav-list">
        {NAV.map((n) => (
          <div
            key={n.key}
            className={`cd-nav-item${navKey === n.key ? ' on' : ''}`}
            onClick={() => onNav(n)}
          >
            {n.icon}
            {n.label}
          </div>
        ))}
      </div>

      <div className="cd-scroll">
        <div className="cd-section-title">项目</div>
        <div className="cd-project-list">
          {projectsLoading && <div className="cd-proj-loading"><Spin size="small" /></div>}
          {!projectsLoading && projects.length === 0 && (
            <div className="cd-proj-empty">
              <div>还没有项目</div>
              <a onClick={() => navigate('/projects')}>去项目管理页创建</a>
            </div>
          )}
          {shownProjects.map((p) => {
            const active = currentProjectId === p.id
            return (
              <div key={p.id}>
                <div
                  className={`cd-project-item${active ? ' active' : ''}`}
                  onClick={() => onPickProject(p)}
                >
                  <FolderOutlined />
                  <span className="cd-proj-name">{p.name}</span>
                </div>
                {/* 当前项目下面挂两个动作。原型这里是两个"读文件"的静态条目，
                    在 StatG 里换成真实等价物：重扫项目目录、列出它下面的数据集。 */}
                {active && (
                  <div className="cd-sub-list">
                    <div className="cd-sub-item" onClick={() => onRescan(p.id)}>
                      <ReloadOutlined style={{ marginRight: 7, verticalAlign: -2 }} />
                      重新扫描项目目录
                    </div>
                    <div className="cd-sub-item" onClick={() => onListProjectData(p.id, p.name)}>
                      <FileTextOutlined style={{ marginRight: 7, verticalAlign: -2 }} />
                      列出该项目内所有数据文件
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {projects.length > 5 && (
            <div className="cd-expand-link" onClick={() => setProjExpanded((v) => !v)}>
              {projExpanded ? '收起' : `展开显示（其余 ${projects.length - 5} 个）`}
            </div>
          )}
        </div>

        <div className="cd-section-title">最近</div>
        <div className="cd-recent-list">
          {datasetsLoading && <div className="cd-proj-loading"><Spin size="small" /></div>}
          {!datasetsLoading && datasets.length === 0 && (
            <div className="cd-panel-empty" style={{ padding: '4px 12px' }}>暂无数据集</div>
          )}
          {datasets.slice(0, 6).map((d) => (
            <div key={d.name} className="cd-sub-item" onClick={() => onOpenDatasets(d)}
                 title={`点击切换过去（${d.rows || '?'} 行 × ${d.cols || '?'} 列）`}>
              <FileTextOutlined style={{ marginRight: 7, verticalAlign: -2 }} />
              {d.name}
              <span className="cd-sub-meta">{d.rows ? `${d.rows} 行` : ''}</span>
            </div>
          ))}
          <div className="cd-sub-item cd-sub-head" style={{ marginTop: 6 }}>
            <span>会话</span>
            <span className="cd-sub-meta">{filteredSessions.length} 个</span>
          </div>
          {filteredSessions.slice(0, 4).map((s) => (
            <div key={s.id} className={`cd-sub-item${s.id === sid ? ' on' : ''}`}>
              <span onClick={() => { setSid(s.id); setPanel(null) }} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
                <EditOutlined style={{ marginRight: 7, verticalAlign: -2 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
              </span>
              <span className="cd-sub-meta" style={{ marginLeft: 0 }}>
                <a onClick={(e) => { e.stopPropagation(); delSession(s.id) }}
                   title="删除这个会话" style={{ marginRight: 8 }}>删</a>
                {relTime(s.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="cd-sidebar-bottom">
        <Dropdown
          trigger={['click']}
          open={userMenu}
          onOpenChange={setUserMenu}
          menu={{ items: [
            { key: 'settings', icon: <SettingOutlined />, label: '模型与 API 设置' },
            { key: 'help',     icon: <FileTextOutlined />, label: '使用说明' },
          ], onClick: ({ key }) => { setUserMenu(false); navigate(key === 'settings' ? '/settings' : '/help') } }}
        >
          <div className="cd-user-info">
            <SettingOutlined />
            <span>{loadAiConfig().model || '未配置模型'}</span>
          </div>
        </Dropdown>
        <div className="cd-download-btn" title="导出当前结果"
             onClick={() => navigate('/output')}>
          <DownloadOutlined />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Chat 主体
// ─────────────────────────────────────────────────────────────
export default function CodexChat({ onJumpModule }) {
  const {
    session, setSession, sessions, sid, setSid, newSession, delSession,
    agentMode, setAgentMode, model, setModel, dataset, setDataset,
    results, current, pushResult, busy, setBusy, project, setProject,
    setMode,
  } = useStudio()
  const navigate = useNavigate()

  const [draft, setDraft] = useState('')
  const [sideOpen, setSideOpen] = useState(true)
  const [projects, setProjects] = useState([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [datasets, setDatasets] = useState([])
  const [datasetsLoading, setDatasetsLoading] = useState(true)
  const [approval, setApproval] = useState('auto')      // auto | ask
  const [apprOpen, setApprOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [chipOpen, setChipOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [hist, setHist] = useState([])                  // 会话浏览历史，供后退/前进
  const [histIdx, setHistIdx] = useState(-1)
  const [pending, setPending] = useState(null)          // 待批准的回归

  const aiCfg = loadAiConfig()
  // 从 Work 模块带过来的问题。Work 只负责留话（它调不到这里的 runAgent），
  // 挂载后由这个 effect 真的跑一遍——否则用户切回来只看到一条没人答的问题。
  const { pendingPrompt, setPendingPrompt } = useStudio()
  useEffect(() => {
    if (!pendingPrompt) return
    const q = pendingPrompt
    setPendingPrompt(null)
    say('user', q)
    runAgent(q)
  }, [pendingPrompt])   // eslint-disable-line react-hooks/exhaustive-deps
  // 模型列表跟着配置走。这里读一次而不是每次渲染读 localStorage——
  // 选完模型要能立刻在弹层里看到"当前"挪过去，所以 pickModel 会写回并刷新。
  const [cfgTick, setCfgTick] = useState(0)
  const cfg = useMemo(() => loadAiConfig(), [cfgTick])
  const presetModels = useMemo(() => presetModelsOf(cfg), [cfg])
  const pickModel = (m) => {
    saveAiConfig({ model: m })
    setCfgTick((t) => t + 1)
    setModelOpen(false)
    message.success(`已切换到模型 ${m}`)
  }
  const endRef = useRef(null)
  const apprRef = useRef(null)
  const modelRef = useRef(null)
  const chipRef = useRef(null)
  const uploadRef = useRef(null)

  // ── 会话浏览历史：切会话时入栈，后退/前进只改 sid
  useEffect(() => {
    setHist((h) => {
      if (h[histIdx] === sid) return h
      const next = h.slice(0, histIdx + 1)
      next.push(sid)
      return next.slice(-50)
    })
    setHistIdx((i) => Math.min(i + 1, 49))
  }, [sid])   // eslint-disable-line react-hooks/exhaustive-deps

  const goHistory = (delta) => {
    const to = histIdx + delta
    if (to < 0 || to >= hist.length) return
    const target = hist[to]
    if (sessions.some((s) => s.id === target)) { setHistIdx(to); setSid(target) }
  }

  // ── 拉真实数据
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const r = await projectAPI.list()
      setProjects(r.data.projects || [])
    } catch { setProjects([]) }
    finally { setProjectsLoading(false) }
  }, [])

  const loadDatasets = useCallback(async () => {
    setDatasetsLoading(true)
    try {
      const r = await dataAPI.datasetsList()
      setDatasets(r.data.datasets || [])
    } catch { setDatasets([]) }
    finally { setDatasetsLoading(false) }
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])
  useEffect(() => { loadDatasets() }, [loadDatasets])

  // 侧栏当前项目与后端 current_id 对齐：进页面时后端可能已经选过项目
  useEffect(() => {
    (async () => {
      try {
        const r = await projectAPI.list()
        const list = r.data.projects || []
        setProjects(list)
        if (r.data.current_id) {
          const p = list.find((x) => x.id === r.data.current_id)
          if (p) setProject({ id: p.id, name: p.name })
        }
      } catch { /* 后端不在也要能打开页面 */ }
    })()
  }, [setProject])

  // Ctrl+Shift+S 折叠侧栏
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
        e.preventDefault(); setSideOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // 点空白关掉三个弹出层
  useEffect(() => {
    if (!apprOpen && !modelOpen && !chipOpen) return
    const onDown = (e) => {
      if (apprOpen && apprRef.current && !apprRef.current.contains(e.target)) setApprOpen(false)
      if (modelOpen && modelRef.current && !modelRef.current.contains(e.target)) setModelOpen(false)
      if (chipOpen && chipRef.current && !chipRef.current.contains(e.target)) setChipOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [apprOpen, modelOpen, chipOpen])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [session.length, busy, pending])

  const notify = (kind, text) =>
    setNotifications((prev) => [{ id: 'n' + Date.now() + Math.random(), kind, text, at: Date.now() }, ...prev].slice(0, 30))

  const say = (role, text, extra) =>
    setSession((prev) => [...prev, { id: 'm' + Date.now() + Math.random(), role, text, ...extra }])

  // ── 导入数据：附件按钮的真身
  const onUpload = async (file) => {
    if (!file) return
    const hide = message.loading(`正在导入 ${file.name}…`, 0)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/data/upload', { method: 'POST', body: fd })
      const d = await r.json()
      hide()
      if (d.error) { notify('err', `导入失败：${d.error}`); message.error(d.error); return }
      const info = await dataAPI.info()
      if (info.data && !info.data.error) {
        setDataset({
          name: info.data.name || file.name,
          rows: info.data.rows || 0,
          cols: (info.data.variables || info.data.columns || []).length || 0,
          source: '本机导入',
        })
      }
      await loadDatasets()
      notify('ok', `已导入 ${file.name}`)
      message.success(`已导入 ${file.name}`)
    } catch (e) {
      hide(); notify('err', '导入出错：' + e.message); message.error(e.message)
    }
  }

  // ── 重新扫描项目目录：Disk 上新增/删掉的文件要能进来，不然侧栏是死的
  const rescanProject = async (pid) => {
    const id = pid || project.id
    if (!id) { message.warning('先选一个项目'); return }
    try {
      const r = await projectAPI.rescan(id)
      if (r.data && r.data.error) { message.error(r.data.error); return }
      const d = r.data || {}
      await loadProjects()
      await loadDatasets()
      const added = (d.added || []).length
      const removed = (d.removed || []).length
      notify('ok', `已重扫：新增 ${added} 个、移除 ${removed} 个`)
      message.success(`重扫完成，新增 ${added} 个、移除 ${removed} 个`)
    } catch (e) { message.error(e.message) }
  }

  // ── 列出项目内所有数据文件：走 /api/projects/{pid}/datasets，不逐个读文件
  const listProjectData = async (pid, name) => {
    try {
      const r = await projectAPI.datasets(pid)
      const list = r.data?.datasets || r.data || []
      const lines = Array.isArray(list) && list.length
        ? list.map((d) => `· ${d.name}${d.rows ? `（${d.rows} 行 × ${d.cols} 列）` : ''}`).join('\n')
        : '这个项目下还没有数据文件'
      Modal.info({
        title: `${name} · 数据文件`,
        width: 460,
        content: <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.9,
                                maxHeight: 320, overflowY: 'auto', userSelect: 'text' }}>{lines}</div>,
        okText: '知道了',
      })
    } catch (e) { message.error(e.message) }
  }

  // ── 「最近」里点数据集：真的切后端数据集，不是只改侧栏显示。
  // 之前这里只 setDataset，表一个字节都没换——点了卡片、跑回归还是旧数据。
  const switchDataset = async (d) => {
    try {
      const r = await dataAPI.switch(d.name)
      if (r.data && r.data.error) { message.error(r.data.error); return }
      const info = await dataAPI.info()
      setDataset({
        name: d.name,
        rows: (info.data && info.data.rows) || d.rows || 0,
        cols: (info.data && (info.data.variables || info.data.columns || []).length) || d.cols || 0,
        source: d.source || '本机数据',
      })
      notify('ok', `已切换数据集 ${d.name}`)
    } catch (e) { message.error(e.message) }
  }

  // ── 项目切换：选完要把数据同步到 data_service，否则侧栏变了表还是旧的
  const pickProject = async (p) => {
    if (p.id === project.id) return
    try {
      const r = await projectAPI.select(p.id)
      if (r.data.error) { message.error(r.data.error); return }
      setProject({ id: p.id, name: p.name })
      const info = await dataAPI.info()
      if (info.data && !info.data.error) {
        setDataset({
          name: info.data.name || p.name,
          rows: info.data.rows || 0,
          cols: (info.data.variables || info.data.columns || []).length || 0,
          source: p.name,
        })
      }
      await loadDatasets()
      notify('ok', `已切换到项目 ${p.name}`)
    } catch (e) { message.error(e.message) }
  }

  // ── 回归：真正调后端，经 /api 代理
  const runRegression = async (m) => {
    const res = await regressionAPI.run('ols', {
      y_var: m.y, core_x: m.core, controls: m.controls,
      se_type: m.se_type || 'classical', cluster_vars: m.cluster || [],
    })
    const d = res.data
    if (d.error) { say('assistant', '回归报错了：' + d.error); notify('err', d.error); return null }
    // 后端会把它算不出来的变量单独列在 warnings 里。这个必须显式说，
    // 不能混在正文里——"控制了这个变量"和"它被剔掉了"对研究者是两件事。
    if (d.warnings && d.warnings.length) {
      d.warnings.forEach((w) => { say('assistant', '⚠️ ' + w); notify('err', w) })
    }
    const r = {
      id: 'res_' + Date.now(),
      kind: 'table',
      title: `基准回归 · ${d.dep_var} ~ ${(m.core || []).join(' + ')}`,
      producedBy: 'agent',
      evidenceId: newEvidenceId(),
      createdAt: Date.now(),
      meta: d,
      rows: (d.coefficients || []).map((c, i) => ({ ...c, p: String(c.p), key: 'k' + i })),
    }
    pushResult(r)
    return r
  }

  // ── 意图识别。配了模型就走真对话，没配就退回本地的三条意图——
  // 不假装有模型，也不让没配模型的用户点发送没反应。
  const KNOWN = ['lwage', 'exper', 'educ', 'black', 'south', 'married', 'wage', 'age', 'smsa', 'fatheduc', 'motheduc']

  const runAgent = async (text) => {
    setBusy(true)
    try {
      // 1) 解释当前结果
      if (/解释|显著|说明|怎么看|意味着/.test(text)) {
        if (!current) { say('assistant', '现在还没有结果可以解释。先让我跑一个回归，比如说「跑 lwage 对 exper educ 的回归」。'); return }
        const top = current.rows.find((x) => x.role === 'core') || current.rows[0]
        say('assistant',
          `这份结果的因变量是 ${current.meta.dep_var}，N = ${current.meta.nobs}，R² = ${current.meta.r_squared}，F = ${current.meta.f_stat}。\n\n` +
          `核心变量 ${top.variable} 的系数是 ${top.coef}（标准误 ${top.std_err}，t = ${top.t}，${top.stars || ''}）。\n` +
          `${Number(top.p) < 0.05 ? '在 5% 水平上显著' : '在 5% 水平上不显著'}。\n\n` +
          `证据编号 ${current.evidenceId}，由「${({ manual: '工作台手动跑', agent: 'Chat 里 agent 跑', pipeline: '固化的工作流跑' })[current.producedBy] || '未知来源'}」产生。`,
          { refResult: current.id })
        return
      }

      // 2) 固化为工作流
      if (/固化|工作流|保存.*流程|重复/.test(text)) {
        say('assistant', '可以把这次分析固化成工作流，之后一键重跑。要现在固化吗？',
          { offerPipeline: true })
        return
      }

      // 3) 回归意图
      const found = (text.match(/[a-zA-Z_][a-zA-Z0-9_]{1,20}/g) || []).filter((w) => KNOWN.includes(w))
      const y = found[0] || model.y
      const xs = found.slice(1)
      const nextModel = {
        ...model, y,
        core: xs.length ? xs.slice(0, 2) : model.core,
        controls: xs.length > 2 ? xs.slice(2) : model.controls,
      }
      if (xs.length) setModel(nextModel)

      // 需批准：先把参数摆出来，等用户确认再跑
      if (approval === 'ask' && !pending) {
        setPending(nextModel)
        say('assistant',
          `我准备跑这个回归，参数如下：\n\n` +
          `  因变量  ${nextModel.y}\n` +
          `  核心解释变量  ${(nextModel.core || []).join(', ') || '（无）'}\n` +
          `  控制变量  ${(nextModel.controls || []).join(', ') || '（无）'}\n` +
          `  标准误  ${nextModel.se_type === 'classical' ? '普通标准误' : nextModel.se_type}\n\n` +
          `确认无误就点下面的「批准执行」。`)
        return
      }

      await new Promise((r) => setTimeout(r, 300))
      const r = await runRegression(pending || nextModel)
      setPending(null)
      if (r) {
        say('assistant', `跑完了。N = ${r.meta.nobs}，R² = ${r.meta.r_squared}，结果如下。`, { refResult: r.id })
        notify('ok', `回归完成：${r.title}`)
      }
    } catch (e) {
      say('assistant', '出错了：' + e.message)
      notify('err', e.message)
    } finally { setBusy(false) }
  }

  // 配了模型时可走真 LLM；这里保留入口，未配置时给一句人话
  const submit = async () => {
    const t = draft.trim()
    if (!t || busy) return
    say('user', t)
    setDraft('')
    if (!aiCfg.api_url || !aiCfg.api_key) {
      say('assistant', '（未配置大模型，当前用内置意图处理。要去接真对话，请到「设置」里填 API 地址和密钥。）')
      await runAgent(t)
      return
    }
    try {
      setBusy(true)
      const msgs = [...session, { role: 'user', text: t }].map((m) => ({ role: m.role, content: m.text }))
      const r = await aiAPI.chat(msgs, aiCfg, 'studio')
      if (r.data.error) { say('assistant', '模型返回错误：' + r.data.error); return }
      say('assistant', r.data.content)
    } catch (e) {
      say('assistant', '调用模型失败：' + e.message)
    } finally { setBusy(false) }
  }

  const onMenu = (key) => {
    if (key === 'new') newSession()
    if (key === 'imp') navigate('/projects')
    if (key === 'data') uploadRef.current?.click()
    if (key === 'back') navigate('/home')
    if (key === 'clear') setSession([])
    if (key === 'rename') {
      const s = sessions.find((x) => x.id === sid)
      const name = window.prompt('重命名会话', s?.title || '')
      if (name) setSessions((prev) => prev.map((x) => x.id === sid ? { ...x, title: name } : x))
    }
    if (key === 'side') setSideOpen((v) => !v)
    if (key === 'work') onJumpModule('work')
    if (key === 'help') navigate('/help')
    if (key === 'about') message.info('StatG · 实证数据分析助手')
  }

  const isEmpty = session.length === 0

  return (
    <div className="cd-root">
      <TitleBar
        onBack={() => goHistory(-1)}
        onFwd={() => goHistory(1)}
        canBack={histIdx > 0}
        canFwd={histIdx < hist.length - 1}
        onToggleSide={() => setSideOpen((v) => !v)}
        onMenu={onMenu}
      />

      <div className="cd-container">
        {sideOpen && (
          <Sidebar
            projects={projects}
            projectsLoading={projectsLoading}
            currentProjectId={project.id}
            onPickProject={pickProject}
            sessions={sessions}
            sid={sid}
            setSid={setSid}
            newSession={newSession}
            delSession={delSession}
            datasets={datasets}
            datasetsLoading={datasetsLoading}
            onRescan={rescanProject}
            onOpenDatasets={switchDataset}
            onListProjectData={listProjectData}
            notifications={notifications}
            onClearNotifications={() => setNotifications([])}
            onJumpModule={onJumpModule}
          />
        )}

        <div className="cd-main">
          {!sideOpen && (
            <div className="cd-sidebar-toggle" title="显示侧边栏 Ctrl+Shift+S"
                 onClick={() => setSideOpen(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="5" width="22" height="14" rx="6" />
                <line x1="15" y1="5" x2="15" y2="19" />
              </svg>
            </div>
          )}

          <div className={isEmpty ? 'cd-welcome-area' : 'cd-chat-scroll'}>
            {isEmpty ? (
              <>
                {/* 欢迎区的线稿图标：SVG 逐值抄自用户确认的原型，没有改形状 */}
                <svg className="cd-welcome-icon" viewBox="0 0 100 100" fill="none"
                     stroke="#b0b0b0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="50" cy="56" rx="34" ry="36" />
                  <path d="M 50 20 Q 47 14 51 12" />
                  <circle cx="38" cy="48" r="11" />
                  <circle cx="40" cy="49" r="4.5" fill="#b0b0b0" stroke="none" />
                  <circle cx="62" cy="48" r="11" />
                  <circle cx="64" cy="49" r="4.5" fill="#b0b0b0" stroke="none" />
                  <path d="M 42 66 Q 50 72 58 66" />
                  <circle cx="24" cy="62" r="3.5" fill="#b0b0b0" stroke="none" opacity="0.5" />
                  <circle cx="76" cy="62" r="3.5" fill="#b0b0b0" stroke="none" opacity="0.5" />
                  <path d="M 40 92 L 40 96 M 36 96 L 44 96" />
                  <path d="M 60 92 L 60 96 M 56 96 L 64 96" />
                </svg>
                <div className="cd-welcome-text">我们要构建什么？</div>
              </>
            ) : (
              <div className="cd-thread">
                {session.map((m) => {
                  const r = m.refResult ? results.find((x) => x.id === m.refResult) : null
                  return (
                    <div key={m.id} className={`cd-msg ${m.role}`}>
                      <div className="cd-bubble">{m.text}</div>
                      {r && (
                        <div className="cd-result-card">
                          <div className="cd-result-hd">
                            <span className="cd-result-title">{r.title}</span>
                            <span className="cd-result-links">
                              <a onClick={() => onJumpModule('work')}>在工作台打开</a>
                            </span>
                          </div>
                          <Provenance result={r} dark />
                          <div className="cd-result-body"><ResultTable result={r} compact /></div>
                        </div>
                      )}
                      {m.offerPipeline && (
                        <div className="cd-offer">
                          <Button size="small" type="primary"
                                  onClick={() => { setAgentMode('workflow'); onJumpModule('work') }}>
                            去工作流模块固化
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {busy && (
                  <div className="cd-msg assistant">
                    <div className="cd-bubble cd-busy"><LoadingOutlined /> agent 正在推理 / 调工具…</div>
                  </div>
                )}
                {pending && (
                  <div className="cd-approve">
                    <ExclamationCircleOutlined /> 等待你批准这次回归
                    <Button size="small" type="primary" loading={busy}
                            onClick={async () => { const m = pending; await runAgent('批准执行') }}>
                      批准执行
                    </Button>
                    <Button size="small" onClick={() => { setPending(null); say('assistant', '好，那就先不跑。') }}>
                      取消
                    </Button>
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          {/* ── 输入区 ── */}
          <div className="cd-input-area">
            <div className="cd-chip-wrap" ref={chipRef}>
              <div className="cd-project-chip" onClick={() => setChipOpen((v) => !v)}>
                <FolderOutlined />
                <span>{project?.name || '选择项目'}</span>
              </div>
              {chipOpen && (
                <div className="cd-pop cd-pop-chip">
                  <div className="cd-pop-hd">切换项目</div>
                  {projects.length === 0 && <div className="cd-pop-empty">还没有项目</div>}
                  {projects.map((p) => (
                    <div key={p.id} className={`cd-pop-row${project?.id === p.id ? ' on' : ''}`}
                         onClick={() => { pickProject(p); setChipOpen(false) }}>
                      <FolderOutlined /> {p.name}
                      {project?.id === p.id && <Tag color="blue" style={{ marginLeft: 'auto', marginInlineEnd: 0 }}>当前</Tag>}
                    </div>
                  ))}
                  <div className="cd-pop-foot">
                    <a onClick={() => { setChipOpen(false); navigate('/projects') }}>管理项目…</a>
                  </div>
                </div>
              )}
            </div>

            <div className="cd-input-box">
              <textarea
                className="cd-input-field"
                placeholder="随心输入"
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  const el = e.target
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
                }}
              />

              <div className="cd-input-toolbar">
                <div className="cd-toolbar-left">
                  <input ref={uploadRef} type="file" accept=".dta,.csv,.xlsx,.xls,.sav" hidden
                         onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = '' }} />
                  <button className="cd-tool-btn" title="导入数据文件"
                          onClick={() => uploadRef.current?.click()}>
                    <PlusOutlined />
                  </button>

                  <div className="cd-pop-wrap" ref={apprRef}>
                    <button className="cd-tool-btn" title="执行前是否需要我批准"
                            onClick={() => setApprOpen((v) => !v)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
                        <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
                        <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
                        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                      </svg>
                      {approval === 'ask' ? '需批准' : '自动执行'}
                    </button>
                    {apprOpen && (
                      <div className="cd-pop cd-pop-up">
                        <div className="cd-pop-hd">执行确认</div>
                        {[
                          { v: 'auto', t: '自动执行', d: '识别到回归意图就直接跑，不等我确认' },
                          { v: 'ask', t: '需批准', d: '先把因变量、核心变量、控制变量摆出来，我确认再跑' },
                        ].map((o) => (
                          <div key={o.v} className={`cd-pop-row${approval === o.v ? ' on' : ''}`}
                               onClick={() => { setApproval(o.v); setApprOpen(false) }}>
                            <div><div className="cd-pop-t">{o.t}</div><div className="cd-pop-d">{o.d}</div></div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="cd-toolbar-right">
                  <div className="cd-pop-wrap" ref={modelRef}>
                    <div className="cd-model-select" onClick={() => setModelOpen((v) => !v)}>
                      {aiCfg.model || '未配置模型'}
                      <DownOutlined style={{ fontSize: 10 }} />
                    </div>
                    {modelOpen && (
                      <div className="cd-pop cd-pop-up cd-pop-model">
                        <div className="cd-pop-hd">
                          {aiCfg.preset ? `${aiCfg.preset} 的模型` : '模型'}
                        </div>
                        {/* 只列当前预设的模型。把所有预设的模型混在一起列会误导——
                            用户在设置页选的是 DeepSeek，侧栏却摆着一排 OpenAI 的型号，
                            点过去就是拿 DeepSeek 的地址调 gpt-4o，必然报错。 */}
                        {presetModels.map((m) => (
                          <div key={m}
                               className={`cd-pop-row${aiCfg.model === m ? ' on' : ''}`}
                               onClick={() => pickModel(m)}>
                            <RobotOutlined style={{ fontSize: 13 }} />
                            <span style={{ flex: 1 }}>{m}</span>
                            {aiCfg.model === m && <Tag color="blue" style={{ marginInlineEnd: 0 }}>当前</Tag>}
                          </div>
                        ))}
                        {presetModels.length === 0 && (
                          <div className="cd-pop-empty">
                            这个预设有自定义模型名，去设置页填
                          </div>
                        )}
                        {!aiCfg.api_key && (
                          <div className="cd-pop-warn">
                            <ExclamationCircleOutlined /> 还没配 API 密钥，对话会退回内置意图处理
                          </div>
                        )}
                        <div className="cd-pop-foot">
                          <a onClick={() => { setModelOpen(false); navigate('/settings') }}>去设置…</a>
                        </div>
                      </div>
                    )}
                  </div>

                  <button className={`cd-send-btn${draft.trim() ? ' active' : ''}`}
                          disabled={busy || !draft.trim()} title="发送"
                          onClick={submit}>
                    <SendOutlined style={{ transform: 'rotate(0deg)' }} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
