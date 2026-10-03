# 更新日志

版本号用语义化版本（`主.次.修订`）：主版本=不兼容的大改，次版本=新功能，修订版本=修 bug。
程序里的版本号只有一处来源：`desktop/package.json` 的 `version`，侧边栏底部、设置页、
安装包文件名、.exe 都读它。

## [1.2.0] - 2026-10-04

### 新增
- **安装包自带 Python 运行时**：把一份完整的 Python（解释器 + 全部后端依赖）打进
  安装包的 `resources/python-runtime/`。**用户装完即用，不用另装 Anaconda、
  不用 pip install 任何东西。** 主进程启动后端时优先用它，找不到才退回本机
  Anaconda；`STATA_PYTHON` 仍然排在最前，想强制用自己的 Python 就设它。
- **设置页显示运行环境**：版本卡片下面多一行「后端运行环境」，直接说明当前
  用的是自带运行时还是本机哪个 Python——出问题时不用再猜。
- **后端启动失败的提示能看了**：以前只有一句「请检查 Python 环境」。现在会把
  用的是哪个解释器、自带运行时有没有用上、后端最后报的错一起列出来。

### 修复
- matplotlib 的字体缓存要写用户目录，程序装在 `C:\Program Files` 下会写不进去。
  现在统一指到 `userData\mpl`。
- Python 子进程的 stdio 是管道不是控制台，会按本地代码页（简体中文机器上是
  GBK）编码；遇到生僻字就 `UnicodeEncodeError`。现在固定 `PYTHONIOENCODING=utf-8`。
- **运行时打包脚本的版本号拼接错**：拿 `3.13.9` 去掉点得到 `3139`，而 CPython
  的 `._pth` 用的是「主+次」版本 `313`。写出来的文件名 Python 根本不读，标准库
  都加载不了。现在改成从解出来的文件里直接认 `python*._pth`，不猜。
- **打包脚本被 pip 的警告掀翻**：PowerShell 5.1 会把原生命令写进 stderr 的每
  一行包成 ErrorRecord，而脚本是 `$ErrorActionPreference = 'Stop'`，于是 pip
  一句「script 装好了但不在 PATH 上」的警告就能让脚本中途终止。现在所有原生命
  令统一走一个只认退出码的封装。
- **DoubleML 改成单独装**：它是 `py3-none-any` 的纯 Python 包，Windows 上装得上，
  但依赖太重（plotly 50MB、mypy、optuna、sqlalchemy……70MB 以上），而 DML 只是
  众多分析方法里的一个，所以由脚本的 `-Extras` 单独装，用不到的人不背这份重量。

### 调整
- 依赖锁版本，拆成两份：`backend/requirements.txt` 给开发时用；
  `desktop/build/requirements-runtime.txt` 随安装包走。
- `requirements-runtime.txt` 里的 uvicorn 不带 `[standard]`：那个 extra 会拉
  uvloop，PyPI 上没有 Windows 预编译包，只能找 MSVC 源码编译。
- 运行时默认瘦身：删掉各家包的 `tests/` 目录和编译时带的 `.lib`/`.exp`/`.pdb`
  调试符号，一共省下约 130MB。

### 已知限制
- `__pycache__` 保留没删，占了约 200MB。删了能让安装包小一些，但首次启动要多
  花约 7 秒编译；程序装在 `C:\Program Files` 下那个目录默认只读，意味着每次都
  慢这 7 秒。只打 portable 版可以用 `-NoPyCache` 关掉。
- llvmlite 单独 115MB（numba 的依赖，numba 又是 StatsPAI 声明的依赖）。
  `import statspai` 时它并不加载，但没敢删——删了等于赌 StatsPAI 的哪条代码
  路径会踩到它。

## [1.1.0] - 2026-10-04

### 新增
- **版本号与自动检查更新**：侧边栏底部显示 `StatG v1.1.0`；设置页新增「版本与更新」卡片，
  可填 GitHub 仓库、检查最新 Release、直接下载安装包并安装。启动时后台静默检查一次
  （6 小时内不重复打 GitHub），有新版本会在侧边栏给个「有新版本」的小点。
- **桌面版整体重做**：改成应用外壳布局（侧边栏与顶栏钉死，只有内容区滚动）；
  换成新 logo；产品名统一为 StatG。

### 修复
- 数据清洗 / 代码编辑器页面会被顶破屏、出现两条滚动条（它们本就按 `100vh - 64px` 设计）。

### 调整
- 侧边栏 logo 40px → 52px，启动页 logo 132px → 200px。

## [1.0.0] - 2026-10-03

### 新增
- 首个可用版本：前端 React + Ant Design，后端 FastAPI + StatsPAI。
- 按实证论文流程组织的侧边栏：统计分析 → 基准回归 → 稳健性检验 → 机制检验 → 异质性分析。
- esttab 风格多模型对照表、DID/IV 面板、异质性系数图与分组回归表、中介/调节效应。
- Electron 桌面打包，内置本地后端，双击即用。

[1.2.0]: https://github.com/linboxun-hub/StatG/releases/tag/v1.2.0
[1.1.0]: https://github.com/linboxun-hub/StatG/releases/tag/v1.1.0
