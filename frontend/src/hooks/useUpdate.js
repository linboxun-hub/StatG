import { useSyncExternalStore } from 'react'
import { updateStore } from '../api/update'

// 订阅 api/update.js 里那个极简 store。
// 侧边栏页脚（显示版本 + 小红点）和设置页（检查/下载/安装）都用它。
export function useUpdate() {
  return useSyncExternalStore(
    (cb) => updateStore.subscribe(cb),
    () => updateStore.get(),
  )
}
