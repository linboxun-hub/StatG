import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export const dataAPI = {
  upload: (file) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post('/data/upload', fd)
  },
  // 数据集名是相对项目目录的路径（"机制检验/利润表/FS_Comins.dta"），
  // 带斜杠，所以后端路由用 :path 匹配，前端不要再做任何转义处理
  list: () => api.get('/data/list'),
  statspaiDatasets: () => api.get('/data/statspai_datasets'),
  loadStatspai: (name) => api.post('/data/load_statspai', { name }),
  select: (name) => api.post(`/data/select/${name}`),
  get: (page, pageSize, search) => api.get('/data', { params: { page, page_size: pageSize, search } }),
  info: () => api.get('/data/info'),
  variables: () => api.get('/data/variables'),
  summary: () => api.get('/data/summary'),
  exportCsv: () => api.get('/data/export/csv', { responseType: 'blob' }),
  syncProject: () => api.post('/data/sync-project'),
  datasetsList: () => api.get('/data/datasets'),
  switch: (name) => api.post(`/data/switch/${name}`),
  drop: (name) => api.delete(`/data/datasets/${name}`),
  loadPath: (path) => api.post('/data/load-path', { path }),
  clean: (method, config) => api.post('/data/clean', { method, config }),
  cleanUndo: () => api.post('/data/clean/undo'),
  cleanState: () => api.get('/data/clean/state'),
}

export const codeAPI = {
  run: (code) => api.post('/code/run', { code }),
  history: () => api.get('/code/history'),
  variables: () => api.get('/code/variables'),
}

export const analysisAPI = {
  run: (method, config) => api.post('/analysis/run', { method, config }),
}

export const graphAPI = {
  generate: (chart_type, config) => api.post('/graph/generate', { chart_type, config }),
  exportPng: (chart_type, config) => api.post('/graph/export-png', { chart_type, config }, { responseType: 'blob' }),
  aiDiagnose: (chartData, apiConfig) => api.post('/graph/ai-diagnose', { chart_data: chartData, api_config: apiConfig }),
}

export const regressionAPI = {
  methods: () => api.get('/regression/methods'),
  run: (method, config) => api.post('/regression/run', { method, config }),
  // 多模型对照表：一次跑 N 份 (method, config)，按系数名对齐成一张矩阵
  esttab: (payload) => api.post('/regression/esttab', payload),
  // 基准表经典序列：无控制 → 加控制 → 个体 FE → 双向 FE → 双 FE + 聚类
  standardSequence: (config) => api.post('/regression/standard-sequence', config),
}

// 机制检验：中介效应（三步法 + Sobel + Bootstrap）、调节效应（交互项）
export const mechanismAPI = {
  mediation: (config) => api.post('/mechanism/mediation', config),
  moderation: (config) => api.post('/mechanism/moderation', config),
}

export const exportAPI = {
  create: (data) => api.post('/exports/create', data),
  list: () => api.get('/exports'),
  delete: (id) => api.delete(`/exports/${id}`),
  result: (fmt, result, title = '') =>
    api.post(`/exports/result/${fmt}`,
      { name: (result.method || 'analysis'), result, title }),
  // 多模型对照表：matrix 就是 /regression/esttab 返回的那份，后端只渲染不重跑
  esttab: (fmt, matrix, name = '多模型对照表', rowMode = 'core_const') =>
    api.post(`/exports/result/${fmt}`, { name, result: matrix, row_mode: rowMode }),
}

export const statsAPI = {
  get: () => api.get('/stats'),
}

export const profileAPI = {
  get: () => api.get('/profile'),
}

export const aiAPI = {
  chat: (messages, apiConfig, page = '') =>
    api.post('/ai/chat', { messages, api_config: apiConfig, page }),
}

export const projectAPI = {
  list: () => api.get('/projects'),
  create: (name, description) => api.post('/projects', { name, description }),
  get: (pid) => api.get(`/projects/${pid}`),
  select: (pid) => api.post(`/projects/${pid}/select`),
  delete: (pid) => api.delete(`/projects/${pid}`),
  import: (path, name) => api.post('/projects/import', { path, name }),
  rescan: (pid) => api.post(`/projects/${pid}/rescan`),
  catalog: (pid) => api.get(`/projects/${pid}/catalog`),
  datasets: (pid) => api.get(`/projects/${pid}/datasets`),
}

export const browseAPI = {
  list: (path) => api.get('/browse', { params: { path } }),
}

export const kbAPI = {
  kbs: () => api.get('/kb/kbs'),
  createKb: (name, about = '') => api.post('/kb/kbs', { name, about }),
  updateKb: (name, body) => api.put(`/kb/kbs/${encodeURIComponent(name)}`, body),
  removeKb: (name) => api.delete(`/kb/kbs/${encodeURIComponent(name)}`),

  stats: (kb = '') => api.get('/kb/stats', { params: { kb } }),
  list: (params) => api.get('/kb/docs', { params }),
  get: (id) => api.get(`/kb/docs/${id}`),
  create: (payload) => api.post('/kb/docs', payload),
  update: (id, payload) => api.put(`/kb/docs/${id}`, payload),
  remove: (id) => api.delete(`/kb/docs/${id}`),
  verify: (id, verified) => api.post(`/kb/docs/${id}/verify`, { verified }),
  search: (q, k = 8, dtype = '', kb = '') =>
    api.get('/kb/search', { params: { q, k, dtype, kb } }),

  // 导入：URL / 粘贴文本走 JSON，文件走 multipart，多文件走批量
  ingest: (payload) => api.post('/kb/ingest', payload),
  ingestFile: (file, apiConfig, kb = '') => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('api_config', JSON.stringify(apiConfig || {}))
    fd.append('kb', kb)
    return api.post('/kb/ingest-file', fd)
  },
  batch: (files, apiConfig, kb = '') => {
    const fd = new FormData()
    files.forEach(f => fd.append('files', f))
    fd.append('api_config', JSON.stringify(apiConfig || {}))
    fd.append('kb', kb)
    return api.post('/kb/ingest-batch', fd)
  },

  draft: (id) => api.get(`/kb/drafts/${id}`),
  commit: (id, chosen, metaExtra, kb = '') =>
    api.post(`/kb/drafts/${id}/commit`, { chosen, meta_extra: metaExtra, kb }),
  sourceUrl: (name) => `/api/kb/source/${encodeURIComponent(name)}`,
  seedBuiltins: () => api.post('/kb/seed-builtins'),
}
