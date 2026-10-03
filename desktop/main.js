// StatG（桌面版）主进程
//
// 做的事：拉起本地 FastAPI 后端 → 起一个「静态前端 + /api 反向代理」的小服务器 →
// 用 BrowserWindow 打开。使用者双击图标即可，不用开终端、不用跑 npm run dev。
//
// 端口：UI 5180（前端），API 8000（后端）。两个都可用环境变量覆盖。
// 后端解释器：依次找 STATA_PYTHON、安装包自带的 Python 运行时、本机 Anaconda、
// PATH 上的 python。自带那份连依赖一起打包，装完即用，不用另装 Anaconda。

const { app, BrowserWindow, shell, ipcMain } = require('electron')
const { spawn, exec } = require('child_process')
const http = require('http')
const https = require('https')
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
let backendErr = ''      // 后端最后一段报错，启动失败时拿给用户看

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

// 安装包里自带的那份 Python：解释器加全部依赖，用户机器上什么都不用装。
// 见 build/requirements-runtime.txt 和 build/make_pyruntime.ps1。
function bundledPython() {
  const p = path.join(process.resourcesPath || '', 'python-runtime', 'python.exe')
  return fs.existsSync(p) ? p : null
}

// 优先用自带的那份——那是唯一确定齐全的。用户自己的环境留给开发时用：
// STATA_PYTHON 仍然排在最前，想换解释器设它就行。
const PY_CANDIDATES = [
  process.env.STATA_PYTHON,
  bundledPython(),
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
  // matplotlib 要把字体缓存写到用户目录。程序装在 C:\Program Files 下时那份缓存
  // 可能写不进去（只读或要管理员权限），所以统一指到 userData，和窗口状态、
  // 更新记录放在一处。PYTHONIOENCODING 同理——子进程的 stdio 是管道不是控制台，
  // Python 会按本地代码页编码（简体中文机器上是 GBK），日志里遇到生僻字就
  // UnicodeEncodeError 崩掉。
  const mplDir = path.join(app.getPath('userData'), 'mpl')
  try { fs.mkdirSync(mplDir, { recursive: true }) } catch (e) {}
  log('starting backend:', py, '| cwd:', bdir,
      '| 自带运行时:', bundledPython() ? '是' : '否')
  backendProc = spawn(py,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(API_PORT)],
    { cwd: bdir, windowsHide: true, env: { ...process.env, MPLCONFIGDIR: mplDir, PYTHONIOENCODING: 'utf-8' } })
  backendProc.stdout.on('data', (d) => log('[uvicorn]', String(d).trim()))
  backendProc.stderr.on('data', (d) => {
    const s = String(d).trim()
    log('[uvicorn!]', s)
    backendErr = (backendErr ? backendErr + '\n' + s : s).slice(-1500)
  })
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

// ── 版本与更新 ──
// 发布流程：改 package.json 的 version → npm run dist → 在 GitHub 上建一个 tag 为
// v<version> 的 Release，把安装包作为 asset 传上去。程序这边查
// /repos/<owner>/<repo>/releases/latest，比版本号，告诉用户要不要更新。
//
// 仓库地址按这个优先级找：用户 Data/update.json 里手填的 → 环境变量 STATG_REPO
// → package.json 的 build.publish。前两级都没有、或者还是占位符，就告诉用户去填。
const PKG = require('./package.json')
const REPO_PLACEHOLDER = 'YOUR_GITHUB_USERNAME'
const updateStateFile = () => path.join(app.getPath('userData'), 'update.json')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000   // 自动检查的最短间隔，别每次开都去打 GitHub

function currentRepo() {
  try {
    const j = JSON.parse(fs.readFileSync(updateStateFile(), 'utf8'))
    if (j.repo) return String(j.repo).trim()
  } catch (e) {}
  if (process.env.STATG_REPO) return String(process.env.STATG_REPO).trim()
  const p = (PKG.build && PKG.build.publish && PKG.build.publish[0]) || {}
  if (p.owner && p.repo && p.owner !== REPO_PLACEHOLDER) return `${p.owner}/${p.repo}`
  return ''
}

function parseVer(v) {
  const m = String(v || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [+m[1], +m[2], +m[3]] : null
}
function isNewer(remote, local) {
  const a = parseVer(remote), b = parseVer(local)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// GitHub API 要求带 User-Agent，否则直接 403；assets 会 302 到别的域名，要跟着跳
function httpsGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'StatG-Updater', 'Accept': 'application/vnd.github+json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return httpsGetJson(res.headers.location, timeoutMs).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub 返回 HTTP ${res.statusCode}`)) }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => body += d)
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(new Error('返回的不是 JSON')) } })
    })
    req.on('timeout', () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
  })
}

async function checkUpdate() {
  const repo = currentRepo()
  if (!repo) {
    return { ok: false, reason: 'no-repo', message: '还没填 GitHub 仓库。填成「用户名/仓库名」，例如 octocat/StatG。' }
  }
  try {
    const rel = await httpsGetJson(`https://api.github.com/repos/${repo}/releases/latest`, 12000)
    const current = app.getVersion()
    // 优先挑安装包（名字里带 Setup / 安装），否则退而求其次挑第一个 exe
    const exes = (rel.assets || []).filter(a => /\.exe$/i.test(a.name))
    const asset = exes.find(a => /setup|安装/i.test(a.name)) || exes[0]
    return {
      ok: true, repo, current,
      latest: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
      hasUpdate: isNewer(rel.tag_name || rel.name, current),
      url: rel.html_url,
      notes: String(rel.body || '').slice(0, 1500),
      publishedAt: rel.published_at || '',
      assetUrl: asset ? asset.browser_download_url : null,
      assetName: asset ? asset.name : null,
      assetSize: asset ? asset.size : null,
    }
  } catch (e) {
    return { ok: false, reason: 'net', message: `检查失败：${e.message}` }
  }
}

function downloadUpdate(url, name) {
  return new Promise((resolve, reject) => {
    const dir = app.getPath('downloads') || app.getPath('temp')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name || 'StatG-Setup.exe')
    let done = 0, total = 0

    const step = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http
      mod.get(u, { headers: { 'User-Agent': 'StatG-Updater' }, timeout: 20000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (redirects > 8) return reject(new Error('跳转次数太多'))
          return step(res.headers.location, redirects + 1)
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载返回 HTTP ${res.statusCode}`)) }
        total = Number(res.headers['content-length'] || 0)
        const out = fs.createWriteStream(file)
        res.on('data', (chunk) => {
          done += chunk.length
          if (win && !win.isDestroyed()) {
            win.webContents.send('app:update-progress', { received: done, total, percent: total ? Math.round(done * 100 / total) : null })
          }
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => resolve({ path: file, bytes: done })))
        out.on('error', (e) => { try { fs.unlinkSync(file) } catch (e2) {}; reject(e) })
      }).on('timeout', function () { this.destroy(new Error('下载超时')) })
        .on('error', (e) => { try { fs.unlinkSync(file) } catch (e2) {}; reject(e) })
    }
    step(url, 0)
  })
}

// 启动后悄悄查一次：6 小时内查过就不再查，查到有新版本就通知渲染进程
async function checkUpdateOnStartup() {
  try {
    let last = 0
    try { last = JSON.parse(fs.readFileSync(updateStateFile(), 'utf8')).lastChecked || 0 } catch (e) {}
    const now = Date.now()
    if (now - last < CHECK_INTERVAL_MS) return
    const r = await checkUpdate()
    try {
      const j = JSON.parse(fs.readFileSync(updateStateFile(), 'utf8'))
      fs.writeFileSync(updateStateFile(), JSON.stringify({ ...j, lastChecked: now }, null, 2))
    } catch (e) {}
    if (r.ok && r.hasUpdate && win && !win.isDestroyed()) {
      win.webContents.send('app:update-available', r)
    }
  } catch (e) { log('startup update check failed:', e.message) }
}

// ── 窗口 ──
function stateFile() { return path.join(app.getPath('userData'), 'window-state.json') }

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (typeof s.width === 'number' && typeof s.height === 'number') return s
  } catch (e) {}
  return null
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return
  try {
    // 最大化时存的是还原后的尺寸，否则每次还原都会变成最大化的大小
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }))
  } catch (e) {}
}

function createWindow() {
  const st = loadWindowState()
  win = new BrowserWindow({
    width: st?.width || 1480, height: st?.height || 940,
    x: st?.x, y: st?.y,
    minWidth: 1100, minHeight: 700, show: false,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    title: 'StatG',
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
  // 记住位置和尺寸；默认以最大化打开，界面不会忽大忽小
  if (st?.maximized !== false) win.maximize()
  let saveTimer = null
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400) }
  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('close', saveWindowState)
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
    if (!ok) {
      // 以前这里只有一句「请检查 Python 环境」，等于让用户自己猜。现在把
      // 用的是哪个解释器、有没有用上自带运行时、后端最后报了什么，都说清楚。
      const py = pickPython()
      const bundled = bundledPython()
      dialogError('后端启动失败',
        '没能拉起本地后端服务。\n\n' +
        `解释器：${py}\n` +
        `自带运行时：${bundled ? '已用上' : '没找到（安装可能不完整，重装试试）'}\n\n` +
        (backendErr ? `后端最后的输出：\n${backendErr}\n\n` : '') +
        '如果想改用自己装的 Python，设一个环境变量 STATA_PYTHON 指向它的 python.exe，' +
        '那份里面需要有 backend/requirements.txt 里的依赖。')
    }
    if (win) win.loadURL(`http://127.0.0.1:${UI_PORT}/`)

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
    checkUpdateOnStartup()
  })

  app.on('window-all-closed', async () => { await stopBackend(); if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', async (e) => { e.preventDefault(); saveWindowState(); await stopBackend(); app.exit(0) })

  // ── 更新相关的 IPC ──
  ipcMain.handle('app:info', () => ({
    ok: true, version: app.getVersion(), platform: process.platform, arch: process.arch,
    repo: currentRepo(), electron: process.versions.electron,
    // 「运行环境」那一栏用：让用户一眼看出后端到底是哪个 Python 在跑
    python: pickPython(),
    pythonBundled: !!bundledPython(),
  }))

  ipcMain.handle('app:check-update', async () => checkUpdate())

  ipcMain.handle('app:set-repo', (e, repo) => {
    const v = String(repo || '').trim()
    try { fs.writeFileSync(updateStateFile(), JSON.stringify({ repo: v }, null, 2)) } catch (err) {}
    return { ok: true, repo: v }
  })

  // 下载安装包到「下载」目录，进度通过 app:update-progress 推给渲染进程
  ipcMain.handle('app:download-update', async (e, url, name) => {
    if (!url) throw new Error('这个 Release 里没找到可下载的安装包')
    return downloadUpdate(url, name || 'StatG-Setup.exe')
  })

  // 装好安装包就退出：安装程序自己会盖掉旧文件
  ipcMain.handle('app:install-update', async (e, file) => {
    if (!file || !fs.existsSync(file)) throw new Error('安装包不存在：' + file)
    const p = spawn(file, [], { detached: true, stdio: 'ignore' })
    p.unref()
    app.quit()
    return { ok: true }
  })
}

function dialogError(title, content) {
  try { require('electron').dialog.showErrorBox(title, content) } catch (e) { log(title, content) }
}