// 预加载脚本：只暴露极少、明确的东西，渲染进程拿不到 Node 能力。
//
// stataApp 是最早那版（只给版本号和平台），留着不动，防止老代码找不到。
// statgApp 是给「版本与更新」用的：查 GitHub Release、下安装包、装上。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('stataApp', {
  version: '1.2.0',
  platform: process.platform,
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
