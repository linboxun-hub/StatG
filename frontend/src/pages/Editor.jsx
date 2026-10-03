import React, { useState, useRef } from 'react'
import { Card, Button, Tabs, List, message, Space, Tag } from 'antd'
import { PlayCircleOutlined, SaveOutlined } from '@ant-design/icons'
import Editor from '@monaco-editor/react'
import { codeAPI } from '../api'

const DEFAULT_CODE = `* 面板数据回归分析
* 作者：张研究员

use "panel_data.csv", clear

xtset id year

* 描述性统计
summarize wage edu exp

* 固定效应模型
xtreg wage edu exp i.industry, fe

* 豪斯曼检验
hausman fe

* 稳健标准误
xtreg wage edu exp i.industry, fe robust
`

const STATA_LANG = {
  tokenizer: {
    root: [
      [/\*.*/, 'comment'],
      [/\b(use|xtset|summarize|sum|describe|regress|reg|xtreg|hausman|corr|pwcorr|ttest|anova|tabulate|tab|histogram|hist|scatter|list|outreg2|predict|test|lincom|margins|estimates|encode|decode|merge|append|reshape|egen|gen|replace|drop|keep|rename|label|tabulate|xi)\b/, 'keyword'],
      [/\b(fe|re|robust|clear|detail|if|in|using|replace|append|keep|merge)\b/, 'type'],
      [/".*?"/, 'string'],
      [/\b\d+\.?\d*\b/, 'number'],
    ],
  },
}

export default function CodeEditor() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [outputs, setOutputs] = useState([])
  const [running, setRunning] = useState(false)
  const [variables, setVariables] = useState([])
  const [history, setHistory] = useState([])
  const [activeRightTab, setActiveRightTab] = useState('output')
  const editorRef = useRef(null)

  const handleRun = async () => {
    const selected = editorRef.current?.getModel()?.getValueInRange(
      editorRef.current.getSelection()
    )
    const codeToRun = selected?.trim() || code
    if (!codeToRun.trim()) return

    setRunning(true)
    try {
      const res = await codeAPI.run(codeToRun)
      setOutputs(res.data.outputs || [])
      setActiveRightTab('output')
      codeAPI.variables().then(r => setVariables(r.data.variables || []))
      codeAPI.history().then(r => setHistory(r.data.history || []))
    } catch (e) {
      message.error('执行失败')
    }
    setRunning(false)
  }

  const handleEditorMount = (editor) => {
    editorRef.current = editor
    editor.addAction({
      id: 'run-code',
      label: 'Run Code',
      keybindings: [2048 | 49], // Ctrl+Enter
      run: () => handleRun(),
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)' }}>
      <div style={{ padding: '8px 16px', background: '#fff', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#64748b' }}>do-file: analysis.do</span>
        <Space>
          <Button icon={<SaveOutlined />} onClick={() => message.success('已保存')}>保存</Button>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} loading={running} style={{ background: '#10b981', borderColor: '#10b981' }}>
            运行 (Ctrl+Enter)
          </Button>
        </Space>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Editor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>
          <Editor
            height="100%"
            language="plaintext"
            value={code}
            onChange={v => setCode(v || '')}
            onMount={handleEditorMount}
            theme="vs-dark"
            options={{
              fontSize: 14,
              fontFamily: '"SF Mono", Consolas, Monaco, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              padding: { top: 12 },
            }}
          />
        </div>

        {/* Right panel */}
        <div style={{ width: 420, borderLeft: '1px solid #e2e8f0', background: '#fff', display: 'flex', flexDirection: 'column' }}>
          <Tabs
            activeKey={activeRightTab}
            onChange={setActiveRightTab}
            style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
            items={[
              {
                key: 'output', label: '结果',
                children: (
                  <div style={{ padding: 16, fontFamily: '"SF Mono", Consolas, monospace', fontSize: 12, lineHeight: '20px', overflow: 'auto', flex: 1 }}>
                    {outputs.length === 0 && <div style={{ color: '#94a3b8' }}>运行代码查看结果...</div>}
                    {outputs.map((o, i) => (
                      <div key={i} style={{ marginBottom: 16 }}>
                        <div style={{ color: '#6366f1', marginBottom: 4 }}>. {o.command}</div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#334155', background: '#f8fafc', padding: 12, borderRadius: 6, fontSize: 11 }}>
                          {o.output}
                        </pre>
                      </div>
                    ))}
                  </div>
                ),
              },
              {
                key: 'vars', label: '变量',
                children: (
                  <div style={{ padding: 16, fontSize: 13 }}>
                    {variables.length === 0 && <div style={{ color: '#94a3b8' }}>加载数据后显示变量列表</div>}
                    {variables.map((v, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                        <span style={{ fontFamily: 'monospace' }}>{v.name}</span>
                        <Tag color={v.type === 'object' ? 'orange' : 'blue'} style={{ margin: 0 }}>{v.type}</Tag>
                      </div>
                    ))}
                  </div>
                ),
              },
              {
                key: 'history', label: '历史',
                children: (
                  <div style={{ padding: 16, fontSize: 13 }}>
                    {history.length === 0 && <div style={{ color: '#94a3b8' }}>暂无历史记录</div>}
                    {history.slice().reverse().map((h, i) => (
                      <div key={i} style={{ padding: '4px 0', borderBottom: '1px solid #f1f5f9', fontFamily: 'monospace', fontSize: 12, color: '#475569' }}>
                        {h}
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
