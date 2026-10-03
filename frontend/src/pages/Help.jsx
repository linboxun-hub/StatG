import React, { useState } from 'react'
import { Card, Input, Tag, Collapse, Button, Space, Typography } from 'antd'
import { SearchOutlined, BookOutlined, LinkOutlined } from '@ant-design/icons'

const { Text } = Typography
const { Panel } = Collapse

const COMMANDS = [
  // 数据操作
  { name: 'use', cat: '数据操作', desc: '加载数据集', example: 'use "file.dta", clear' },
  { name: 'save', cat: '数据操作', desc: '保存数据集', example: 'save "output.dta", replace' },
  { name: 'import', cat: '数据操作', desc: '导入CSV/Excel', example: 'import delimited "data.csv", clear' },
  { name: 'describe', cat: '数据操作', desc: '查看变量信息', example: 'describe' },
  { name: 'list', cat: '数据操作', desc: '列出数据', example: 'list in 1/5' },
  { name: 'codebook', cat: '数据操作', desc: '详细变量信息', example: 'codebook wage educ' },
  { name: 'rename', cat: '数据操作', desc: '重命名变量', example: 'rename educ edu' },
  { name: 'tabulate', cat: '数据操作', desc: '频率表/交叉表', example: 'tab industry region' },
  { name: 'merge', cat: '数据操作', desc: '合并数据集', example: 'merge m:1 firm_id using firm_info.dta' },
  { name: 'append', cat: '数据操作', desc: '纵向追加数据', example: 'append using survey_2020.csv' },
  { name: 'reshape', cat: '数据操作', desc: '长宽格式转换', example: 'reshape wide wage, i(id) j(year)' },
  { name: 'collapse', cat: '数据操作', desc: '分组汇总', example: 'collapse (mean) avg_wage=wage, by(industry)' },
  { name: 'drop', cat: '数据操作', desc: '删除变量或观测', example: 'drop if wage == .' },
  { name: 'keep', cat: '数据操作', desc: '保留变量或观测', example: 'keep if year >= 2015' },
  { name: 'duplicates', cat: '数据操作', desc: '重复值处理', example: 'duplicates report id year' },
  { name: 'label', cat: '数据操作', desc: '变量/值标签', example: 'label variable wage "月工资"' },
  { name: 'encode', cat: '数据操作', desc: '字符转数值', example: 'encode industry, gen(ind_code)' },
  { name: 'destring', cat: '数据操作', desc: '字符转数值', example: 'destring price, replace ignore(",")' },
  { name: 'contract', cat: '数据操作', desc: '频率计数表', example: 'contract industry, freq(n_firms)' },
  // 数据清洗
  { name: 'gen', cat: '数据清洗', desc: '生成新变量', example: 'gen log_wage = ln(wage)' },
  { name: 'replace', cat: '数据清洗', desc: '替换变量值', example: 'replace wage = 0 if wage == .' },
  { name: 'egen', cat: '数据清洗', desc: '扩展生成函数', example: 'egen mean_wage = mean(wage), by(industry)' },
  { name: 'xtset', cat: '数据清洗', desc: '声明面板结构', example: 'xtset id year' },
  { name: 'tsset', cat: '数据清洗', desc: '声明时间序列', example: 'tsset year' },
  { name: 'xtdes', cat: '数据清洗', desc: '面板数据概览', example: 'xtdes' },
  { name: 'isid', cat: '数据清洗', desc: '检查唯一标识', example: 'isid id year' },
  { name: 'winsor2', cat: '数据清洗', desc: '缩尾处理', example: 'winsor2 wage, cuts(5 95) replace' },
  // 面板数据
  { name: 'xtsum', cat: '面板数据', desc: '面板描述统计', example: 'xtsum wage educ exp' },
  { name: 'xtreg', cat: '面板数据', desc: '面板回归 FE/RE', example: 'xtreg wage educ exper, fe vce(cluster id)' },
  { name: 'xtline', cat: '面板数据', desc: '个体时间趋势图', example: 'xtline wage' },
  { name: 'xtdpd', cat: '面板数据', desc: '动态面板 差分GMM', example: 'xtdpd wage L.wage educ, dgmmiv(wage)' },
  { name: 'xtabond2', cat: '面板数据', desc: '系统GMM估计', example: 'xtabond2 wage L.wage educ, gmm(L.wage educ)' },
  { name: 'reghdfe', cat: '面板数据', desc: '高维固定效应', example: 'reghdfe wage educ, absorb(id year) cluster(id)' },
  { name: 'xtoverid', cat: '面板数据', desc: '过度识别检验', example: 'xtreg wage educ, re; xtoverid' },
  // 回归分析
  { name: 'regress', cat: '回归分析', desc: 'OLS 线性回归', example: 'regress wage educ exper, vce(robust)' },
  { name: 'areg', cat: '回归分析', desc: '吸收固定效应OLS', example: 'areg wage educ, absorb(industry)' },
  { name: 'ivregress', cat: '回归分析', desc: '工具变量 2SLS', example: 'ivregress 2sls wage educ (educ=nearc2 nearc4)' },
  { name: 'ivreg2', cat: '回归分析', desc: '增强IV诊断', example: 'ivreg2 wage educ (educ=nearc2), first robust' },
  { name: 'tobit', cat: '回归分析', desc: 'Tobit截断模型', example: 'tobit wage edu exp, ll(0)' },
  { name: 'probit', cat: '回归分析', desc: 'Probit模型', example: 'probit employed edu exp' },
  { name: 'logit', cat: '回归分析', desc: 'Logit模型', example: 'logit employed edu exp' },
  { name: 'poisson', cat: '回归分析', desc: '泊松回归', example: 'poisson count edu exp' },
  { name: 'mlogit', cat: '回归分析', desc: '多项Logit', example: 'mlogit occupation edu exp' },
  { name: 'sqreg', cat: '回归分析', desc: '分位数回归', example: 'sqreg wage educ exp, quantile(0.25 0.5 0.75)' },
  { name: 'intreg', cat: '回归分析', desc: '区间回归', example: 'intreg income_low income_high edu exp' },
  { name: 'cnsreg', cat: '回归分析', desc: '约束回归', example: 'cnsreg y x1 x2, c(1: x1+x2=1)' },
  // 因果推断
  { name: 'didregress', cat: '因果推断', desc: '双重差分 两期DID', example: 'didregress (wage) (treat), group(firm) time(year)' },
  { name: 'csdid', cat: '因果推断', desc: '交错DID Callaway-SantAnna', example: 'csdid wage educ, ivar(id) time(year) gvar(first_treat)' },
  { name: 'did_imputation', cat: '因果推断', desc: 'DID插补法 Sun-Abraham', example: 'did_imputation wage id year first_treat educ' },
  { name: 'rdrobust', cat: '因果推断', desc: '断点回归RDD', example: 'rdrobust score running, c(50)' },
  { name: 'rdplot', cat: '因果推断', desc: '断点回归图', example: 'rdplot score running, c(50)' },
  { name: 'rddensity', cat: '因果推断', desc: 'RDD密度操纵检验', example: 'rddensity running, c(50)' },
  { name: 'psmatch2', cat: '因果推断', desc: '倾向得分匹配', example: 'psmatch2 treat edu exp, outcome(wage) ate' },
  { name: 'teffects', cat: '因果推断', desc: '处理效应估计', example: 'teffects ipwra (wage edu) (treat edu exp, logit)' },
  { name: 'synth', cat: '因果推断', desc: '合成控制法', example: 'synth gdp_trade gdp gdp_trade, trunit(7) trperiod(2000)' },
  // 检验
  { name: 'hausman', cat: '检验', desc: '豪斯曼检验 FE vs RE', example: 'hausman fe re' },
  { name: 'estat hettest', cat: '检验', desc: '异方差检验 BP', example: 'regress y x; estat hettest' },
  { name: 'estat imtest', cat: '检验', desc: 'White异方差检验', example: 'regress y x; estat imtest, white' },
  { name: 'estat dwatson', cat: '检验', desc: 'Durbin-Watson自相关', example: 'regress y x; estat dwatson' },
  { name: 'estat bgodfrey', cat: '检验', desc: 'Breusch-Godfrey自相关', example: 'regress y x; estat bgodfrey, lags(1 2)' },
  { name: 'vif', cat: '检验', desc: '多重共线性VIF', example: 'regress y x1 x2 x3; estat vif' },
  { name: 'estat firststage', cat: '检验', desc: '弱工具变量检验', example: 'ivregress 2sls y x (endog=iv); estat firststage' },
  { name: 'estat overid', cat: '检验', desc: '过度识别J检验', example: 'ivregress 2sls y x (endog=iv1 iv2); estat overid' },
  { name: 'ttest', cat: '检验', desc: '单样本T检验', example: 'ttest wage == 10000' },
  { name: 'anova', cat: '检验', desc: '方差分析', example: 'anova wage industry' },
  { name: 'oneway', cat: '检验', desc: '单因素ANOVA多重比较', example: 'oneway wage industry, tukey' },
  { name: 'wtest', cat: '检验', desc: 'Wald线性假设检验', example: 'test educ = exper' },
  { name: 'lincom', cat: '检验', desc: '线性组合估计', example: 'lincom educ + exper' },
  { name: 'testparm', cat: '检验', desc: '联合显著性检验', example: 'testparm i.industry' },
  { name: 'estat sketest', cat: '检验', desc: '正态性检验', example: 'regress y x; estat sketest' },
  { name: 'linktest', cat: '检验', desc: '模型设定检验', example: 'regress y x; linktest' },
  // 绘图
  { name: 'histogram', cat: '绘图', desc: '直方图', example: 'histogram wage, bin(20) kdensity normal' },
  { name: 'scatter', cat: '绘图', desc: '散点图', example: 'scatter wage educ' },
  { name: 'twoway', cat: '绘图', desc: '复合图形', example: 'twoway (scatter wage educ) (lfit wage educ)' },
  { name: 'line', cat: '绘图', desc: '折线图', example: 'line wage year' },
  { name: 'graph bar', cat: '绘图', desc: '柱状图', example: 'graph bar (mean) wage, over(industry)' },
  { name: 'graph box', cat: '绘图', desc: '箱线图', example: 'graph box wage, over(industry)' },
  { name: 'qqplot', cat: '绘图', desc: 'Q-Q正态概率图', example: 'qqplot wage' },
  { name: 'coefplot', cat: '绘图', desc: '系数森林图', example: 'coefplot m1 m2, drop(_cons) vertical' },
  { name: 'marginsplot', cat: '绘图', desc: '边际效应图', example: 'margins, dydx(educ); marginsplot' },
  { name: 'graph combine', cat: '绘图', desc: '合并多个图形', example: 'graph combine g1.gph g2.gph' },
  { name: 'graph export', cat: '绘图', desc: '导出图形', example: 'graph export "fig.png", replace width(1200)' },
  // 输出
  { name: 'esttab', cat: '结果输出', desc: '回归表格输出', example: 'esttab m1 m2 using table.rtf, se ar2 star(* 0.1 ** 0.05 *** 0.01)' },
  { name: 'outreg2', cat: '结果输出', desc: '导出Word/Excel', example: 'outreg2 using result.doc, replace se adjr2' },
  { name: 'eststo', cat: '结果输出', desc: '存储估计结果', example: 'eststo m1: regress wage educ exper' },
  { name: 'estimates', cat: '结果输出', desc: '估计结果管理', example: 'estimates store fe; estimates table fe re' },
  { name: 'etable', cat: '结果输出', desc: '回归表格新命令', example: 'etable: regress wage educ; etable, append: regress wage educ exper' },
  { name: 'putexcel', cat: '结果输出', desc: '写入Excel', example: 'putexcel set "out.xlsx", replace; putexcel A1 = "Var"' },
  // 后估计
  { name: 'margins', cat: '后估计', desc: '边际效应', example: 'regress y c.x1##c.x2; margins, dydx(x1)' },
  { name: 'marginsplot', cat: '后估计', desc: '边际效应图', example: 'margins x1, at(x2=(10(5)30)); marginsplot' },
  { name: 'predict', cat: '后估计', desc: '预测值/残差', example: 'predict y_hat, xb; predict e, resid' },
  { name: 'estat gof', cat: '后估计', desc: 'Logit拟合优度', example: 'logit y x; estat gof' },
  { name: 'lroc', cat: '后估计', desc: 'ROC曲线', example: 'logit y x; lroc' },
  // 时间序列
  { name: 'dfuller', cat: '时间序列', desc: 'ADF单位根检验', example: 'dfuller gdp, trend lags(4)' },
  { name: 'pperron', cat: '时间序列', desc: 'PP单位根检验', example: 'pperron gdp' },
  { name: 'ac', cat: '时间序列', desc: '自相关函数图', example: 'ac gdp, lags(20)' },
  { name: 'pac', cat: '时间序列', desc: '偏自相关函数图', example: 'pac gdp, lags(20)' },
  { name: 'var', cat: '时间序列', desc: '向量自回归VAR', example: 'var gdp infl unemp, lags(1/4)' },
  { name: 'irf', cat: '时间序列', desc: '脉冲响应函数', example: 'irf create irf_results, set(irf) step(10)' },
  { name: 'vecrank', cat: '时间序列', desc: '协整秩检验', example: 'vecrank gdp infl unemp, lags(4)' },
  { name: 'vec', cat: '时间序列', desc: '向量误差修正VECM', example: 'vec gdp infl unemp, rank(1)' },
  { name: 'arima', cat: '时间序列', desc: 'ARIMA模型', example: 'arima gdp, ar(1 2) ma(1)' },
  // 机器学习
  { name: 'lasso', cat: '机器学习', desc: 'Lasso变量选择', example: 'lasso linear wage edu exp, selection(cv)' },
  { name: 'elasticnet', cat: '机器学习', desc: '弹性网络', example: 'elasticnet linear wage edu exp' },
  // 文本处理
  { name: 'split', cat: '文本处理', desc: '拆分字符串', example: 'split name, parse(" ")' },
  { name: 'substr', cat: '文本处理', desc: '子字符串提取', example: 'gen code = substr(id, 1, 3)' },
  { name: 'regexm', cat: '文本处理', desc: '正则匹配', example: 'gen is_email = regexm(contact, "@")' },
]

const CASES = [
  {
    id: 'did', title: '双重差分法 (DID)', desc: '基于面板数据的政策效应识别', icon: '🔬', color: '#6366f1',
    content: `## DID 基本原理
双重差分法通过比较处理组和对照组在政策实施前后的变化差异来识别因果效应。
Y_it = a + b*Treat_i + g*Post_t + d*(Treat_i*Post_t) + e_it，d即DID估计量。

## Stata 命令
gen did = treat * post
regress y treat post did, vce(cluster id)
xtset id year
xtreg y treat post, fe vce(cluster id)

## 平行趋势检验
gen rel_time = year - first_treat
tab rel_time, gen(t_)
regress y did_* i.year, vce(cluster id)
coefplot, drop(_cons) vertical yline(0)

## 交错DID
ssc install csdid
csdid y x1 x2, ivar(id) time(year) gvar(first_treat)
csdid_stats event

## 参考文献
Angrist & Pischke (2009) Mostly Harmless Econometrics
Callaway & Sant'Anna (2021)
连享会推文: https://www.lianxh.cn/blogs/39.html`,
  },
  {
    id: 'rdd', title: '断点回归 (RDD)', desc: '利用分断点识别因果效应', icon: '📐', color: '#f59e0b',
    content: `## RDD 基本原理
断点回归利用某个连续变量超过阈值时处理状态的突变来识别因果效应。

## Sharp RDD
ssc install rdrobust
rdrobust y x, c(0)
rdplot y x, c(0)

## 带宽与密度检验
rdbwselect y x, c(0) kernel(triangular)
ssc install rddensity
rddensity x, c(0)

## 参考文献
Lee & Lemieux (2010)
Cattaneo et al. (2020)
连享会推文: https://www.lianxh.cn/blogs/40.html`,
  },
  {
    id: 'psm', title: '倾向得分匹配 (PSM)', desc: '基于可观测特征的因果推断', icon: '⚖️', color: '#10b981',
    content: `## PSM 基本原理
通过倾向得分将处理组和对照组进行匹配，减少选择偏差。

## Stata 命令
ssc install psmatch2
psmatch2 treat x1 x2 x3, outcome(y) neighbor(1) ate
pstest x1 x2 x3, both graph

## 双重稳健估计
teffects ipwra (y x1 x2) (treat x1 x2, logit)

## 平衡性检验
pstest x1 x2 x3, both graph

## 参考文献
Rosenbaum & Rubin (1983)
连享会推文: https://www.lianxh.cn/blogs/41.html`,
  },
  {
    id: 'iv', title: '工具变量 (IV/2SLS)', desc: '解决内生性问题', icon: '🔧', color: '#8b5cf6',
    content: `## IV 基本原理
当解释变量存在内生性时，使用工具变量进行一致估计。

## 两阶段最小二乘法
ivregress 2sls y x1 (endog_x = iv1 iv2), robust first
estat firststage  // 弱工具变量 F>10
estat overid       // 过度识别

## 增强IV诊断
ssc install ivreg2
ivreg2 y x1 (endog_x = iv1 iv2), first robust

## 参考文献
Angrist & Pischke (2009)
连享会推文: https://www.lianxh.cn/blogs/38.html`,
  },
  {
    id: 'panel', title: '面板数据模型', desc: '固定/随机/高维效应', icon: '📊', color: '#06b6d4',
    content: `## 面板数据建模流程
1. xtset id year
2. xtsum wage educ exp
3. Hausman检验: xtreg y x, fe; store fe; xtreg y x, re; store re; hausman fe re
4. p<0.05选FE, p>0.05选RE
5. 聚类标准误: xtreg y x1 x2, fe vce(cluster id)
6. 高维FE(推荐): reghdfe y x1 x2, absorb(id year) vce(cluster id)
7. 异方差: estat hettest

## 参考文献
Wooldridge (2010)
连享会推文: https://www.lianxh.cn/blogs/20.html`,
  },
  {
    id: 'margins', title: '边际效应与交互项', desc: '调节效应分析', icon: '📈', color: '#ec4899',
    content: `## 交互项与边际效应
Y = b0 + b1*X + b2*Z + b3*X*Z + u
X的边际效应 = b1 + b3*Z (随Z变化)

## Stata 命令
regress y c.x##c.z
margins, dydx(x)
marginsplot

## 分类交互
regress y c.x##i.gender
margins gender, dydx(x)
marginsplot

## 参考文献
连享会推文: https://www.lianxh.cn/news/012d8a6159cf`,
  },
]

const CATEGORIES = ['全部', ...new Set(COMMANDS.map(c => c.cat))]

export default function Help() {
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('全部')

  const filtered = COMMANDS.filter(c => {
    const matchSearch = !search || c.name.includes(search) || c.desc.includes(search)
    const matchCat = activeCat === '全部' || c.cat === activeCat
    return matchSearch && matchCat
  })

  return (
    <div style={{ padding: 32 }}>
      <div style={{ display: 'flex', gap: 24 }}>
        {/* Left sidebar */}
        <div style={{ width: 220, flexShrink: 0 }}>
          <Card title="内容分类" size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {CATEGORIES.map(c => (
                <div key={c} onClick={() => setActiveCat(c)}
                  style={{
                    padding: '8px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                    background: activeCat === c ? '#eef2ff' : 'transparent',
                    color: activeCat === c ? '#4f46e5' : '#475569',
                    fontWeight: activeCat === c ? 600 : 400,
                  }}
                >{c} ({COMMANDS.filter(x => c === '全部' || x.cat === c).length})</div>
              ))}
            </div>
          </Card>

          <Card size="small" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', border: 'none' }}>
            <div style={{ color: '#fff' }}>
              <BookOutlined style={{ fontSize: 20, marginBottom: 8 }} />
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>连享会知识库</div>
              <div style={{ fontSize: 12, opacity: 0.9, lineHeight: 1.5 }}>
                内容来源：中山大学连玉君教授团队<br />
                1000+ 推文 · 50+ 计量专题
              </div>
              <a href="https://www.lianxh.cn" target="_blank" rel="noopener noreferrer"
                style={{ display: 'block', marginTop: 8, padding: '6px 0', background: 'rgba(255,255,255,0.2)',
                  borderRadius: 6, textAlign: 'center', color: '#fff', fontSize: 12, textDecoration: 'none' }}>
                <LinkOutlined /> 访问 lianxh.cn
              </a>
            </div>
          </Card>
        </div>

        {/* Main content */}
        <div style={{ flex: 1 }}>
          <Input
            prefix={<SearchOutlined />} placeholder="搜索命令或关键词..."
            style={{ marginBottom: 20, width: 400 }}
            value={search} onChange={e => setSearch(e.target.value)} allowClear
          />

          {/* 命令速查 */}
          <Card title={`Stata 命令速查 (${filtered.length})`} size="small" style={{ marginBottom: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {filtered.map(c => (
                <div key={c.name}
                  style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, transition: 'border-color 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = '#6366f1'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = '#e2e8f0'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Tag color="blue" style={{ margin: 0, fontFamily: 'monospace', fontSize: 11 }}>{c.name}</Tag>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>{c.cat}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#1e293b', fontWeight: 500, marginBottom: 4 }}>{c.desc}</div>
                  <div style={{ background: '#0f172a', borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace', fontSize: 11, color: '#34d399', whiteSpace: 'pre-wrap' }}>
                    {c.example}
                  </div>
                </div>
              ))}
            </div>
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>没有匹配的命令</div>
            )}
          </Card>

          {/* 实证案例 */}
          <Card title="实证案例教程" size="small">
            <Collapse ghost>
              {CASES.map(c => (
                <Panel key={c.id} header={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: c.color + '15', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{c.icon}</div>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14, color: '#1e293b' }}>{c.title}</div>
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>{c.desc}</div>
                    </div>
                  </div>
                }>
                  <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.8, color: '#334155', whiteSpace: 'pre-wrap', padding: '8px 0' }}>
                    {c.content}
                  </div>
                </Panel>
              ))}
            </Collapse>
          </Card>
        </div>
      </div>
    </div>
  )
}
