import React, { useState, useEffect, useCallback } from 'react'
import { Card, Tabs, Input, Button, Tag, Space, message, Modal, Empty,
         Typography, Tooltip, Badge, Spin, Alert, Statistic, Row, Col,
         Upload, Form, Select, Table, Descriptions, Popconfirm, Breadcrumb } from 'antd'
import {
  SearchOutlined, ReloadOutlined, PlusOutlined, CloudDownloadOutlined,
  UploadOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
  BookOutlined, DatabaseOutlined, EditOutlined, DeleteOutlined,
  FileWordOutlined, LinkOutlined, FolderOutlined, ArrowLeftOutlined,
  ThunderboltOutlined, WarningOutlined,
  FolderAddOutlined,
} from '@ant-design/icons'
import { kbAPI, dataAPI, browseAPI } from '../api'

const { Text, Paragraph } = Typography

const readAiConfig = () => {
  try { return JSON.parse(localStorage.getItem('stata_assistant_ai_config') || '{}') }
  catch { return {} }
}

const TYPE_COLOR = { paper: 'blue', method: 'green', concept: 'orange' }
const TYPE_TAG = { paper: '文献笔记', method: '方法卡片', concept: '概念' }

// ─────────────────────────── 知识库：库卡片网格 ───────────────────────────

function KbGrid({ onOpen }) {
  const [kbs, setKbs] = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const [searching, setSearching] = useState(false)
  const [seeding, setSeeding] = useState(false)

  // 内置知识刚从代码搬进库里，第一次进页面自动补一次
  useEffect(() => {
    kbAPI.seedBuiltins().then(r => {
      const n = r.data.created?.length || 0
      if (n) { message.success(`已重建内置方法知识：${n} 篇`); load() }
    }).catch(() => {})
  }, [])

  const doSeed = async () => {
    setSeeding(true)
    try {
      const r = await kbAPI.seedBuiltins()
      if (r.data.error) { message.error(r.data.error); return }
      if (r.data.created?.length) {
        message.success(`补齐 ${r.data.created.length} 篇：${r.data.created.slice(0, 3).join('、')}${r.data.created.length > 3 ? ' 等' : ''}`)
      } else {
        message.info('内置知识已是最新，没有需要补的')
      }
      load()
    } catch (e) { message.error('重建失败') }
    setSeeding(false)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await kbAPI.kbs()
      setKbs(r.data.kbs || [])
    } catch { message.error('加载知识库失败') }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const createKb = async (name, about) => {
    const r = await kbAPI.createKb(name, about)
    if (r.data.ok) {
      message.success(`已创建「${r.data.name}」，现在可以往里导东西了`)
      setLastKb(r.data.name)
      load()
      return r.data.name
    }
    message.error(r.data.error)
    return null
  }

  const renameKb = async (old, name, about) => {
    const r = await kbAPI.updateKb(old, { name, about })
    if (r.data.ok) { message.success('已保存'); load() }
    else message.error(r.data.error)
  }

  const removeKb = async (name) => {
    const r = await kbAPI.removeKb(name)
    if (r.data.ok) { message.success(`已删除「${name}」，连同其中 ${r.data.removed_docs} 条笔记`); load() }
    else message.error(r.data.error)
  }

  return (
    <div style={{ padding: 24 }}>
      <Card size="small" style={{ marginBottom: 16 }}
        title={<Space>
          <FolderOutlined /> 知识库（{kbs.length}）
          <Text type="secondary" style={{ fontSize: 12 }}>
            每个库是一个文件夹，里面按「文献笔记 / 方法卡片 / 概念」分目录存放
          </Text>
        </Space>}
        extra={<Space wrap>
          <Input allowClear placeholder="跨库搜索标题 / 标签 / 正文" prefix={<SearchOutlined />}
                 style={{ width: 260 }} value={q}
                 onChange={e => { setQ(e.target.value); if (!e.target.value) setHits(null) }}
                 onPressEnter={async () => {
                   if (!q.trim()) return
                   setSearching(true)
                   try {
                     const r = await kbAPI.search(q.trim(), 12)
                     setHits(r.data.hits || [])
                   } catch { message.error('检索失败') }
                   setSearching(false)
                 }} />
          <Button type="primary" icon={<FolderAddOutlined />} onClick={() => setEditing({})}>
            新建知识库
          </Button>
          <Tooltip title="把内置的方法知识（原先是写死在代码里的提示词）写进「Stata命令速查」库。只补缺失的，不会覆盖你手改过的笔记。">
            <Button icon={<ThunderboltOutlined />} loading={seeding} onClick={doSeed}>
              重建内置知识
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={load} />
        </Space>}>
        {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
         : kbs.length === 0
         ? <Empty description="还没有知识库，先建一个" />
         : <Row gutter={[16, 16]}>
            {kbs.map(k => (
              <Col key={k.name} xs={24} md={12} xl={8}>
                <Card size="small" style={{ height: '100%' }}
                  hoverable
                  title={<Space wrap>
                    <FolderOutlined style={{ color: '#6366f1' }} />
                    <a onClick={() => { setLastKb(k.name); onOpen(k.name) }}>{k.name}</a>
                    {k.is_default && <Tag color="default">默认</Tag>}
                    {k.unverified > 0 && (
                      <Tooltip title={`${k.unverified} 条笔记是 AI 提炼、尚未人工核对`}>
                        <Tag color="orange" style={{ fontSize: 11 }}>待核对 {k.unverified}</Tag>
                      </Tooltip>)}
                  </Space>}
                  actions={[
                    <Button size="small" type="link" icon={<PlusOutlined />}
                            onClick={() => { setLastKb(k.name); onOpen(k.name, '', { import: true }) }}>
                      导入
                    </Button>,
                    <Button size="small" type="link" icon={<EditOutlined />}
                            onClick={() => setEditing(k)}>编辑</Button>,
                    <Popconfirm title={`删除「${k.name}」及其中全部 ${k.docs} 条笔记？不可恢复`}
                                onConfirm={() => removeKb(k.name)}>
                      <Button size="small" type="link" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>,
                  ]}
                >
                  {k.about && (
                    <Paragraph style={{ fontSize: 12, color: '#475569', minHeight: 40 }}
                               ellipsis={{ rows: 2, expandable: false }}>
                      {k.about}
                    </Paragraph>
                  )}
                  <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                    <Statistic title="文档" value={k.docs} valueStyle={{ fontSize: 20 }} />
                    <Statistic title="字符(千)" value={Math.round(k.chars / 100) / 10}
                               valueStyle={{ fontSize: 20 }} />
                    <Statistic title="被引用" value={k.citations}
                               valueStyle={{ fontSize: 20,
                                             color: k.citations ? '#52c41a' : undefined }} />
                  </div>
                  <Space wrap size={4}>
                    {Object.entries(k.by_type || {}).map(([t, n]) => (
                      <Tag key={t} color={TYPE_COLOR[t]} style={{ fontSize: 11 }}>
                        {TYPE_TAG[t]} {n}
                      </Tag>
                    ))}
                    {k.n_methods > 0 && (
                      <Tooltip title={`关联到 ${k.n_methods} 个回归方法，说明这个库跟你实际在跑的分析有关`}>
                        <Tag color="cyan" style={{ fontSize: 11 }}>关联方法 {k.n_methods}</Tag>
                      </Tooltip>
                    )}
                    {k.citations === 0 && k.docs > 0 && (
                      <Tooltip title="还没被拼进过任何一次 AI 回答，说明它一直在沉没">
                        <Tag style={{ fontSize: 11 }}>未被引用</Tag>
                      </Tooltip>
                    )}
                  </Space>
                  {k.updated && (
                    <div style={{ marginTop: 8, fontSize: 11, color: '#94a3b8' }}>
                      最近更新 {k.updated}
                    </div>
                  )}
                </Card>
              </Col>
            ))}
          </Row>
        }
        {hits && (
          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8 }}>
              <Text strong>跨库检索「{q}」：{hits.length} 条</Text>
              <Button size="small" type="link" onClick={() => { setHits(null); setQ('') }}>
                清空
              </Button>
            </div>
            <Table rowKey="id" size="small"
                   loading={searching}
                   dataSource={hits}
                   pagination={false}
                   columns={[
                     { title: '知识库', dataIndex: 'kb', width: 150,
                       render: (v, r) => <Tag>{v}</Tag> },
                     { title: '标题', dataIndex: 'title', render: (v, r) => (
                       <Space direction="vertical" size={0}>
                         <a onClick={() => onOpen(r.kb)}>{v}</a>
                         <Text type="secondary" style={{ fontSize: 11 }}>
                           {r.source_ref || '来源未标注'} · {r.chars} 字 · 得分 {r.score}
                         </Text>
                       </Space>) },
                     { title: '类型', dataIndex: 'type', width: 96,
                       render: v => <Tag color={TYPE_COLOR[v]}>{TYPE_TAG[v]}</Tag> },
                   ]} />
          </div>
        )}
      </Card>

      <KbEditModal kb={editing} onClose={() => setEditing(null)}
                   onCreate={createKb} onRename={renameKb} />
    </div>
  )
}

function KbEditModal({ kb, onClose, onCreate, onRename }) {
  const [form] = Form.useForm()
  const isNew = kb && !kb.name
  useEffect(() => {
    if (kb) form.setFieldsValue({ name: kb.name || '', about: kb.about || '' })
  }, [kb])
  if (!kb) return null
  const submit = async (v) => {
    if (isNew) { await onCreate(v.name, v.about); onClose() }
    else { await onRename(kb.name, v.name, v.about); onClose() }
  }
  return (
    <Modal open title={isNew ? '新建知识库' : `编辑「${kb.name}」`}
           width={520} onCancel={onClose} onOk={() => form.submit()}
           okText={isNew ? '创建' : '保存'}>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="知识库名称"
                   rules={[{ required: true, message: '给这个库起个名字' },
                           { max: 40, message: '名字太长' }]}
                   extra={'会直接作为文件夹名，不能含斜杠、冒号、星号、问号、引号、尖括号、竖线'}>
          <Input placeholder="例：DiD方法论文献 / 特高压项目背景 / 连享会命令速查" />
        </Form.Item>
        <Form.Item name="about" label="这个库是干什么的（可留空）"
                   extra="写清楚用途，以后检索命中这个库时你会知道该不该信">
          <Input.TextArea rows={3}
                        placeholder={"例：收集交错采纳 DID 的方法论文献，" + "不收纳具体应用研究"} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─────────────────────────── 知识库：库内文档 ───────────────────────────

function KnowledgeTab({ kb, openImport, onBack, onKbChanged }) {
  const [stats, setStats] = useState(null)
  const [docs, setDocs] = useState([])
  const [kbs, setKbs] = useState([])
  const [loading, setLoading] = useState(false)
  const [kw, setKw] = useState('')
  const [type, setType] = useState('')
  const [onlyUnverified, setOnlyUnverified] = useState(false)
  const [detail, setDetail] = useState(null)
  const [editBody, setEditBody] = useState('')
  const [importOpen, setImportOpen] = useState(!!openImport)
  const [draft, setDraft] = useState(null)
  const [drafting, setDrafting] = useState(false)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, d, k] = await Promise.all([
        kbAPI.stats(kb), kbAPI.list({ keyword: kw, type, verified: onlyUnverified ? 'false' : '', kb }),
        kbAPI.kbs(),
      ])
      setStats(s.data)
      setDocs(d.data.docs || [])
      setKbs(k.data.kbs || [])
    } catch { message.error('加载失败') }
    setLoading(false)
  }, [kb, kw, type, onlyUnverified])

  useEffect(() => { load() }, [load])

  const openDoc = async (id) => {
    const r = await kbAPI.get(id)
    if (r.data.error) { message.error(r.data.error); return }
    setDetail(r.data)
    setEditBody(r.data.body)
  }

  const saveDoc = async () => {
    const r = await kbAPI.update(detail.meta.id, { body: editBody })
    if (r.data.ok) { message.success('已保存'); setDetail(null); load() }
    else message.error(r.data.error || '保存失败')
  }

  const verify = async (id, v) => {
    await kbAPI.verify(id, v)
    message.success(v ? '已标记为人工核对通过' : '已取消核对标记')
    load()
  }

  const doImport = async (values) => {
    const cfg = readAiConfig()
    const targetKb = values.kb
    if (!targetKb) { message.warning('必须选一个知识库'); return }
    setDrafting(true)
    setDraft(null)
    try {
      const files = (values.file || []).map(f => f.originFileObj || f).filter(Boolean)
      if (files.length > 1) {
        const r = await kbAPI.batch(files, cfg, targetKb)
        if (r.data.drafts?.length) {
          setQueue(r.data.drafts)
          const d = await loadDraft(r.data.drafts[0].draft_id)
          setDraft(d)
          message.success(r.data.drafts.length + ' 篇读取完成，逐篇确认沉淀去向'
            + (r.data.failed?.length ? '，' + r.data.failed.length + ' 篇失败' : ''))
        } else {
          message.error('没有读取成功的文件'
            + (r.data.failed?.[0]?.error ? '：' + r.data.failed[0].error : ''))
        }
      } else if (files.length === 1) {
        const r = await kbAPI.ingestFile(files[0], cfg, targetKb)
        if (r.data.error) { message.error(r.data.error); setDrafting(false); return }
        setDraft(r.data)
        message.success('读取完成，请确认沉淀去向')
      } else if (values.source_type === 'URL') {
        const r = await kbAPI.ingest({ url: values.url, kb: targetKb, api_config: cfg })
        if (r.data.error) { message.error(r.data.error); setDrafting(false); return }
        setDraft(r.data)
        message.success('读取完成，请确认沉淀去向')
      } else if (values.source_type === '粘贴文本') {
        const r = await kbAPI.ingest({ text: values.text, kb: targetKb, api_config: cfg })
        if (r.data.error) { message.error(r.data.error); setDrafting(false); return }
        setDraft(r.data)
        message.success('读取完成，请确认沉淀去向')
      } else {
        message.warning('请选择文件、填地址或粘正文')
      }
    } catch (e) {
      message.error(e.response?.data?.error || e.message || '读取失败')
    }
    setDrafting(false)
  }

  const [queue, setQueue] = useState([])
  const loadDraft = async (id) => {
    const r = await kbAPI.draft(id)
    return r.data.error ? null : r.data
  }

  const commitDraft = async (selected) => {
    if (!draft) return
    const targetKb = form.getFieldValue('kb') || draft.kb
    const chosen = (selected || (draft.items || []).filter(i => i.selected))
      .map(i => ({ type: i.type, title: i.edited_title || draft.title,
                   body: i.edited_body ?? i.body, kb: targetKb }))
    if (!chosen.length) { message.warning('一个都没选，这篇不入库'); return }
    const r = await kbAPI.commit(draft.draft_id, chosen, null, targetKb)
    if (!r.data.ok) { message.error(r.data.error || '沉淀失败'); return }
    message.success('已沉淀 ' + r.data.count + ' 条到「' + targetKb + '」')
    const rest = queue.filter(q => q.draft_id !== draft.draft_id)
    setQueue(rest)
    if (rest.length) {
      setDraft(await loadDraft(rest[0].draft_id))
      message.info('还剩 ' + rest.length + ' 篇待确认')
    } else {
      setDraft(null); setImportOpen(false)
    }
    load()
    onKbChanged && onKbChanged()
  }

  const kbInfo = kbs.find(k => k.name === kb)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 12 }}>
        <Breadcrumb items={[
          { title: <a onClick={onBack}><FolderOutlined /> 全部知识库</a> },
          { title: <b>{kb}</b> },
        ]} />
      </div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title="条目" value={stats?.total ?? 0} /></Card></Col>
        <Col span={6}><Card size="small">
          <Statistic title="累计字符" value={stats?.chars ?? 0} />
        </Card></Col>
        <Col span={6}><Card size="small">
          <Statistic title="被引用" value={stats?.citations ?? 0}
                     valueStyle={{ color: (stats?.citations ?? 0) ? '#52c41a' : undefined }} />
        </Card></Col>
        <Col span={6}><Card size="small">
          <Statistic title="待人工核对" value={stats?.unverified ?? 0}
                     valueStyle={{ color: (stats?.unverified ?? 0) ? '#faad14' : undefined }} />
        </Card></Col>
      </Row>

      {kbInfo?.about && (
        <Alert type="info" showIcon style={{ marginBottom: 16, borderRadius: 10 }}
               message={kb} description={kbInfo.about} />
      )}

      <Card size="small" style={{ marginBottom: 16 }}
        title={<Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回知识库</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            导入到「{kb}」
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>URL · PDF · Word · 粘贴文本</Text>
        </Space>}
        extra={<Space wrap>
          <Input allowClear placeholder="在本库内搜索" prefix={<SearchOutlined />}
                 style={{ width: 220 }} value={kw} onChange={e => setKw(e.target.value)} />
          <Select allowClear placeholder="类型" style={{ width: 120 }} value={type || undefined}
                  onChange={setType}
                  options={Object.entries(TYPE_TAG).map(([k, v]) => ({ value: k, label: v }))} />
          <Button size="small" type={onlyUnverified ? 'primary' : 'default'}
                  onClick={() => setOnlyUnverified(v => !v)}>只看待核对</Button>
          <Button icon={<ReloadOutlined />} onClick={load} />
        </Space>}
      >
        {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
         : docs.length === 0
         ? <Empty description={'「' + kb + '」还是空的。导入一篇文献，AI 读完会推荐它该沉淀成什么。'} />
         : <Table rowKey="id" size="small" dataSource={docs} pagination={{ pageSize: 12 }}
             columns={[
               { title: '标题', dataIndex: 'title', render: (v, r) => (
                 <Space direction="vertical" size={0}>
                   <a onClick={() => openDoc(r.id)}>{v}</a>
                   <Text type="secondary" style={{ fontSize: 11 }}>
                     {r.source_kind === 'url' ? <LinkOutlined /> : null}{' '}
                     {r.source_ref || '来源未标注'} · {r.chars} 字
                   </Text>
                 </Space>) },
               { title: '类型', dataIndex: 'type', width: 96,
                 render: v => <Tag color={TYPE_COLOR[v]}>{TYPE_TAG[v]}</Tag> },
               { title: '标签', dataIndex: 'tags', width: 180,
                 render: (v = []) => v.map(t => <Tag key={t} style={{ fontSize: 11 }}>{t}</Tag>) },
               { title: '关联方法', dataIndex: 'methods', width: 140,
                 render: (v = []) => v.slice(0, 3).map(t => <Tag key={t} color="cyan" style={{ fontSize: 11 }}>{t}</Tag>) },
               { title: '引用', dataIndex: 'citations', width: 70,
                 render: v => v > 0
                   ? <Tooltip title="这条知识被拼进过多少次 AI 回答">
                       <Badge count={v} style={{ backgroundColor: '#52c41a' }} /></Tooltip>
                   : <Text type="secondary">—</Text> },
               { title: '核对', dataIndex: 'verified', width: 96,
                 render: (v, r) => v
                   ? <Tag icon={<CheckCircleOutlined />} color="success">已核对</Tag>
                   : <Button size="small" type="link" style={{ padding: 0 }}
                       onClick={() => verify(r.id, true)}>标为已核对</Button> },
               { title: '', width: 108, render: (v, r) => (
                 <Space size={4}>
                   <Tooltip title="编辑"><Button size="small" type="text" icon={<EditOutlined />}
                     onClick={() => openDoc(r.id)} /></Tooltip>
                   <Popconfirm title="删除后不可恢复" onConfirm={async () => {
                     await kbAPI.remove(r.id); message.success('已删除'); load(); onKbChanged && onKbChanged() }}>
                     <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                   </Popconfirm>
                 </Space>) },
             ]} />
        }
      </Card>

      <Modal open={importOpen} title={'导入到「' + (form.getFieldValue('kb') || kb) + '」'}
             width={880} footer={null}
             onCancel={() => { setImportOpen(false); setDraft(null); setQueue([]) }}>
        <Form form={form} layout="vertical" onFinish={doImport}
              initialValues={{ source_type: 'URL', kb }}>
          <Form.Item name="kb" label="导入到哪个知识库"
                     rules={[{ required: true, message: '必须先选一个知识库' }]}
                     extra={<span>
                       必须选。批量导入时选一次，这批都不用再问。
                       <a onClick={() => {
                         let n = prompt('新知识库名称：')
                         if (n) { kbAPI.createKb(n).then(r => { if (r.data.ok) {
                           message.success('已创建'); form.setFieldsValue({ kb: r.data.name }); load()
                         } else message.error(r.data.error) }) }
                       }}>新建一个</a>
                     </span>}>
            <Select options={kbs.map(k => ({
                      value: k.name,
                      label: k.name + (k.docs ? `（${k.docs} 篇）` : '（空）') }))}
                    showSearch style={{ width: '100%' }}
                    placeholder="选一个已有的，或新建" />
          </Form.Item>
          <Form.Item name="source_type" label="来源类型">
            <Select options={['URL', '上传文件', '粘贴文本'].map(v => ({ value: v, label: v }))} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.source_type !== b.source_type}>
            {({ getFieldValue }) => {
              const t = getFieldValue('source_type')
              if (t === 'URL') return (
                <Form.Item name="url" label="文章地址" rules={[{ required: true }]}>
                  <Input placeholder="连享会推文 / 期刊页 / 工作论文地址" />
                </Form.Item>)
              if (t === '上传文件') return (
                <>
                  <Upload.Dragger accept=".pdf,.docx,.doc,.txt,.md" multiple
                    fileList={[]} beforeUpload={() => false}
                    onChange={({ fileList }) => form.setFieldsValue({ file: fileList })}>
                    <p className="ant-upload-drag-icon"><UploadOutlined /></p>
                    <p className="ant-upload-text">把 PDF / Word 拖到这里，可一次多篇</p>
                    <p className="ant-upload-hint">
                      每篇各自生成一份沉淀草稿，失败的那篇只记原因，不影响其余
                    </p>
                  </Upload.Dragger>
                  <div style={{ height: 12 }} />
                </>)
              return (
                <Form.Item name="text" label="正文文本" rules={[{ required: true }]}>
                  <Input.TextArea rows={8} placeholder="把正文粘过来…" />
                </Form.Item>)
            }}
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={drafting}
                  icon={<CloudDownloadOutlined />}>读取并推荐沉淀去向</Button>
        </Form>

        {drafting && <div style={{ textAlign: 'center', padding: 30 }}><Spin tip="AI 正在读取全文…" /></div>}
        {draft && <DraftPanel draft={draft} onCommit={commitDraft} kbs={kbs} />}
      </Modal>

      <Modal open={!!detail} title={detail ? detail.meta.title : ''} width={860} footer={[
        <Button key="cancel" onClick={() => setDetail(null)}>关闭</Button>,
        <Button key="save" type="primary" onClick={saveDoc}>保存</Button>,
      ]} onCancel={() => setDetail(null)}>
        {detail && <>
          <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="知识库">{detail.kb}</Descriptions.Item>
            <Descriptions.Item label="类型">{TYPE_TAG[detail.type]}</Descriptions.Item>
            <Descriptions.Item label="来源">
              {detail.meta.source_kind} · {detail.meta.source_ref || '—'}
            </Descriptions.Item>
            <Descriptions.Item label="核对">
              {detail.meta.verified
                ? <Tag color="success">已人工核对</Tag>
                : <Tag color="warning">待核对：AI 提炼，未逐条验证</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="被引用">
              {detail.meta.citations || 0}
              <Tooltip title="这条知识被拼进过多少次 AI 回答">
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>为 0 说明它在沉没</Text>
              </Tooltip>
            </Descriptions.Item>
            <Descriptions.Item label="原文">
              {detail.meta.snapshot
                ? <a href={kbAPI.sourceUrl(detail.meta.snapshot)}
                     target="_blank" rel="noreferrer">
                    <LinkOutlined /> 打开导入时的原文
                  </a>
                : <Tooltip title="粘贴文本或早期导入的条目没有留快照">
                    <Text type="secondary">无快照</Text>
                  </Tooltip>}
            </Descriptions.Item>
          </Descriptions>
          {!detail.meta.verified && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
              message="这篇笔记由 AI 生成，尚未人工核对"
              description={'AI 提炼会失真：可能把 A 文的结论归到 B 文、把「作者认为」写成事实。'
                          + '每条论断都带了原文定位标记，请对着定位抽查几条再标为已核对。'} />
          )}
          <Input.TextArea rows={22} value={editBody} onChange={e => setEditBody(e.target.value)}
                          style={{ fontFamily: 'monospace', fontSize: 12 }} />
        </>}
      </Modal>
    </div>
  )
}

function DraftPanel({ draft, onCommit, kbs }) {
  const [choices, setChoices] = useState(() => [
    ...(draft.items || []).map(i => ({ ...i, recommended: true })),
    ...(draft.optional || []).map(o => ({ ...o, recommended: false })),
  ])
  const [targetKb, setTargetKb] = useState(draft.kb)

  const toggle = (t) => setChoices(cs =>
    cs.map(c => c.type === t ? { ...c, selected: !c.selected } : c))
  const edit = (t, field, v) => setChoices(cs =>
    cs.map(c => c.type === t ? { ...c, [field]: v } : c))

  const selected = choices.filter(c => c.selected)

  return (
    <div>
      <Alert showIcon type={draft.discard ? 'error' : 'info'} style={{ marginBottom: 12 }}
        message={`${draft.title || '未命名文档'} · ${draft.kind} · ${draft.chars} 字`
                + (draft.truncated ? '（已截断）' : '')}
        description={
          draft.discard?.why?.join('；')
          || `AI 读完后的建议：可同时沉淀为 ${(draft.items || []).length} 类产物。`
        } />
      <Form.Item label="沉淀到哪个知识库" style={{ marginBottom: 12 }}
                 extra="规则推荐的是类型，库由你定——同一篇方法论文献可以只进方法库。">
        <Select value={targetKb} onChange={setTargetKb} style={{ width: '100%' }}
                options={kbs.map(k => ({ value: k.name, label: k.name }))}
                placeholder="选择知识库" />
      </Form.Item>
      {draft.duplicates?.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`库里可能已经有这一篇了（${draft.duplicates.length} 条疑似）`}
          description={<div>
            {draft.duplicates.map((d, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <Tag color={d.same_kb ? 'orange' : 'blue'}>{d.reason}
                  {d.same_kb ? ' · 同一个库' : ' · 别的库'}</Tag>
                <strong>{d.title}</strong>
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                  在「{d.kb}」· {d.type_label}
                </Text>
              </div>
            ))}
            <div style={{ marginTop: 6, fontSize: 12 }}>
              标「同一个库」的是真重复；标「别的库」说明它已经在别处收着，
              可以考虑不放，或者放到这里做交叉引用。
            </div>
          </div>} />
      )}
      {draft.missing_loc_types?.length > 0 && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
          message="这次写的正文里没有一条论断带原文定位"
          description={<div>
            <div>{draft.missing_loc_types.join('、')} 的正文里找不到任何 （段N）/（p.N）形式的定位标记。</div>
            <div style={{ marginTop: 4 }}>
              没有定位就无法回溯验证，而 AI 提炼恰好最容易在这里失真。建议改用不带 AI 的骨架自己填，
              或者重新导入一次。
            </div>
          </div>} />
      )}
      {draft.ai_error && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`AI 未能撰写正文（${draft.ai_error}）`}
          description="已生成带原文定位的骨架，你可以手工填写后再入库。" />
      )}
      {draft.methods?.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary">识别到的关联方法：</Text>
          {draft.methods.map(m => <Tag key={m} color="cyan">{m}</Tag>)}
        </div>
      )}

      {choices.map(it => (
        <Card key={it.type} size="small" style={{ marginBottom: 12 }} type="inner"
          title={<Space>
            <Tag color={TYPE_COLOR[it.type]}>{TYPE_TAG[it.type]}</Tag>
            <Text strong>{it.label}</Text>
            {it.recommended
              ? <Tag color="green">规则推荐 · 得分 {it.score}</Tag>
              : <Tag>未推荐（得分 {it.score}，可手动勾选）</Tag>}
          </Space>}
          extra={
            <Button size="small" type={it.selected ? 'primary' : 'default'}
                    onClick={() => toggle(it.type)}>
              {it.selected ? '已选' : '选择'}
            </Button>
          }
        >
          <div style={{ marginBottom: 8 }}>
            {it.recommended && it.reasons?.length > 0
              && it.reasons.map(r => <Tag key={r} color="geekblue" style={{ fontSize: 11 }}>{r}</Tag>)}
            {it.loc_ok === true && (
              <Tag color="green" style={{ fontSize: 11 }}>论断带原文定位</Tag>)}
            {it.loc_ok === false && (
              <Tooltip title="正文里找不到 （段N）/（p.N）形式的定位标记，无法回溯验证">
                <Tag color="red" style={{ fontSize: 11 }}>缺原文定位</Tag>
              </Tooltip>)}
            {it.loc_ok === null && (
              <Tooltip title="这次没用 AI 写正文，无法校验定位；骨架自带定位，需你逐条核对">
                <Tag style={{ fontSize: 11 }}>定位未校验</Tag>
              </Tooltip>)}
          </div>
          {!it.recommended && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              规则没有达到阈值。勾上并手工填写，一样能入库。
            </Text>
          )}
          {it.selected && <>
            <Input size="small" style={{ marginBottom: 8 }}
                   placeholder="标题" defaultValue={draft.title}
                   onChange={e => edit(it.type, 'edited_title', e.target.value)} />
            <Input.TextArea rows={10} style={{ fontFamily: 'monospace', fontSize: 11 }}
                            value={it.edited_body ?? it.body ?? ''}
                            onChange={e => edit(it.type, 'edited_body', e.target.value)}
                            placeholder={it.body ? '' : `按这个结构写：\n${it.template || ''}`} />
            {!it.body && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                空白模板，需要你手工填写。
              </Text>
            )}
          </>}
        </Card>
      ))}

      <div style={{ textAlign: 'right' }}>
        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            勾选 {selected.length} 项 → 入库到「{targetKb}」
          </Text>
          <Button type="primary" icon={<BookOutlined />}
                  disabled={!selected.length || !targetKb}
                  onClick={() => onCommit(selected, targetKb)}>确认入库</Button>
        </Space>
      </div>
    </div>
  )
}

// ─────────────────────────── 数据库页签 ───────────────────────────

function DatabaseTab() {
  const [rows, setRows] = useState([])
  const [current, setCurrent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [path, setPath] = useState('')

  const load = async () => {
    setLoading(true)
    const r = await dataAPI.datasetsList()
    setRows(r.data.datasets || [])
    setCurrent(r.data.current)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const switchTo = async (name, file) => {
    const r = await dataAPI.switch(name)
    if (r.data.error) message.error(r.data.error)
    else message.success(`已切换到 ${file || name}`)
    load()
  }
  const drop = async (name) => {
    const r = await dataAPI.drop(name)
    if (r.data.ok) { message.success('已移除（磁盘文件还在，重扫项目会回来）'); load() }
    else message.error(r.data.error)
  }
  const loadPath = async () => {
    const r = await dataAPI.loadPath(path)
    if (r.data.ok) { message.success(`已加载 ${r.data.name}（${r.data.rows} 行）`); setPath(''); load() }
    else message.error(r.data.error)
  }

  return (
    <div style={{ padding: 24 }}>
      <Card size="small" style={{ marginBottom: 16 }}
        title={<Space><DatabaseOutlined /> 可用数据集</Space>}
        extra={
          <Space>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              {rows.filter(r => r.folder).length} 个来自子文件夹
            </span>
            <Button icon={<ReloadOutlined />} onClick={load} />
          </Space>
        }>
        <Table rowKey="name" size="small" loading={loading} dataSource={rows}
               pagination={false} scroll={{ y: 420 }}
               columns={[
                 { title: '数据集', dataIndex: 'file', width: 220,
                   render: (v, r) => (
                     <Space direction="vertical" size={0}>
                       <a onClick={() => switchTo(r.name, v)}>{v}</a>
                       <span style={{ fontSize: 10, color: '#94a3b8' }}>
                         {r.folder ? r.folder.split('/').join(' / ') : '项目根目录'}
                       </span>
                     </Space>) },
                 { title: '状态', dataIndex: 'ok', width: 130,
                   render: (v, r) => r.current ? <Tag color="green">当前使用</Tag>
                     : r.loaded ? <Tag color="blue">已读入内存</Tag>
                     // 只有明确 false 才说读不出。字段缺失（undefined）时按
                     // 可用处理，不然后端少返一个字段就会让整列变红
                     : v === false ? <Tooltip title={r.error}><Tag color="red" icon={<WarningOutlined />}>读不出</Tag></Tooltip>
                     : <Tag>切换时读取</Tag> },
                 { title: '来源', dataIndex: 'source', width: 110,
                   render: v => <Tag>{v}</Tag> },
                 { title: '观测数', dataIndex: 'rows', width: 100,
                   render: v => v == null ? '—' : v.toLocaleString() },
                 { title: '变量数', dataIndex: 'cols', width: 90,
                   render: v => v == null ? '—' : v },
                 { title: '缺失', dataIndex: 'missing', width: 100,
                   render: v => v == null
                     ? <Tooltip title="还没读进内存，要真读过才知道有多少缺失"><span>—</span></Tooltip>
                     : (v > 0 ? <Tag color="orange">{v.toLocaleString()}</Tag> : '—') },
                 { title: '大小(KB)', dataIndex: 'size_kb', width: 100,
                   render: v => v == null ? '—' : v.toLocaleString() },
                 { title: '', width: 130, render: (v, r) => (
                   <Space>
                     <Button size="small" disabled={r.current || !r.ok}
                             onClick={() => switchTo(r.name, r.file)}>切换</Button>
                     <Popconfirm title="移除后需重新导入或重扫项目" onConfirm={() => drop(r.name)}>
                       <Button size="small" danger disabled={r.current}>移除</Button>
                     </Popconfirm>
                   </Space>) },
               ]} />
        <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
          列表包含整个项目文件夹递归扫到的文件（含子文件夹）。行列数读的是文件头，
          切换过去才会把整份数据读进内存——所以「缺失」那一列要切换后才算得出来。
          内存里最多留 6 份，超了会丢最早那份，磁盘文件不动。
        </div>
      </Card>

      <Card size="small" title="从本地路径加载">
        <Space>
          <Input style={{ width: 520 }} placeholder="D:\\...\\xxx.dta / .csv / .xlsx"
                 value={path} onChange={e => setPath(e.target.value)}
                 onPressEnter={loadPath} prefix={<CloudDownloadOutlined />} />
          <Button type="primary" onClick={loadPath} loading={loading}>加载</Button>
          <Button onClick={async () => {
            const r = await browseAPI.list('D:\\')
            if (r.data.items?.length) message.info(`D:\\ 下有 ${r.data.items.length} 个条目`)
          }}>浏览 D 盘</Button>
        </Space>
        <div style={{ marginTop: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            当前分析页与回归页用的都是上面标记「当前使用」的那一份。切换后，之前跑出的结果不会自动重算——
            所以每个导出的报告都会记录它当时用的是哪个数据集。
          </Text>
        </div>
      </Card>
    </div>
  )
}

// ─────────────────────────── 页面壳 ───────────────────────────

export default function Resources() {
  const [tab, setTab] = useState('knowledge')
  const [kb, setKb] = useState(null)          // null = 库卡片网格
  const [autoImport, setAutoImport] = useState(false)

  return (
    <div>
      <Tabs activeKey={tab} onChange={setTab} size="large" style={{ padding: '12px 24px 0' }}
        items={[
          { key: 'knowledge', label: <span><BookOutlined /> 知识库</span>,
            children: kb
              ? <KnowledgeTab kb={kb} openImport={autoImport}
                              onBack={() => { setKb(null); setAutoImport(false) }} />
              : <KbGrid onOpen={(name, opts) => {
                  setKb(name)
                  setAutoImport(!!(opts && opts.import))
                }} /> },
          { key: 'database', label: <span><DatabaseOutlined /> 数据库</span>,
            children: <DatabaseTab /> },
        ]} />
    </div>
  )
}

// 资源管理：知识库（多库 × 三类产物）/ 数据库
