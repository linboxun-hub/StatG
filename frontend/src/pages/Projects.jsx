import React, { useState, useEffect } from 'react'
import { Card, Row, Col, Button, Modal, Form, Input, message, Empty, Popconfirm, Tag, Space, Tooltip, Spin } from 'antd'
import { FolderOpenOutlined, PlusOutlined, DeleteOutlined, CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { projectAPI } from '../api'
import FileBrowserModal from '../components/FileBrowserModal'

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [currentId, setCurrentId] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [importForm] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [rescaning, setRescaning] = useState(null)

  const fetchProjects = async () => {
    try {
      const res = await projectAPI.list()
      setProjects(res.data.projects || [])
      setCurrentId(res.data.current_id)
    } catch (e) {}
  }

  useEffect(() => { fetchProjects() }, [])

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields()
      await projectAPI.create(values.name, values.description || '')
      message.success('项目创建成功')
      setCreateOpen(false)
      createForm.resetFields()
      fetchProjects()
    } catch (e) {}
  }

  const handleImport = async () => {
    try {
      const values = await importForm.validateFields()
      setLoading(true)
      const res = await projectAPI.import(values.path, values.name || '')
      if (res.data.error) {
        message.error(res.data.error)
      } else {
        // 这里必须报清楚「多少个在子文件夹里」。之前只报一个总数，
        // 用户看到 6 个完全不知道漏了子目录里的 33 个。
        const { ok = 0, in_subdirs = 0, failed = [], code_files = 0 } = res.data
        const parts = [`${ok} 个数据集`, `${code_files} 个代码文件`]
        if (in_subdirs) parts.push(`${in_subdirs} 个在子文件夹里`)
        message.success(`导入成功：${parts.join('，')}`)
        if (failed.length) {
          Modal.warning({
            title: `${failed.length} 个文件读不出来`,
            content: (
              <div>
                {failed.slice(0, 8).map(f => (
                  <div key={f.name} style={{ fontSize: 12, marginBottom: 6 }}>
                    <b>{f.name}</b><br /><span style={{ color: '#94a3b8' }}>{f.error}</span>
                  </div>
                ))}
                {failed.length > 8 && <div style={{ fontSize: 12 }}>…等 {failed.length} 个</div>}
                <div style={{ fontSize: 12, marginTop: 8 }}>
                  这些文件仍在列表里，切过去会再告诉你是哪个、为什么。
                </div>
              </div>
            ),
          })
        }
        setImportOpen(false)
        importForm.resetFields()
        fetchProjects()
      }
    } catch (e) {}
    setLoading(false)
  }

  const handleSelect = async (pid) => {
    try {
      const res = await projectAPI.select(pid)
      if (res.data.error) {
        message.warning(res.data.error)
      } else {
        setCurrentId(pid)
        message.success(`已切换到项目`)
      }
    } catch (e) { message.error('切换失败') }
  }

  const handleDelete = async (pid) => {
    try {
      await projectAPI.delete(pid)
      message.success('已删除')
      fetchProjects()
    } catch (e) {}
  }

  const handleRescan = async (pid) => {
    setRescaning(pid)
    try {
      const res = await projectAPI.rescan(pid)
      if (res.data.error) {
        message.error(res.data.error)
      } else {
        // restored：之前在数据库页签上被手动移除、重扫才补回来的。
        // newOnDisk：磁盘上新增、或上次读不出这次读得出来的。
        // 之前只报 ok（磁盘新增），所以补回的文件会让界面说「没有变化」，
        // 而它其实刚从列表里消失过——那句话是假的。
        const restored = (res.data.restored || []).length
        const newOnDisk = (res.data.added || []).length
        const removed = (res.data.removed || []).length
        const failed = (res.data.failed || []).length
        if (newOnDisk || restored || removed || failed) {
          message.success(
            `重扫完成：磁盘新增 ${newOnDisk}，列表恢复 ${restored}，消失 ${removed}，读不出 ${failed}`)
        } else {
          message.info('没有变化')
        }
        fetchProjects()
      }
    } catch (e) { message.error('重扫失败') }
    setRescaning(null)
  }

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>项目管理</h2>
        <Space>
          <Button icon={<FolderOpenOutlined />} onClick={() => setImportOpen(true)}>导入文件夹</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建项目</Button>
        </Space>
      </div>

      {projects.length === 0 ? (
        <Empty description="还没有项目，创建一个或导入文件夹开始吧">
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建项目</Button>
            <Button icon={<FolderOpenOutlined />} onClick={() => setImportOpen(true)}>导入文件夹</Button>
          </Space>
        </Empty>
      ) : (
        <Row gutter={16}>
          {projects.map(p => (
            <Col span={8} key={p.id}>
              <Card
                hoverable
                onClick={() => handleSelect(p.id)}
                style={{
                  border: currentId === p.id ? '2px solid #6366f1' : '1px solid #e2e8f0',
                  cursor: 'pointer',
                }}
                actions={[
                  // 卡片本身可点（切换项目），操作按钮必须阻止冒泡，
                  // 不然点「删除」会先把项目切过去再弹确认框
                  currentId === p.id ? <span style={{ color: '#16a34a' }}><CheckCircleOutlined /> 当前项目</span> : <span>点击切换</span>,
                  <span onClick={e => e.stopPropagation()}>
                    <Tooltip title={p.source_path ? '重新扫描文件夹，补上新增的文件' : '这个项目不是从文件夹导入的，没有可重扫的目录'}>
                      <ReloadOutlined
                        style={{ color: p.source_path ? '#6366f1' : '#cbd5e1' }}
                        onClick={() => p.source_path && handleRescan(p.id)} />
                    </Tooltip>
                  </span>,
                  <span onClick={e => e.stopPropagation()}>
                    <Popconfirm title="确认删除此项目？" onConfirm={() => handleDelete(p.id)}>
                      <DeleteOutlined style={{ color: '#ef4444' }} />
                    </Popconfirm>
                  </span>,
                ]}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: currentId === p.id ? '#eef2ff' : '#f1f5f9',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 18, color: currentId === p.id ? '#6366f1' : '#64748b',
                  }}>
                    <FolderOpenOutlined />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>{p.description || '暂无描述'}</div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.8 }}>
                  创建于 {p.created_at}
                  <br />
                  {p.source_path
                    ? <span>{p.n_datasets} 个数据文件
                        {p.n_subdir_files > 0 && <b style={{ color: '#6366f1' }}>（{p.n_subdir_files} 个在子文件夹里）</b>}
                        {p.n_broken > 0 && <Tag color="red" style={{ marginLeft: 6, fontSize: 10 }}>{p.n_broken} 个读不出</Tag>}
                        <br /><span style={{ color: '#cbd5e1' }}>{p.source_path}</span></span>
                    : '未绑定文件夹，无法重扫'}
                </div>
                {rescaning === p.id && <div style={{ marginTop: 6 }}><Spin size="small" /></div>}
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 新建项目 Modal */}
      <Modal title="新建项目" open={createOpen} onOk={handleCreate} onCancel={() => { setCreateOpen(false); createForm.resetFields() }}>
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="例如：教育回报率研究" />
          </Form.Item>
          <Form.Item name="description" label="项目描述">
            <Input.TextArea rows={2} placeholder="简要描述研究内容（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 导入文件夹 Modal */}
      <Modal
        title="导入文件夹"
        open={importOpen}
        onOk={handleImport}
        onCancel={() => { setImportOpen(false); importForm.resetFields() }}
        confirmLoading={loading}
      >
        <Form form={importForm} layout="vertical">
          <Form.Item name="path" label="文件夹路径" rules={[{ required: true, message: '请输入文件夹路径' }]}>
            <Input placeholder="例如：D:\研究\教育回报率" suffix={
              <Button type="text" size="small" onClick={() => setBrowseOpen(true)} style={{ margin: -4 }}>
                <FolderOpenOutlined /> 浏览
              </Button>
            } />
          </Form.Item>
          <Form.Item name="name" label="项目名称（可选）">
            <Input placeholder="留空则使用文件夹名称" />
          </Form.Item>
          <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.8 }}>
            支持读取的文件类型：<br />
            • 数据文件：CSV、Excel (.xlsx/.xls)、Stata (.dta)<br />
            • 代码文件：.do、.sps、.r、.py、.ipynb
          </div>
        </Form>
      </Modal>

      {/* 文件浏览器 */}
      <FileBrowserModal
        open={browseOpen}
        onOk={(path) => { importForm.setFieldsValue({ path }); setBrowseOpen(false) }}
        onCancel={() => setBrowseOpen(false)}
      />
    </div>
  )
}
