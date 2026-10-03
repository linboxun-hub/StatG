import React, { useState, useRef, useEffect } from 'react'
import { Button, Tooltip } from 'antd'

const STORE_KEY = 'stata_assistant_fab_pos'
const SIZE = 52            // 按钮直径，和原来的 FloatButton 一致
const EDGE = 16            // 拖完之后离视口边缘至少留这么多
const CLICK_SLOP = 6       // 位移小于这个数算点击，超过算拖拽
// 默认位置比原来高一点（bottom 24 → 96）：数据清洗页右下角有
// 「撤销全部 / 导出 CSV」，原来那个位置正好压在它们上面而且挪不开
const DEFAULT_POS = { right: 24, bottom: 96 }

function loadPos() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y }
  } catch { /* localStorage 里的东西不可信，回默认 */ }
  return null
}

function clamp(p) {
  if (!p) return p
  const maxX = Math.max(EDGE, window.innerWidth - SIZE - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - SIZE - EDGE)
  return { x: Math.min(Math.max(p.x, EDGE), maxX), y: Math.min(Math.max(p.y, EDGE), maxY) }
}

/**
 * 可自由拖动的悬浮按钮。
 *
 * 换掉 antd 的 FloatButton——那个是写死右下角的 fixed 容器，没有拖动能力。
 * 这里自己控制位置，几个必须处理的地方：
 *   1. 点击和拖拽要分开：不区分的话每次移动都会被判成 click，一松手就弹出面板
 *   2. 指针捕获：不加的话指针移出按钮就收不到 move 事件，拖动会断
 *   3. 位置存 localStorage：否则翻个页按钮又跳回默认位置
 *   4. 视口 clamp：不然窗口缩小后按钮可能落在屏幕外，只能清缓存才能找回来
 */
export default function DraggableFab({ icon, onClick, tip = '' }) {
  const [pos, setPos] = useState(loadPos)
  const [dragging, setDragging] = useState(false)
  const drag = useRef({ active: false, moved: false, px: 0, py: 0, x: 0, y: 0 })
  const elRef = useRef(null)

  // 窗口变小之后，之前记的坐标可能已经在视口外，夹回来
  useEffect(() => {
    const onResize = () => setPos(p => clamp(p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (e) => {
    if (e.button != null && e.button !== 0) return      // 只响应左键
    const rect = e.currentTarget.getBoundingClientRect()
    const d = drag.current
    d.active = true
    d.moved = false
    d.px = e.clientX
    d.py = e.clientY
    d.x = pos ? pos.x : rect.left
    d.y = pos ? pos.y : rect.top
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 不支持就算了 */ }
    setDragging(true)
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d.active) return
    if (Math.abs(e.clientX - d.px) > CLICK_SLOP || Math.abs(e.clientY - d.py) > CLICK_SLOP) {
      d.moved = true
    }
    setPos(clamp({ x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }))
  }

  const onPointerUp = (e) => {
    const d = drag.current
    if (!d.active) return
    d.active = false
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 同上 */ }
    if (d.moved) {
      setPos(p => {
        if (p) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)) } catch { /* 存不了就算了 */ } }
        return p
      })
    } else {
      onClick && onClick()
    }
  }

  const place = pos
    ? { left: pos.x, top: pos.y }
    : { right: DEFAULT_POS.right, bottom: DEFAULT_POS.bottom }

  return (
    <Tooltip title={tip || 'AI 助手（按住可拖动）'} placement="left">
      <Button
        ref={elRef}
        type="primary"
        shape="circle"
        icon={icon}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: 'fixed',
          ...place,
          width: SIZE,
          height: SIZE,
          fontSize: 22,
          // 低于 antd Drawer 的 1000：抽屉打开时它被遮住，不会浮在遮罩上面
          zIndex: 999,
          boxShadow: '0 6px 16px rgba(99,102,241,.35)',
          cursor: dragging ? 'grabbing' : 'grab',
          // 不然触屏上拖动会变成页面滚动
          touchAction: 'none',
          transition: dragging ? 'none' : 'box-shadow .2s',
        }}
      />
    </Tooltip>
  )
}
