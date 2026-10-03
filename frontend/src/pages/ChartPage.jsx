import React from 'react'
import { useParams } from 'react-router-dom'
import { GraphPanel } from './Graph'

// 每个阶段的图表各是一个独立整页，不再嵌进「带自己左栏」的页面里造成工具套工具。
// 路由 /chart/:kind，kind 决定显示哪一组阶段图表；GraphPanel 自带的一列设置
// 在这里就是本页唯一的设置区，不再和宿主页的控制器并排。
const MAP = {
  descriptive: ['descriptive'],
  trend: ['trend'],
  dml: ['dml'],
  heterogeneity: ['hetero'],
}
export default function ChartPage() {
  const { kind } = useParams()
  return <GraphPanel include={MAP[kind] || ['descriptive']} />
}
