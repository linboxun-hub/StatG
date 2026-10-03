// Stata 助手（桌面版）主进程
//
// 做的事：拉起本地 FastAPI 后端 → 起一个「静态前端 + /api 反向代理」的小服务器 →
// 用 BrowserWindow 打开。使用者双击图标即可，不用开终端、不用跑 npm run dev。
//
// 端口：UI 5180（前端），API 8000（后端）。两个都可用环境变量覆盖。
// 后端解释器：依次找 STATA_PYTHON、本机 Anaconda、PATH 上的 python。

const { app, BrowserWindow, shell } = require('electron')
const { spawn, exec } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

const UI_PORT = Number(process.env.STATA_UI_PORT || 5180)
const API_PORT = Number(process.env.STATA_API_PORT || 8000)
const IS_DEV = !!process.env.STATA_DEV

const ROOT = path.resolve(__dirname, '..')            // 源码仓库根
const ICON = path.join(__dirname, 'build', 'icon.ico')
const LOADING = path.join(__dirname, 'build', 'loading.html')

let backendProc = null
let uiServer = null
let win = null

function log() { console.log('[desktop]', ...arguments) }

// ── 前端静态资源目录：打包后从 extraResources 拿，开发时从仓库拿 ──
function distDir() {
  const cands = [
    path.join(process.resourcesPath || '', 'frontend-dist'),
    path.join(ROOT, 'frontend', 'dist'),
  ]
  return cands.find((p) => fs.existsSync(path.join(p, 'index.html'))) || null
}

// ── 后端目录与 Python 解释器 ──
function backendDir() {
  const cands = [
    path.join(process.resourcesPath || '', 'backend'),
    process.env.STATA_BACKEND,
    path.join(ROOT, 'backend'),
  ].filter(Boolean)
  return cands.find((p) => fs.existsSync(path.join(p, 'main.py'))) || null
}

const PY_CANDIDATES = [
  process.env.STATA_PYTHON,
  'D:\\Anaconda\\anaconda\\python.exe',
  'D:\\Anaconda3\\python.exe',
  'C:\\ProgramData\\Anaconda3\\python.exe',
  'python',
].filter(Boolean)

function pickPython() {
  return PY_CANDIDATES.find((p) => p === 'python' || fs.existsSync(p)) || 'python'
}

// ── 后端探活（带一次性回调保护，避免 timeout/error 双触发）──
function probeBackend() {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = http.get({
      host: '127.0.0.1', port: API_PORT, path: '/api/regression/methods', timeout: 2000,
    }, (res) => { res.resume(); finish(res.statusCode === 200) })
    req.on('error', () => finish(false))
    req.on('timeout', () => { req.destroy(); finish(false) })
  })
}

function waitBackendReady(timeoutMs) {
  const start = Date.now()
  return (function poll() {
    return probeBackend().then((ok) => {
      if (ok) return true
      if (Date.now() - start > timeoutMs) return false
      return new Promise((r) => setTimeout(r, 600)).then(poll)
    })
  })()
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    exec(`taskkill /PID ${pid} /T /F`, () => resolve())
  })
}

async function stopBackend() {
  if (backendProc && !backendProc.killed) {
    log('stopping backend pid', backendProc.pid)
    await killTree(backendProc.pid)
    backendProc = null
  }
}

async function ensureBackend() {
  if (await probeBackend()) {
    log('reusing already-running backend on :' + API_PORT)
    return true
  }
  const bdir = backendDir()
  if (!bdir) {
    log('ERROR: 找不到后端目录（backend/main.py）')
    return false
  }
  const py = pickPython()
  log('starting backend:', py, '| cwd:', bdir)
  backendProc = spawn(py,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)],
    { cwd: bdir, windowsHide: true })
  backendProc.stdout.on('data', (d) => log('[uvicorn]', String(d).trim()))
  backendProc.stderr.on('data', (d) => log('[uvicorn!]', String(d).trim()))
  backendProc.on('exit', (code) => { log('backend exited:', code); backendProc = null })

  const ok = await waitBackendReady(120000)
  log(ok ? 'backend ready' : 'backend NOT ready in time')
  return ok
}

// ── 静态服务器 + /api 反向代理 ──
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

function startUiServer() {
  return new Promise((resolve, reject) => {
    const DIST = distDir()
    if (!DIST) return reject(new Error('找不到前端产物 frontend/dist（请先 npm run build）'))

    uiServer = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${UI_PORT}`)

      // /api → 本地后端
      if (u.pathname.startsWith('/api')) {
        const opts = {
          host: '127.0.0.1', port: API_PORT,
          path: u.pathname + u.search, method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
        }
        const pr = http.request(opts, (pres) => {
          res.writeHead(pres.statusCode, pres.headers)
          pres.pipe(res)
        })
        pr.on('error', () => {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '后端未就绪，请稍后重试' }))
        })
        req.pipe(pr)
        return
      }

      let p
      try { p = decodeURIComponent(u.pathname) } catch (e) { p = u.pathname }
      if (p === '/' || p === '') p = '/index.html'
      const file = path.normalize(path.join(DIST, p))
      if (!file.startsWith(DIST)) {
        res.writeHead(403); return res.end('forbidden')
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          // SPA 兜底：非 .assets 资源一律回 index.html，交给前端路由
          if (!/\.[a-z0-9]+$/i.test(p)) {
            return fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
              if (e2) { res.writeHead(404); return res.end('index.html missing') }
              res.writeHead(200, { 'Content-Type': MIME['.html'] })
              res.end(html)
            })
          }
          res.writeHead(404); return res.end('not found')
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        })
        res.end(data)
      })
    })

    uiServer.on('error', reject)
    uiServer.listen(UI_PORT, '127.0.0.1', () => {
      log('ui server on http://127.0.0.1:' + UI_PORT + '  serving ' + DIST)
      resolve()
    })
  })
}

// ── 窗口 ──
function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1080, minHeight: 720, show: false,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    title: 'Stata 助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.loadURL(`http://127.0.0.1:${UI_PORT}/`)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => { win = null })
}

// ── 生命周期 ──
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(async () => {
    try {
      await startUiServer()
    } catch (e) {
      log('server error:', e.message)
      dialogError('启动失败', e.message)
      app.quit(); return
    }
    // 先显示启动页，后端就绪后再切到应用
    createWindow()
    if (fs.existsSync(LOADING)) {
      win.loadFile(LOADING)   // 启动页（带 logo 与进度提示）
    }
    const ok = await ensureBackend()
    if (!ok) dialogError('后端启动失败', '没能拉起本地后端服务，请检查 Python 环境后重试。')
    if (win) win.loadURL(`http://127.0.0.1:${UI_PORT}/`)

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('window-all-closed', async () => { await stopBackend(); if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', async (e) => { e.preventDefault(); await stopBackend(); app.exit(0) })
}

function dialogError(title, content) {
  try { require('electron').dialog.showErrorBox(title, content) } catch (e) { log(title, content) }
}