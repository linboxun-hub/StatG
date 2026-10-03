# -*- coding: utf-8 -*-
"""内置知识条目 —— 替代原来硬编码的 LIANXH_KNOWLEDGE 字符串常量。

原来那段 60 行的 Python 常量有几个问题：永远不变、和知识库无关、要改得改代码重启。
现在把它拆成一篇篇方法卡片落进「Stata命令速查」库，front-matter 的 commands 字段
列出这一篇覆盖哪些命令，检索时能按命令名命中。

新增或修改内置知识 = 在这里加/改一条，然后在页面上点「重建内置知识」，
  或者直接编辑库里对应的那篇笔记（改笔记优先，因为那不会被下次重建覆盖……
  实际上 ensure_builtins 只补缺失、不改已有，所以手改是安全的）。
"""

BUILTIN_KB = "Stata命令速查"
BUILTIN_ABOUT = ("AI 助手的命令速查底册。原来这是写死在代码里的一段提示词，"
                 "现在拆成可检索的笔记——你改这里的任何一条，AI 的回答立刻跟着变。")

# 每篇：title / commands / tags / body
BUILTINS = [
    {
        "title": "数据操作与载入",
        "commands": ["use", "import", "save", "describe", "list", "codebook",
                     "rename", "tabulate", "merge", "append", "reshape",
                     "collapse", "drop", "keep", "duplicates", "label",
                     "encode", "destring", "contract"],
        "tags": ["数据操作", "基础"],
        "body": """## 载入与保存
- `use "file.dta", clear` — 读入 Stata 数据，clear 清掉内存里原有的
- `import delimited "data.csv", clear` — 导入 CSV
- `save "out.dta", replace` — 保存，replace 覆盖同名文件

## 查看
- `describe` — 变量名、类型、存储方式、标签
- `list in 1/5` — 看前 5 行
- `codebook wage educ` — 单变量详细信息：缺失、唯一值、分位数
- `tab industry region` — 一维/二维频率表；加 `row` 看行百分比，`chi2` 出卡方

## 变形
- `rename educ edu` — 改变量名
- `drop if wage == .` / `keep if year >= 2015` — 筛选观测
- `duplicates report id year` — 报告重复（id+year 组合不唯一时有用）
- `merge m:1 firm_id using firm_info.dta` — 多对一合并；合并后一定看 `_merge`
- `append using survey_2020.csv` — 纵向追加
- `reshape wide wage, i(id) j(year)` / `reshape long` — 长宽转换
- `collapse (mean) avg_wage=wage, by(industry)` — 按组汇总成新数据

## 类型与标签
- `label variable wage "月工资"` — 变量标签
- `encode industry, gen(ind_code)` — 字符转数值编码
- `destring price, replace ignore(",")` — 去千分位逗号后转数值
- `contract industry, freq(n)` — 压缩成频率表

## 常见坑
- `merge` 之后不检查 `_merge` 是数据丢失最常见的原因：1=仅主数据、2=仅被合并数据、
  3=匹配上、4/5 是冲突。大量 1 和 2 说明键没对上。
- `reshape` 之后面板的「期」如果编码方式变了，`xtset` 要重新声明。
- `destring` 不加 `replace` 会生成新变量，原变量不动，容易以为自己转好了。
""",
    },
    {
        "title": "变量生成与数据清洗",
        "commands": ["gen", "replace", "egen", "xtset", "tsset", "xtdes",
                     "isid", "winsor2"],
        "tags": ["数据清洗", "面板"],
        "body": """## 生成与替换
- `gen log_wage = ln(wage)` — 新变量
- `replace wage = 0 if wage == .` — 原地替换；用 `.` 判断缺失
- `gen ratio = x1 / x2` 之前先 `count if x2 == 0`，否则静默出现缺失

## egen 扩展函数
- `egen mean_wage = mean(wage), by(industry)` — 组内均值
- `egen rank = rank(score), unique` — 秩次
- `egen tag = tag(id)` — 每个 id 的第一条观测标 1
- `egen anymiss = rowmiss(x1 x2 x3)` — 行缺失计数

## 面板声明
- `xtset id year` — 面板；`tsset year` — 时间序列
- `xtdes` — 面板结构概览：多少个体、多少期、是否平衡
- `isid id year` — 检查 id×year 是否唯一，不唯一说明有重复或没声明清楚
- 平衡面板做 FE 无需额外处理；非平衡面板 FE 依然有效，但 RE 的效率优势会打折

## 离群值
- `winsor2 wage, cuts(5 95) replace` — 按 5%/95% 分位缩尾（需 ssc install winsor2）
- 缩尾要报告你切在哪个分位；只缩不说明，审稿人会问
- 对数变换本身就能压右尾，未必需要再缩尾

## 常见坑
- `xtset` 之后字符串型 id 会被保留但部分命令不接受，`encode` 成数值更稳
- `egen ... by()` 在缺失值上的行为和 `bysort` + `gen` 不同，跨组比较时要注意
""",
    },
    {
        "title": "OLS 与稳健标准误",
        "commands": ["regress", "areg", "vce"],
        "tags": ["回归", "基础"],
        "body": """## 命令
- `regress y x1 x2` — 普通 OLS
- `regress y x1 x2, vce(robust)` — 异方差稳健（HC1）
- `regress y x1, vce(cluster id)` — 按个体聚类
- `areg y x, absorb(industry)` — 吸收一组固定效应，等价于把这组转成虚拟变量

## 怎么看输出
- 系数下方括号里是标准误，右侧是 t 和 p
- `R-squared` 是拟合优度，横截面数据通常不高，低不代表模型错
- `Root MSE` 是残差标准差，用于反推预测区间
- `F` 检验的是「所有斜率联合为 0」，通过只说明模型整体有解释力

## 标准误怎么选
- 有异方差嫌疑就用 `vce(robust)`；截面数据几乎都该用
- 面板数据或同一观测聚成组（同企业多年度、同省多城市）用 `vce(cluster id)`
- 聚类会放大标准误，显著性下降是正常的，不是模型变差
- 聚类组数少于 40 时要小心，聚类标准误本身不可靠；组数很少时用 wild cluster bootstrap

## 常见坑
- `vce(robust)` 不改变点估计，只改标准误和显著性——报告里写清楚用了哪种
- 省掉常数项 (`nocons`) 会让 R² 变成未中心化的，不可与其他模型比
""",
    },
    {
        "title": "面板固定效应与高维固定效应",
        "commands": ["xtreg", "reghdfe", "xtsum", "xtline", "absorb"],
        "tags": ["面板", "固定效应"],
        "body": """## 命令
- `xtreg y x, fe` — 个体固定效应
- `xtreg y x, fe vce(cluster id)` — FE + 聚类标准误
- `xtreg y x, re` — 随机效应
- `reghdfe y x, absorb(id year)` — 高维固定效应，可同时吸多组且不占内存
- `reghdfe y x, absorb(id year industry) cluster(id)` — 三组 FE + 聚类

## xtreg fe 输出里该看的
- `sigma_u` 个体效应标准差、`sigma_e` 残差标准差、`rho` = sigma_u²/(sigma_u²+sigma_e²)
- `rho` 接近 1 说明个体间差异主导，该用 FE；接近 0 说明组内变异才是主要信息
- `corr(u_i, X)` 若显著异于 0，就是 RE 有偏的证据，该用 FE
- `R-sq within` 才是 FE 的解释力；`overall` 用了组间信息，别拿它说 FE 拟合好

## xtreg re 输出里该看的
- `rho` 同上；`sigma_u` 是随机效应的标准差
- `wald chi2` 替代 F，因为 GLS 没有 F 统计量的标准形式

## 什么时候 absorb 一个变量 vs 放虚拟变量
- 组数少（<20）可以直接 `i.industry`，系数可读
- 组数多（>50）用 `absorb`，否则 Stata 会因虚拟变量太多报错或极慢
- `absorb` 掉的变量没有系数输出，只能从 `estat absorb` 看各固定效应的均值

## 常见坑
- 协变量在个体内恒定（如企业注册地）会被 FE 吸收，报告里看不到它——不是出错
- FE 消除了组间信息，所以 FE 的 R² 通常远低于 OLS，这是预期
- 两个固定效应同时吸收且某一组是另一组子集时会共线，`reghdfe` 会自动处理并报告
""",
    },
    {
        "title": "随机效应与 Hausman 检验",
        "commands": ["hausman", "xtoverid", "xttest0"],
        "tags": ["面板", "检验"],
        "body": """## 流程
```
xtreg y x, fe
estimates store fe
xtreg y x, re
estimates store re
hausman fe re, sigmamore
```

## 怎么读
- H0：随机效应一致且有效。`p < 0.05` 拒绝 H0 → 用 FE
- `p >= 0.05` 不拒绝 → RE 可用，且比 FE 更有效（标准误更小）
- `sigmamore` 选项在「V_fe − V_re 不正定」时仍能算，这是常见情形，别看到警告就以为出错
- 实践中更省事的判据：直接比 FE 和 RE 的系数，差异小就用 RE，差异大就用 FE

## Hausman 失效时怎么办
- 差矩阵奇异（某协变量被 FE 吸收干净，或几乎无组内变异）→ 统计量不可用，改看系数差异
- 聚类数据下要用的版本：先 `xtreg y x, fe vce(cluster id)` 存，再跑 bootstrap Hausman
- `xtoverid` 提供另一种检验，H0 同样是 RE 一致

## 常见坑
- Hausman 检验的是「RE 是否一致」，不是「FE 是否显著」。Hausman 不显著不等于 FE 没意义
- 加了聚类标准误之后，传统 Hausman 的形式前提被破坏，慎用
""",
    },
    {
        "title": "工具变量 IV / 2SLS",
        "commands": ["ivregress", "ivreg2", "estat", "firststage", "overid"],
        "tags": ["内生性", "工具变量"],
        "body": """## 命令
- `ivregress 2sls y x1 x2 (endog = iv1 iv2)` — 两阶段最小二乘
- `ssc install ivreg2` 后 `ivreg2 y x1 (endog = iv1 iv2), first robust` — 诊断更全

## 报告时必须给出的四项
1. **第一阶段强度**：`estat firststage` 的 F，或 ivreg2 的 Cragg-Donald Wald F。
   经验阈值 F > 10；F < 10 说明工具变量弱，2SLS 会向 OLS 严重偏倚
2. **排除性约束**：工具变量不直接影响 Y，只能通过内生变量起作用。这个没法用数据检验，
   只能论证
3. **相关性**：第一阶段系数显著
4. **过度识别**：工具变量多于内生变量时 `estat overid` 的 Sargan/Hansen J 检验。
   拒绝说明至少一个工具变量不满足排除性；通过不代表排除性成立，只是没发现矛盾

## 弱工具变量的两类问题
- 偏差：2SLS 向 OLS 偏，且工具变量越弱偏得越多
- 推断失真：标准误被低估，显著性虚高
- 应对：弱工具时改用 LIML（`ivregress liml`），它弱工具下表现更好；或 Anderson-Rubin 检验

## 常见坑
- 把内生变量的滞后项当工具变量，需要论证它不进当期误差
- 多个工具变量时报告的是「局部平均处理效应（LATE）」，是 complier 子总体的效应，
  不是全样本平均效应——写结论时不能写成「对所有企业的影响」
- 第一阶段 R² 高不等于工具变量强，F 才是判据
""",
    },
    {
        "title": "双重差分与事件研究",
        "commands": ["didregress", "csdid", "did_imputation", "coefplot",
                     "parallel", "eventstudy"],
        "tags": ["因果推断", "DID"],
        "body": """## 静态 DID
- 两期：`didregress (y) (treat), group(firm) time(year)`
- 面板手工版：`reghdfe y treat_post x, absorb(id year) cluster(id)`
  treat_post = treat × post 的交互项，系数就是 DID 估计

## 交错采纳（处理时点不一致）
- `ssc install csdid` 后：`csdid y x, ivar(id) time(year) gvar(first_treat)`
- `did_imputation y id year first_treat x` — BJS 插补法
- **这种情形下双向固定效应不可解释**：它会用早处理单位当晚处理单位的对照，
  权重可能为负。先用 Goodman-Bacon 分解看 forbidden 比较占比，再决定用不用 TWFE
- 常用对照组：`notyet`（尚未处理）或 `never`（从未处理）。两者给的答案通常不同，
  都要报告

## 平行趋势
- 事件研究法看处理前的系数是否联合为 0：
  `didregress (y) (treat), group(firm) time(year)`
  或 `eventstudyinteract y x, cohort(first_treat) control_cohort(never)`
- 处理前的点应该在 0 附近且不显著；有一个很显著不等于 trend 一定不成立，
  但需要在论文里解释
- `coefplot` 画带置信区间的动态路径，比表格直观

## 常见坑
- 把 treat 和 post 的主效应一起放进模型又被两个 FE 吸收，交互项才是 DID 系数
- 预期效应（anticipation）：处理前几期系数就有趋势，说明需要往前推处理时点或控制预期
- 样本选择：处理组和对照组在政策前趋势平行，不代表政策后可比。要报告政策前的
  因变量水平差异
""",
    },
    {
        "title": "断点回归 RDD",
        "commands": ["rdrobust", "rdplot", "rddensity", "rdbwselect"],
        "tags": ["因果推断", "RDD"],
        "body": """## 命令
- `rdrobust y x, c(0)` — 局部线性，自动选带宽
- `rdrobust y x, c(50) p(2) kernel(triangular)` — 指定二次多项式与核
- `rdplot y x, c(0)` — 画图，人眼检查断点
- `rddensity x, c(0)` — 密度检验：驱动变量在断点处是否有堆积

## 必须报告的三件事
1. **带宽**：`rdrobust` 输出里有 MSE 最优带宽。别自己拍一个，除非做敏感性分析
2. **多项式阶数**：1 阶通常够；2 阶在数据弯曲时必需，但边界偏差会变大。1/2 阶都报
3. **密度检验**：`rddensity` 显著 → 说明存在 manipulable 的精确断点，
   RDD 的识别前提被破坏。这是审稿人必问的一项

## 模糊断点
- 处理概率在断点处跳跃但不到 0/1：用 `rdrobust y x, fuzzy(p)`，p 是处理变量
- 模糊 RDD 估计的是 sub-LATE（断点附近那部分人的效应），不是全样本

## 常见坑
- 断点两侧用同一条拟合线 → 一定看不到跳跃。必须分侧拟合
- 带宽外插：把多项式在很宽范围内拟合，会吸收真实跳跃
- 协变量在断点处也应该连续（ McCulloch 检验 / rdplot` 协变量版）：
  如果协变量在断点处跳了，说明分组不是纯粹由驱动变量决定
""",
    },
    {
        "title": "倾向得分匹配与处理效应",
        "commands": ["psmatch2", "teffects", "att"],
        "tags": ["因果推断", "PSM"],
        "body": """## 命令
- `ssc install psmatch2` 后
  `psmatch2 treat x1 x2, outcome(y) neighbor(1) ate` — 1:1 近邻匹配
  `psmatch2 treat x1 x2, outcome(y) logit radius caliper(0.05) ate`
- `teffects ipw (y x1) (treat x1 x2, logit)` — 逆概率加权
- `teffects ipwra (y x1) (treat x1 x2, logit)` — 加权 + 回归调整

## 平衡性检验（匹配的核心）
- `pstest x1 x2, both` — 看匹配前后协变量的标准化偏差
- 判据：匹配后所有标准化偏差 < 10%，最好 < 5%
- 只报 ATT 不报平衡性检验 = 白做。审稿人第一眼看的就是这个

## ATT vs ATE
- `ate` 是全样本平均处理效应；`att` 只针对被处理者
- 大多数政策评估关心 ATT，因为「已经受处理的群体受政策影响多少」更可解释
- 两者差异大说明选择效应强，报告 ATT 时要说明这是被处理者的效应

## 共同支撑（common support）
- `psgraph` 或直方图看两组的得分分布是否重叠
- 重叠区外为空的那些单位应该被剔除，否则是在做外推

## 常见坑
- PSM 依赖「可忽略性」（selection on observables），这个假设无法用数据检验。
  只能说「在控制了这些协变量后，假定处理与潜在结果无关」
- 匹配后仍不平衡 → 换匹配方法（卡尺内 k 近邻、半径匹配、核匹配）或改模型设定，
  不要靠反复试到通过为止
- 顺序：先估计倾向得分，再检查平衡性，匹配后不平衡就重来，最后才看 ATT
""",
    },
    {
        "title": "合成控制法",
        "commands": ["synth", "synth_runner", "placebo"],
        "tags": ["因果推断", "SCM"],
        "body": """## 命令
- `ssc install synth` 后
  `synth gdp_trade gdp gdp_trade, trunit(7) trperiod(2000) keep("synth.dta")`
- 第一个参数是被解释变量名（会同时被当作结果变量名）
- 后面跟的是预测变量（协变量）
- `trunit(7)` 处理组编号，`trperiod(2000)` 处理开始年份

## 必须报的两件事
1. **拟合质量**：政策前合成组与实际处理组的轨迹贴不贴。用 `synth` 输出的
   predictors balance 表 + 政策前路径图
2. **安慰剂检验**：对每个对照单元都跑一遍，看处理组的效应在分布里排第几。
   实际效应大于大部分安慰剂单元才有说服力

## 常见坑
- 供体池（donor pool）太大时，两个单元的权重会接近，合成组失去解释性；
  通常要限定在地理或经济上可比的区域
- 政策前拟合差 → 无论政策后效应多大都不可信。先解决拟合
- 处理组数量多（>5）时合成控制法不适用，改用 DID 或 panel 方法
""",
    },
    {
        "title": "离散选择与受限因变量",
        "commands": ["logit", "probit", "mlogit", "poisson", "tobit",
                     "intreg", "heckman", "nbreg"],
        "tags": ["回归", "非线性"],
        "body": """## 二元
- `logit y x` / `probit y x` — 0/1 因变量
- 报系数意义有限，用 `margins, dydx(x)` 报平均边际效应
- `logit y x, or` — 直接报几率比；logit 系数 × 1.813 大致等于 probit 系数
- 完美预测（某个 x 组合下 y 全为 1）会让 Stata 无限迭代，`drop` 掉那类观测
  或换 `firthlogit`

## 计数
- `poisson count x` — 计数，默认要求均值=方差
- 过度离散先看：`estat gof` 的 Pearson 统计量 / 离散参数，过度离散用 `nbreg count x`

## 多项
- `mlogit occupation edu exp` — 多项选择，需先 `iis`/`i.` 处理类别变量
- IIA 假设（无关选项独立性）通常不成立，用 `mlogtest, hausman` 检验

## 截断/归并/选择
- `tobit y x, ll(0)` — 左侧归并在 0（如研发支出）
- `intreg low high x` — 区间数据（只知道落在哪个区间）
- `heckman y x, select(x2)` — 样本自选择，两步法；同时报 λ（逆米尔斯比）显著性
- heckman 的第二步要报 corrected 系数，不是未修正的 OLS 系数

## 常见坑
- 非线性模型不能用 R² 比较拟合，用 AIC/BIC 或伪 R²（McFadden）
- 聚类标准误：`logit y x, vce(cluster id)`
- 边际效应依赖在哪个取值点上算，`margins, at(x=(10(5)30))` 报曲线比报单点好
""",
    },
    {
        "title": "分位数回归与门槛回归",
        "commands": ["sqreg", "bsqreg", "qreg", "xthreg"],
        "tags": ["回归", "非线性"],
        "body": """## 分位数
- `qreg wage edu exper, quantile(0.25)` — 单分位
- `sqreg wage edu, quantile(0.25 0.5 0.75)` — 多分位，系数间可做差异检验
- 标准误 `bsqreg ... , reps(200)` 或 `qreg ... , vce(bootstrap, reps(200))`
  （渐近标准误在异方差下不可靠）

## 系数在分位间不同说明什么
- OLS 报的是条件均值上的平均效应
- 分位数回归报的是不同位置上的效应。高低分位系数方向相反 = 效应分布高度异质，
  这是 OLS 看不出来的，本身就是论文发现
- 报「高低分位差异检验」的 p 值，否则读者不知道异质是真的还是噪声

## 门槛
- `xthreg y x, rx(gdp) thx(gdp) qx(1 2 3) grid(300) region(20 80)` —
  面板门槛回归，需 `ssc install xthreg`
- 报三重检验：单一门槛、双重门槛、三重门槛是否显著（对应 qx 里的个数）
- 门槛估计值及 95% 置信区间（`xteff`/等价输出）
- 门槛值为 LR 图上的最低点，不是任何一格网格点

## 常见坑
- 分位数回归的被解释变量要连续；0/1 因变量该用 logit 而非 qreg
- 门槛回归的平滑转移（PSTR）与机制转换（RTR）是不同模型，别混用结论
""",
    },
    {
        "title": "模型诊断与设定检验",
        "commands": ["estat", "hettest", "imtest", "vif", "linktest",
                     "skewness", "swilk"],
        "tags": ["检验", "诊断"],
        "body": """## 异方差
- `regress y x` 后 `estat hettest` — Breusch-Pagan，H0：同方差
- `estat imtest, white` — White 检验，形式更一般
- 显著 → 用 `vce(robust)`；不用担心「模型错了」，换标准误即可

## 自相关
- `estat dwatson` — Durbin-Watson，约 2 无自相关，<1 或 >3 要注意
- `estat bgodfrey, lags(1 2)` — Breusch-Godfrey，能处理带滞后项的自相关
- 面板下 `xtserial y x` 更合适（Wooldridge 检验）

## 共线性
- `vif` 后看每个变量的 VIF；> 10 严重，> 5 需注意
- VIF 高不一定致命：共线性只影响单个系数的估计精度，不影响联合预测
- 交互项和它的主效应 VIF 高是正常的，不要因为这个删主效应

## 函数形式
- `linktest` — `_hatsq` 显著 → 设定有误（漏变量、错误函数形式）
- `rvfplot` 残差对拟合值、`predict r, resid` + `kdensity r` 看正态性

## 常见坑
- 诊断检验结果只用来选标准误和调整设定，不要写进「模型很好」的证据里
- 非正态不影响 OLS 一致性，大样本下渐进理论仍然成立；小样本才需在意
""",
    },
    {
        "title": "结果输出与制表",
        "commands": ["esttab", "outreg2", "eststo", "etable", "putexcel",
                     "coefplot"],
        "tags": ["输出", "制表"],
        "body": """## 命令
- `eststo m1: regress y x1` / `estimates store m1` — 存模型
- `esttab m1 m2 m3 using table.rtf, se ar2 star(* 0.1 ** 0.05 *** 0.01)` — Word
- `outreg2 using result.doc, replace se adjr2` — Word
- `etable` — Stata 15+ 内置制表，可交互编辑
- `putexcel set "out.xlsx", replace` + `putexcel A1 = "Var"` — 写 Excel

## 论文表格该有什么
- 每一列一个模型，标清楚用了哪种标准误
- 括号内是标准误（不是 t 值），表注说明聚类层级
- 星号表注写在表格下方：* p<0.1, ** p<0.05, *** p<0.01
- 常数项、N、R²（或 adj R²）、固定效应是否吸收、聚类层级
- 被固定效应吸收的变量不出现，用「固定效应：是」一行说明

## coefplot
- `coefplot m1 m2 m3, drop(_cons) vertical` — 多模型系数森林图
- `keep(Treat_Post)` 只画关心的那个系数，比全画清楚
- 用来展示不同设定下主系数的稳定性，比堆表格直观

## 常见坑
- `esttab` 默认报标准误；报 t 值要 `t`，报 p 要 `p`，别混用
- 模型间样本量不同时要报各自的 N，或者说明为什么不同
""",
    },
    {
        "title": "后估计：边际效应与预测",
        "commands": ["margins", "marginsplot", "predict", "lroc", "estat"],
        "tags": ["后估计"],
        "body": """## 边际效应
- `margins, dydx(x)` — x 的平均边际效应
- `margins, at(x=(10(5)30))` — 在给定取值上算，输出一条曲线
- `margins, dydx(x) at(z=1)` — 边际效应随调节变量变化
- 非线性模型（logit/probit/poisson）报边际效应比报系数有意义得多

## 交互项
- `regress y c.x##c.z` 之后 `margins, dydx(x)` 是 x 在 z 均值处的效应
- `margins, dydx(x) at(z=(10 20 30))` 才能看到调节效应
- `marginsplot` 直接把这条曲线画出来

## 预测
- `predict yhat, xb` — 线性预测
- `predict e, resid` — 残差
- `predict pr*` （logit 之后）— 预测概率，观测多时先 `sort` 再看分布
- `predict sc, score` — 用于 AUC

## 拟合评估
- `lroc` — ROC 曲线，AUC > 0.7 可用，> 0.8 好
- `estat clas` — 混淆矩阵，看敏感度/特异度
- `estat gof` — Hosmer-Lemeshow，分组校准度

## 常见坑
- `margins` 的结果取决于样本，改了样本范围要重跑
- 交互模型只报主效应系数是常见错误，必须配 `margins` 或 `marginsplot`
""",
    },
    {
        "title": "假设检验与组间比较",
        "commands": ["ttest", "ttesti", "prtest", "anova", "oneway", "test",
                     "lincom", "testparm", "sdtest", "ranksum"],
        "tags": ["检验"],
        "body": """## 均值比较
- `ttest wage == 10000` — 单样本，检验均值等于某值
- `ttest wage, by(group)` — 两组比较（默认 Welch，不假设方差齐）
- `ttest wage, by(group) unequal` 与默认等价；不加 `unequal` 用标准 t
- `sdtest wage, by(group)` — 比两组方差是否相等
- `ranksum wage, by(group)` — 非参数（Wilcoxon），分布不正时用

## 方差分析
- `anova wage industry` — 多组是否同均值
- `oneway wage industry, tukey` — 事后两两比较（Tukey HSD）
- 多个 ANOVA 要报告组间平方和占比（eta²）只报 F 和 p 不够

## 线性假设
- `regress y x1 x2` 后：
  - `test x1 = x2` — 两系数是否相等
  - `test x1 = x2 = 0` — 联合显著性
  - `lincom x1 + x2` — 系数线性组合的点估计与区间
- `testparm i.industry` — 一组虚拟变量是否联合显著

## 比例检验
- `prtest y, by(group)` — 两组比例是否相等

## 常见坑
- 多组比较直接两两 t 检验会累积第一类错误，用 ANOVA + Tukey
- `ttest` 默认要求大样本或正态，样本小且不正时用 Welch + Wilcoxon 交叉验证
""",
    },
    {
        "title": "时间序列",
        "commands": ["dfuller", "pperron", "ac", "pac", "corrgram", "var",
                     "irf", "vecrank", "vec", "arima", "wntestq"],
        "tags": ["时间序列"],
        "body": """## 平稳性
- `dfuller gdp, trend lags(4)` — ADF 检验；`trend` 允许带趋势，`lags` 定阶
- `pperron gdp` — Phillips-Perron，对方差自相关稳健
- `dfgls` — GLS 去势的 ADF，小样本更有功效
- 不平稳就先差分再检验，别直接回归

## 自相关
- `ac x, lags(20)` / `pac x, lags(20)` — ACF/PACF
- `corrgram x, lags(12)` — 一屏看完 ACF/PACF + Ljung-Box Q 统计量
- `wntestq x, lags(4)` — Ljung-Box 白噪声检验

## VAR 与协整
- `var gdp infl unemp, lags(1/4)` — 向量自回归，阶数用 `varsoc` 选
- `irf create irf1, set(myirf)` + `irf graph oirf` — 脉冲响应
- `vecrank gdp infl, lags(4)` — 协整秩（Johansen）
- `vec gdp infl, lags(4) rank(1)` — 误差修正模型，rank 来自 vecrank

## ARIMA
- `arima gdp, ar(1 2) ma(1)` — 需先 `tsset`
- 阶数用 ACF/PACF 初判，再用 AIC/BIC 在候选模型间比

## 常见坑
- 伪回归：两个不平稳序列各自显著相关，但不相关。回归前一定做单位根检验
- VAR 的系数不可直接解释，要看 IRF 和方差分解
- 协整关系存在时用 VECM；不存在时对差分后的序列建 VAR
""",
    },
    {
        "title": "交互项、调节与中介",
        "commands": ["regress", "margins", "teffects", "medeff", "sgmediation"],
        "tags": ["调节效应", "中介"],
        "body": """## 交互项
- `regress y c.x##c.z` —— 等同于 `y = b0 + b1*x + b2*z + b3*x*z`
- b1 是 z=0 时 x 的效应，不是「x 的平均效应」
- 中心化（`center x`）后 b1 才接近「z 取均值时 x 的效应」
- 报调节效应必须配 `margins, dydx(x) at(z=...)` + `marginsplot`

## 中介（Baron-Kenny 三步法）
1. `regress y x` — 总效应显著
2. `regress m x` — x 对中介显著
3. `regress y x m` — 中介显著且 x 系数下降（部分中介）或不显著（完全中介）

## 现代中介
- 三步法检验力低、第一类错误率高。用 bootstrap：
  `ssc install sgmediation` 或 `medeff y x m, boot reps(1000)`
- 报间接效应的点估计和 bootstrap 95% 置信区间，不报 Sobel 检验
- 中介变量不能受处理反向影响，否则内生

## 常见坑
- 交互项里连续×连续比连续×虚拟的解读难得多，后者可以直接念作「对子组的效应差」
- 中介模型中自变量和中介变量不能有互为因果的关系，否则结论不可信
- 调节效应和中介效应是两类问题，别在一篇里混着论证
""",
    },
    {
        "title": "模型选择决策树",
        "commands": [],
        "tags": ["决策", "流程"],
        "body": """## 按因变量类型选

**连续（营收、工资、增长率）**
- 截面：OLS → 异方差检验 → 有异方差换 `vce(robust)` → 有内生性上 IV
- 面板：`xtset` → FE vs RE（Hausman）→ 聚类标准误 → 需要动态项用 GMM
- 多水平（企业套城市套省）：`reghdfe` 吸收多层 FE

**二元（是否上市、是否违约）**
- `logit` / `probit`，报 `margins, dydx(*)`
- 样本不平衡时（事件 <10%）要说明，或用 `firthlogit`

**计数（专利数、事故数）**
- `poisson`，先检验过度离散，过度离散用 `nbreg`

**选择过的（仅观测到 y>0 的样本）**
- `tobit`（归并）/ `heckman`（选择）

**有序（评级、满意度等级）**
- `ologit` / `oprobit`，需先检验比例优势假设 `brant`

## 按研究问题选
**政策评估**
- 处理时点一致的两期或面板 → DID（`didregress` 或手工交互项）
- 处理时点不一致 → `csdid` / `did_imputation`，并跑 Bacon 分解看 TWFE 是否可用
- 有明确断点（分数线、收入线）→ RDD，必须报密度检验
- 处理非随机且协变量丰富 → PSM / IPW，必须报平衡性检验
- 单个或极少处理单元 + 大量对照 → 合成控制法

**机制/异质性**
- 想看 X 的效应在不同子样本或不同条件下是否不同 → 交互项 + 分位数回归
- 想分解「X → M → Y」→ 中介，用 bootstrap 不用 Sobel

**预测**
- 不关心系数解释 → LASSO/岭（`lasso`/`ridge`），配合 CV 选惩罚

## 报告红线
1. 用了哪种标准误，必须写
2. 聚类到哪个层级，必须写
3. 固定效应吸收了什么，必须写
4. 被吸收的变量不显示不是 bug
5. 稳健性检验至少换三种设定（不同的控制变量集、不同的标准误、
   不同的样本区间），不是换三个随机种子
""",
    },
]
