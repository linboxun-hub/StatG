import React, { useState, useEffect } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout as AntLayout, Menu, Select, Tag } from 'antd'
import GlobalAIChat from './GlobalAIChat'
import { projectAPI } from '../api'
import {
  HomeOutlined,
  DatabaseOutlined,
  ScissorOutlined,
  BarChartOutlined,
  ThunderboltOutlined,
  SafetyOutlined,
  NodeExpandOutlined,
  PartitionOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  ProjectOutlined,
  LineChartOutlined,
  FolderOpenOutlined,
  AppstoreOutlined,
} from '@ant-design/icons'

const { Sider, Content, Header } = AntLayout

// 整套顺序按实证论文的推进来排：先备数据、再回归前统计描述，
// 然后是基准回归 → 稳健性 → 机制 → 异质性，最后才谈产出。
// 「分析流程」里 5 步是核心。基准/稳健/机制三个入口其实指向同一个回归页，
// 靠 to 上的 ?stage= 让页面只显示对应阶段的方法（见 Regression.jsx）；
// 异质性那步跳到独立页 /heterogeneity，其余图（描述/平行趋势/DML）按阶段内嵌。
// to   = 点击导航去的地址，同时用作菜单唯一 key
// keys = 会把这一项点亮的所有地址（含同义路径），用于高亮当前所在步骤
const MENU_GROUPS = [
  {
    label: '项目',
    items: [
      { to: '/home', keys: ['/home'], icon: <HomeOutlined />, label: '工作台' },
      { to: '/projects', keys: ['/projects'], icon: <ProjectOutlined />, label: '项目管理' },
    ],
  },
  {
    label: '数据准备',
    items: [
      { to: '/data', keys: ['/data'], icon: <DatabaseOutlined />, label: '数据管理' },
      { to: '/editor', keys: ['/editor'], icon: <ScissorOutlined />, label: '数据清洗' },
    ],
  },
  {
    label: '分析流程',
    items: [
      { label: '① 统计分析', icon: <BarChartOutlined />, sub: [
          { to: '/analysis', label: '统计表' },
          { to: '/chart/descriptive', label: '描述图形' },
      ]},
      { label: '② 基准回归', icon: <ThunderboltOutlined />, sub: [
          { to: '/regression?stage=baseline', label: '基准回归' },
          { to: '/chart/trend', label: '平行趋势' },
      ]},
      { label: '③ 稳健性检验', icon: <SafetyOutlined />, sub: [
          { to: '/regression?stage=robust', label: '稳健回归' },
          { to: '/chart/dml', label: 'DML 稳健性' },
      ]},
      { label: '④ 机制检验', icon: <NodeExpandOutlined />, sub: [
          { to: '/mechanism?mode=mediation', label: '中介效应' },
          { to: '/mechanism?mode=moderation', label: '调节效应' },
          { to: '/regression?stage=mechanism', label: '门槛回归' },
      ]},
      { label: '⑤ 异质性分析', icon: <PartitionOutlined />, sub: [
          { to: '/chart/heterogeneity?view=chart', label: '系数图' },
          { to: '/chart/heterogeneity?view=table', label: '分组回归表' },
      ]},
    ],
  },
  {
    label: '产出',
    items: [
      { to: '/output', keys: ['/output'], icon: <FileTextOutlined />, label: '结果输出' },
    ],
  },
  {
    label: '其他',
    items: [
      { to: '/resources', keys: ['/resources'], icon: <AppstoreOutlined />, label: '资源管理' },
      { to: '/help', keys: ['/help'], icon: <QuestionCircleOutlined />, label: '帮助文档' },
      { to: '/settings', keys: ['/settings'], icon: <SettingOutlined />, label: 'AI 设置' },
    ],
  },
]

// 带 sub 的项渲染成 antd 子菜单；叶子项直接给 key。
const buildMenuChildren = (items) => items.map(it => it.sub
  ? { key: it.label, label: it.label, icon: it.icon, children: it.sub.map(s => ({ key: s.to, label: s.label })) }
  : { key: it.to, label: it.label, icon: it.icon })
const menuItems = MENU_GROUPS.map(g => ({
  type: 'group',
  label: (
    <span style={{ fontSize: 10, letterSpacing: 1, color: '#475569', fontWeight: 600 }}>
      {g.label}
    </span>
  ),
  children: buildMenuChildren(g.items),
}))
// 叶子扁平表：子菜单的每个子项都是一条可匹配的叶子，并记住父级 label 供 Header 展示
const flatItems = MENU_GROUPS.flatMap(g => g.items.flatMap(it => it.sub
  ? it.sub.map(s => ({ to: s.to, keys: [s.to], label: s.label, parent: it.label }))
  : [{ to: it.to, keys: it.keys, label: it.label }]))

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  // 活动项要带上 query：②/③ 的「表」与「图」是不同路径；子菜单子项 to 各不相同。
  const here = location.pathname + location.search
  const active =
    flatItems.find(i => i.keys.includes(here)) ||
    flatItems.find(i => i.keys.some(k => here.startsWith(k) || k.startsWith(here)))
  const currentKey = active ? active.to : '/home'
  const currentLabel = active ? (active.parent ? `${active.parent} · ${active.label}` : active.label) : '工作台'
  // 子菜单自动展开当前所在的那个，直达/刷新时不塌着
  const activeParent = (active && active.parent) || null
  const [openKeys, setOpenKeys] = useState(activeParent ? [activeParent] : [])
  useEffect(() => {
    if (activeParent) setOpenKeys(k => (k.includes(activeParent) ? k : [...k, activeParent]))
  }, [activeParent])
  const [projects, setProjects] = useState([])
  const [currentProjectId, setCurrentProjectId] = useState(null)

  useEffect(() => {
    projectAPI.list().then(r => {
      setProjects(r.data.projects || [])
      setCurrentProjectId(r.data.current_id)
    }).catch(() => {})
  }, [location.pathname])

  const handleProjectSwitch = async (pid) => {
    try {
      await projectAPI.select(pid)
      setCurrentProjectId(pid)
    } catch (e) {}
  }

  const currentProject = projects.find(p => p.id === currentProjectId)

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider width={240} style={{ background: '#0f172a', overflow: 'auto' }}>
        {/* Logo */}
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: '1px solid #1e293b' }}>
          <div style={{
            width: 30, height: 30, borderRadius: 7,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 13,
          }}>
            <LineChartOutlined />
          </div>
          <span style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}>Stata 助手</span>
        </div>

        {/* 项目选择器 */}
        <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <FolderOpenOutlined /> 当前项目
          </div>
          <Select
            value={currentProjectId || undefined}
            onChange={handleProjectSwitch}
            placeholder="选择或创建项目"
            style={{ width: '100%' }}
            size="small"
            notFoundContent="暂无项目"
            options={projects.map(p => ({ label: p.name, value: p.id }))}
          />
          <div style={{ fontSize: 10, color: '#475569', marginTop: 5 }}>
            项目的新建与管理在「项目 · 项目管理」
          </div>
        </div>

        {/* 导航菜单 */}
        <Menu
          mode="inline"
          selectedKeys={[currentKey]}
          openKeys={openKeys}
          onOpenChange={setOpenKeys}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ background: 'transparent', border: 'none', color: '#94a3b8' }}
          theme="dark"
        />
      </Sider>
      <AntLayout>
        <Header style={{
          background: '#fff', padding: '0 32px', height: 64,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#1e293b' }}>
              {currentLabel}
            </h1>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              {currentProject ? currentProject.name : '未选择项目'}
            </div>
          </div>
        </Header>
        <Content style={{ background: '#f8fafc', overflow: 'auto' }}>
          <Outlet />
        </Content>
      </AntLayout>
      <GlobalAIChat />
    </AntLayout>
  )
}
