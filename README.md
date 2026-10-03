# StatG · 实证数据分析助手

Stata/StatsPAI 的图形化封装：把面板数据清洗、回归前统计描述、基准回归、稳健性检验、
机制检验、异质性分析串成一条实证论文的标准流程，结果可导出 Word / LaTeX / Markdown。

- **网页版**：React + Vite + Ant Design（:5173）+ FastAPI（:8000）
- **桌面版**：Electron 壳子，自带本地后端和一个 `/api` 反向代理，双击即用，不用开终端

## 目录

```
frontend/       React 前端；public/ 放 logo，dist/ 是构建产物
backend/        FastAPI 后端；services/ 是各分析方法
desktop/        Electron 打包；build/ 放图标与启动页；release/ 是打包结果
docs/           帮助文档内容
CHANGELOG.md    版本变更记录
```

## 本地跑起来

```bash
# 后端（:8000）
cd backend && python -m uvicorn main:app --port 8000

# 前端（:5173）
cd frontend && npm install && npm run dev
```

后端依赖：`fastapi uvicorn statsmodels linearmodels doubleml matplotlib pandas numpy`。

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

注意：**后端依赖没有打进安装包**，程序会依次找 `STATA_PYTHON` 环境变量 →
`D:\Anaconda\anaconda\python.exe` → PATH 上的 `python`。发给没装这些依赖的机器，
还得做 PyInstaller 或随包带便携版 Python。

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

# 3. 先把 build.publish 里的 owner 改成你的 GitHub 用户名
cd desktop && npm run dist

# 4. 提交并打 tag（tag 必须是 v<版本>，程序靠它比版本号）
git add -A && git commit -m "release: v1.1.0"
git tag v1.1.0 && git push origin main --tags

# 5. 在 GitHub 上建 Release：选刚push的 tag，标题写 v1.1.0，
#    把 release/StatG Setup 1.1.0.exe 作为 asset 传上去，正文贴 CHANGELOG
```

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

## 换 logo

原始大图 → `frontend/public/logo-icon.png`（侧边栏 52px / 启动页 200px / .ico 共用）：

```bash
powershell -File desktop\build\make_logo.ps1 -Source <你的原图.png> -OutDir frontend\public
powershell -File desktop\build\make_icon.ps1 frontend\public\logo-icon.png desktop\build\icon.ico
```

`make_logo.ps1` 会做三件事：按包围盒裁正方形、按饱和度把像素分流重新上色
（白/紫各一条 alpha 曲线）、把紫圈磨细。默认参数就是当前效果，`-Thin` 调圈粗细。

## 已知问题

- 后端依赖未打包（见上）
- 只有 Windows 安装包；mac 要另配 `mac` target
- 单实例锁：重复双击只开一个窗口，不会起两个后端
