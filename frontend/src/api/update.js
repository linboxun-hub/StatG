// 版本与更新：一层薄封装 + 一个极简的状态store。
//
// 更新通道是 Electron 主进程的 IPC（window.statgApp），不是 HTTP，
// 所以不能并进 api/index.js 那个 axios 实例里。
// 在浏览器里跑开发版时 window.statgApp 不存在，所有方法都返回「不在桌面端」，
// 页面照常渲染，只是更新那一块会提示用打包版。

const HAS_DESKTOP = typeof window !== 'undefined' && !!window.statgApp

// ── 极简 store：侧边栏页脚和设置页都要读同一份状态 ──
const listeners = new Set()
let state = {
  checking: false,
  info: null,          // { version, platform, arch, repo }
  result: null,        // 最近一次检查的完整结果
  error: '',
  progress: null,      // { received, total, percent }
  downloading: false,
  downloaded: null,    // 安装包落盘路径
}

function set(patch) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn(state))
}

export const updateStore = {
  get: () => state,
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

const NO_DESKTOP = { ok: false, reason: 'not-desktop', message: '只有打包好的桌面版能检查更新' }

export const updateAPI = {
  isDesktop: HAS_DESKTOP,

  async loadInfo() {
    if (!HAS_DESKTOP) { set({ info: { version: '', platform: 'web' } }); return null }
    try {
      const info = await window.statgApp.info()
      set({ info })
      return info
    } catch (e) { set({ error: e.message }); return null }
  },

  async check() {
    if (!HAS_DESKTOP) { set({ result: NO_DESKTOP }); return NO_DESKTOP }
    set({ checking: true, error: '' })
    try {
      const r = await window.statgApp.checkUpdate()
      set({ checking: false, result: r, error: r.ok ? '' : (r.message || '') })
      return r
    } catch (e) {
      set({ checking: false, error: e.message })
      return { ok: false, message: e.message }
    }
  },

  async setRepo(repo) {
    if (!HAS_DESKTOP) return NO_DESKTOP
    const r = await window.statgApp.setRepo(repo)
    await updateAPI.loadInfo()
    return r
  },

  async download(url, name, onProgress) {
    if (!HAS_DESKTOP) return NO_DESKTOP
    set({ downloading: true, progress: null, downloaded: null, error: '' })
    const off = window.statgApp.onProgress((d) => {
      set({ progress: d })
      if (onProgress) onProgress(d)
    })
    try {
      const r = await window.statgApp.downloadUpdate(url, name)
      set({ downloading: false, downloaded: r.path, progress: null })
      return r
    } catch (e) {
      set({ downloading: false, progress: null, error: e.message })
      throw e
    } finally { off() }
  },

  async install(file) {
    if (!HAS_DESKTOP) return NO_DESKTOP
    return window.statgApp.installUpdate(file)
  },

  // 主进程启动时后台查到新版本，会推到这里
  onAvailable(cb) {
    if (!HAS_DESKTOP) return () => {}
    return window.statgApp.onAvailable((r) => { set({ result: r }); cb(r) })
  },
}

export function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
