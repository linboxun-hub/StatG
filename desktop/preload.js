// 预加载脚本：只暴露极少、明确的东西，渲染进程拿不到 Node 能力。
// 当前版本只需要“版本号”用于“关于”信息；需要更多能力时在这里显式加。
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('stataApp', {
  version: process.versions.electron ? '1.0.0' : '1.0.0',
  platform: process.platform,
})