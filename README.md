# StatG · 实证数据分析助手

Stata/StatsPAI 的图形化封装：把面板数据清洗、回归前统计描述、基准回归、稳健性检验、
机制检验、异质性分析串成一条实证论文的标准流程，结果可导出 Word / LaTeX / Markdown。

一个 Electron 桌面程序：React + Vite + Ant Design 的界面，FastAPI 后端，自带本地
后端和一个 `/api` 反向代理。双击即用，不用开终端。

## 目录

```
frontend/       React 前端；public/ 放 logo，dist/ 是构建产物
backend/        FastAPI 后端；services/ 是各分析方法
desktop/        Electron 打包；build/ 放图标、启动页和依赖打包脚本
desktop/python-runtime/   打包用的自带 Python 运行时（生成物，不进 git）
knowledge/      程序内置的知识库内容（Stata 命令速查等）
CHANGELOG.md    版本变更记录
```

## 本地跑起来

开发时网页调试用（正式发布的是桌面版）：

```bash
# 后端（:8000）
cd backend && python -m uvicorn main:app --port 8000

# 前端（:5173）
cd frontend && npm install && npm run dev
```

后端依赖：`fastapi uvicorn statsmodels linearmodels doubleml matplotlib pandas numpy`。

```bash
cd backend && pip install -r requirements.txt
```

## 打桌面版安装包

```bash
cd frontend && npm run build          # 前端产物，会被拷进安装包
cd desktop && npm install
npm run dist                          # 产出 release/StatG Setup <版本>.exe
```

产物有两个，内容一样：

| 文件 | 用途 |
|---|---|
| `release/StatG Setup <版本>.exe` | 安装版，给别人装 |
| `release/win-unpacked/StatG.exe` | 免安装，双击即用 |

### 自带 Python 运行时

安装包里现在带了一份完整的 Python：解释器加全部依赖，装在
`resources/python-runtime/`。**别人拿到安装包装完就能用，不用另装 Anaconda、
不用 pip install 任何东西。** 主进程启动后端时优先用它，找不到才退回本机
Anaconda（`STATA_PYTHON` 仍然排在最前，想强制用自己的 Python 就设它）。

重新生成这份运行时：

```bash
cd desktop && npm run runtime         # 等于跑 desktop/build/make_pyruntime.ps1
```

它做的事：下载 CPython 嵌入式发行版（约 11MB，无安装程序、不写注册表、整个
目录原样拷走就能跑）→ 引导 pip → 按
`build/requirements-runtime.txt` 装依赖 → 逐模块 import 验一遍。产物约 750MB，
**已经加进 .gitignore**，所以打包前必须先跑一次，否则 `extraResources` 会报缺
`python-runtime`。

运行时要联网拉 PyPI。国内网络可以在脚本里换 index：

```bash
powershell -File desktop\build\make_pyruntime.ps1 -IndexUrl https://pypi.tuna.tsinghua.edu.cn/simple
```

依赖清单刻意锁了版本，且和 `backend/requirements.txt` 有几处不同，理由都写在
`build/requirements-runtime.txt` 的注释里。**DoubleML 是单独装的**（脚本的
`-Extras`）：它会拖进 plotly、seaborn、optuna、sqlalchemy、mypy 一共 70MB 以上，
而 DML 只是众多分析方法里的一个，不值得让用不到的人也背着。

Windows 上如果 `npm run dist` 卡在下载 electron，是因为 GitHub 连不上，挂镜像：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_BUILDER_CACHE=%CD%\.eb-cache
set ELECTRON_CACHE=%CD%\.electron-cache
```

## 发版流程

版本号只有一处来源：`desktop/package.json` 的 `version`。侧边栏底部、设置页、
安装包文件名都读它。

```bash
# 1. 改版本（语义化：主.次.修订）
#    desktop/package.json 和 frontend/package.json 都改
# 2. 在 CHANGELOG.md 里补一段

cd frontend && npm run build

# 3. 自带 Python 运行时（约 750MB，要联网拉 PyPI）。
#    已经生成过、requirements 没改的话，这一步会自动重打，不想等可以跳过
cd desktop && npm run runtime

# 4. 打包（owner 已在 build.publish 里配成 linboxun-hub）
cd desktop && npm run dist

# 5. 提交并打 tag（tag 必须是 v<版本>，程序靠它比版本号）
git add -A && git commit -m "release: v1.2.0"
git tag v1.2.0 && git push origin main --tags

# 6. 在 GitHub 上建 Release：选刚 push 的 tag，标题写 v1.2.0，
#    把 release/StatG Setup 1.2.0.exe 作为 asset 传上去，正文贴 CHANGELOG
```

仓库地址已经配在 `desktop/package.json` 的 `build.publish` 里
（<https://github.com/linboxun-hub/StatG>），程序默认就去那儿检查更新。

想一条命令直接发布（会自动建 Release 并上传 asset）：

```bash
cd desktop && set GH_TOKEN=<你的token> && npm run publish
```

## 程序怎么检查更新

程序读 GitHub `releases/latest`，拿 `tag_name` 和本地版本号比大小：

- 检测仓库按优先级：设置页填的 → 环境变量 `STATG_REPO` → `desktop/package.json`
  的 `build.publish`
- **不会自动下载、不会偷偷升级**。用户点「下载并安装」才会把安装包拉到他的
  「下载」文件夹，装不装由他定
- Release 里要带 `setup` 或 `安装` 字样的 `.exe`，程序才会认得出安装包

## 已知问题

- 只有 Windows 安装包；mac 要另配 `mac` target
- 安装包里带 Python 运行时，体积从约 110MB 涨到约 350MB
- `__pycache__` 保留没删：那一份是 200MB，但删了首次启动要多花约 7 秒编译，
  而程序装在 `C:\Program Files` 下默认是只读的，意味着每次都慢这 7 秒。
  只打 portable 版的话可以用 `npm run runtime -- -NoPyCache`
- 单实例锁：重复双击只开一个窗口，不会起两个后端
