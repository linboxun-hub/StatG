// 预加载脚本：只暴露极少、明确的东西，渲染进程拿不到 Node 能力。
//
// stataApp 是最早那版（只给版本号和平台），留着不动，防止老代码找不到。
// statgApp 是给「版本与更新」用的：查 GitHub Release、下安装包、装上。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stataApp', {
  version: '1.2.0',
  platform: process.platform,
})

// statgWin：Codex 风格标题栏那三个窗口按钮用。
// 原生 titleBarOverlay 的键是按白顶栏配色的，在深色标题栏上底色对不上，
// 所以前端自己画一套，经这里驱动真窗口。浏览器里没有这个对象，
// 前端按 typeof window.statgWin 判断，整组按钮直接不渲染。
contextBridge.exposeInMainWorld('statgWin', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  close: () => ipcRenderer.invoke('win:close'),
})

contextBridge.exposeInMainWorld('statgApp', {
  platform: process.platform,
  // 程序版本 / 架构 / 当前配置的仓库
  info: () => ipcRenderer.invoke('app:info'),
  // 查 GitHub 上最新的 Release
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  // 手填 GitHub 仓库（用户名/仓库名），存到用户目录，重新打包也不用改这里
  setRepo: (repo) => ipcRenderer.invoke('app:set-repo', repo),
  // 下载安装包，进度经 app:update-progress 回来
  downloadUpdate: (url, name) => ipcRenderer.invoke('app:download-update', url, name),
  // 启动安装包并退出自己
  installUpdate: (file) => ipcRenderer.invoke('app:install-update', file),

  onProgress: (cb) => {
    const h = (e, d) => cb(d)
    ipcRenderer.on('app:update-progress', h)
    return () => ipcRenderer.removeListener('app:update-progress', h)
  },
  onAvailable: (cb) => {
    const h = (e, d) => cb(d)
    ipcRenderer.on('app:update-available', h)
    return () => ipcRenderer.removeListener('app:update-available', h)
  },
})

// statgVision：桌面视觉 sidecar。
// 白名单式暴露——只给这几个固定入口，渲染进程拿不到"任意调 sidecar 方法"的能力。
// 桌面能力默认关闭，先用 enable 打开；关闭时会顺带杀掉 sidecar 进程。
contextBridge.exposeInMainWorld('statgVision', {
  // 这个安装包里到底带没带 sidecar，以及当前开没开
  available: () => ipcRenderer.invoke('vision:available'),
  // 开/关桌面能力。开：拉起 sidecar 并探活；关：杀掉进程
  enable: (on) => ipcRenderer.invoke('vision:enable', on),
  // 探活 + 拿协议版本 / 模型就绪位
  status: () => ipcRenderer.invoke('vision:status'),

  // 调一个方法。method 必须在 build/vision.js 的 ALLOWED 白名单里。
  call: (method, params) => ipcRenderer.invoke('vision:call', method, params),
  // 把 capture 返回的截图读成 data URL，直接塞 <img>
  captureImage: (captureId) => ipcRenderer.invoke('vision:capture_image', captureId),
})
