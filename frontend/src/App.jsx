import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import Data from './pages/Data'
import DataClean from './pages/DataClean'
import Analysis from './pages/Analysis'
import Regression from './pages/Regression'
import ChartPage from './pages/ChartPage'
import Mechanism from './pages/Mechanism'
import Output from './pages/Output'
import Help from './pages/Help'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Resources from './pages/Resources'
import Studio from './pages/Studio'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<Home />} />
        <Route path="/data" element={<Data />} />
        <Route path="/editor" element={<DataClean />} />
        <Route path="/analysis" element={<Analysis />} />
        <Route path="/regression" element={<Regression />} />
        <Route path="/mechanism" element={<Mechanism />} />
        <Route path="/chart/:kind" element={<ChartPage />} />
        <Route path="/output" element={<Output />} />
        <Route path="/help" element={<Help />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      {/* 双模块原型：故意放在 Layout 外面。
          它是「一个产品两个模块」的验证页，自己带完整外壳（顶栏 + toggle），
          套在 Layout 里会出现两层侧边栏，反而看不出要演示的效果 */}
      <Route path="/studio" element={<Studio />} />
    </Routes>
  )
}
