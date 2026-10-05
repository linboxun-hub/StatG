# 把 Nuphus 的视觉/桌面操作栈嵌入 StatG

> 2026-10-04。基于对 `desktop\_nuphus\nuphus-main` 的源码解剖（9 个 agent + 本机实测），
> 并经一轮对抗性核验修正。**本文尚未经编译实证**，唯一原因是本机没有 MSVC（见 §7 M1）。

## 0. 结论先说

**不用"剥"，也不用自己写。视觉栈本身就是一个独立的叶子 crate。**

`src-tauri/crates/desktop-api`，4,222 行，112 个依赖 crate，**闭包里没有任何 C/C++ 编译单元**
（无 `cc`），自带 lib + bin + 3 个 example，Nuphus 自己的 CI 就在单独构建和测试它
（`.github/workflows/ci.yml:72 cargo test -p desktop-api --lib`、`:106-107` 单独 build + run
`macos_runtime_smoke`）。

我之前判断"视觉栈拿不出来、128 个命令全绑 `AppHandle`、得自己造协议"——**那三句只对引擎成立，
而视觉栈根本不在引擎里**。错在我只读了 `src/`（引擎）和 `src-tauri/build.rs`，没读
`src-tauri/crates/desktop-api`。

---

## 1. 为什么是 desktop-api 而不是引擎

| | `src/`（nuphus 引擎） | `src-tauri/crates/desktop-api` |
|---|---|---|
| 依赖闭包 | 402 crate | **112 crate** |
| C/C++ 编译单元 | 有：`libsqlite3-sys`、`onig_sys`、`bzip2-sys`、`lzma-sys`、`zstd-sys` → 都要 `cl.exe` | **无** |
| `cargo check` 是否要 MSVC | 要 | **也要**——见下方勘误 |

> **勘误（2026-10-04 实测）：** 本文初稿写过"闭包里没有 `cc`，所以 `cargo check` 不需要 MSVC"——
> **这是错的**。闭包里确实没有 C/C++ 编译单元，但 `proc-macro2`、`quote`、`winapi`、`num-traits`、
> `serde_core`、`native-tls`、`windows_x86_64_msvc`、`crc32fast` 这些 crate 的 **build script
> 本身就要编译并联接宿主机可执行文件**。实测：不设 MSVC 环境时 `cargo check -p desktop-api`
> 直接 `error: linker link.exe not found`；设了 MSVC 但缺 Windows SDK 时
> `error: linking with link.exe failed: exit code: 1181`（LNK1181: cannot open input file，缺
> `kernel32.lib`）。**所以 M1 的第一道门槛就需要 MSVC + Windows SDK 两者齐备。**
| 能否裁剪 | **不能**：`lib.rs:10-46` 无条件声明 34 个 `pub mod`，`src/Cargo.toml` 一个 `[features]` 段都没有；从 `desktop` 出发的引用闭包覆盖 33/34 个顶层模块、215/224 个 `.rs` | 本来就小 |
| 有无 bin | `src/Cargo.toml` 只有 `[lib]`，**无 `[[bin]]`**；`CONTRIBUTING.md` 提到的 CLI 在仓库里不存在 | **有**，默认 feature 下即可编译 |
| 壳层耦合 | 289 个 Tauri 命令，136 个吃 `State<AppState>`、41 个吃 `AppHandle`，`AppState` 是 30+ 字段巨结构 | 零耦合 |

依赖方向是**反的**：引擎 `src/Cargo.toml:79` 用 path 引入 desktop-api；`src-tauri/Cargo.toml`
全文只在第 38 行注释里提过它的名字。它的 Cargo.toml 只有两处 workspace 引用——
`[lints] workspace = true`（L17）和 `xcap.workspace = true`（L36），而 `xcap = "0.9.7"`
本身来自 crates.io（根 `Cargo.toml:24`）。

**走引擎那条路会强制要求终端用户机器上有 C++ 编译器。** 这是它出局的根本原因，不是工作量。

---

## 2. 能拿到什么，拿不到什么

### 2.1 crate 内已闭环的能力

| 能力 | 入口 |
|---|---|
| 全屏/区域/窗口截图 | `vision::capture::capture(&Target, Scope) -> Result<Frame>`（`vision/capture.rs:117-142`） |
| 跨屏区域截图，正确处理负坐标原点 | `capture_desktop_region`（`capture.rs:337-372`），单测钉住 `intersection((-100,20,200,100),(-1920,0,1920,1080)) == Some((1820,20,100,100,0,0))` |
| 窗口枚举/移动/缩放 | `platform::WindowManager::{find, list_all, window_info, window_move, window_resize}` |
| OCR（PP-OCRv4，带框） | `PaddleOcr::{ocr_with_boxes, ocr_image_with_boxes}`（`vision/paddle_ocr.rs:74,82`） |
| 元素检测（OmniParser YOLO） | `YoloDetector::detect(&Frame)`（`vision/yolo.rs:85`） |
| OCR+YOLO 按 IoU 合并 | `perceive::perceive_image(path) -> PerceiveOutput`（`vision/perceive.rs:133`） |
| 找图（金字塔 + 粗到细） | `Locator::Query::Image` → `find_image`（`vision/locate.rs:64`） |
| 找色 | `Query::Color` → `find_color` / `find_color_with_delta`（`locate.rs:315,364`） |
| 鼠标 | `input::mouse::{move_to, click, right_click, middle_click, scroll, drag, click_at, position}` |
| 键盘/文本 | `input::keyboard::{press, hotkey, validate_keys}`；`input/sendinput.rs send_unicode_text` |
| 剪贴板 | `clipboard::{read_text, write_text, read_file_paths}` |
| 前台激活 | `InputEngine::activate/ensure_active`（`input/mod.rs:211,234-301`，SetForegroundWindow + AttachThreadInput 兜底） |
| 临时文件生命周期 | `utils::cleanup::CleanupQueue` |

### 2.2 拿不到的四条硬边界（产品定位必须照这个写）

1. **UIA/Accessibility 语义树整个在引擎里。** `NativeAction` 12 个动作、UIA→COM Pattern 映射、
   密码控件降权、`RiskClass` 分级与 `LocalPolicy` 授权、300s 审批票据、`AutomationGate` 单槽互斥
   加跨进程 `automation.lock`——全部拿不到。**Phase 1 只有像素路径 + 窗口管理。**
2. **图标没有语义名。** `yolo.rs:193-200` 把所有检出框硬编码成 `ElementKind::Icon`，
   `yolo.rs:161-183` 只读 `[0,0,i]`..`[0,4,i]` 五个数，**类别分布向量从未解析**；本地模型全集只有
   4 个文件，没有任何 caption/Florence 模型。非 UIA 应用 + 纯图标界面 = Agent 无法给自己命名目标。
3. **`Locator::Query::Text` 是死的**（`locate.rs:23-31` 恒返回 `found:false`），
   `VisionEngine::see` 的 `OcrEngine::recognize` 是空壳（`vision/ocr.rs:18-49` 恒返回 `vec![]`），
   `extract_colors` 返回 `Ok(vec![])`。
   → **RPC 层要绕过高层封装，但绕过的范围要说准**：
   - 禁用的是 `VisionEngine::see()` 的 Text/All 分支、`OcrEngine::recognize`、`extract_colors`
   - **允许** `Locator::find_with_fallback` 的 `Query::Image` 和 `Query::Color` 分支——
     `find_image`/`find_color` 都是私有方法，没有别的入口，禁掉它们就得自己重写模板匹配
   - 真正要直接调的低层真函数：`paddle_ocr::*`、`yolo::detect`、`perceive_image`
4. **`http-server` feature 这条路是死的。** `core/mod.rs:337-346` 的 `SessionManager::create`
   只有一行 `// TODO: 根据 spec 解析目标类型`，造出 `Target::Tui{hwnd:0, title:"placeholder"}`。
   走它建会话后 Mouse/Window 操作无意义。**所以连它自带的 HTTP 服务也不要复用。**

---

## 3. 主结构：Rust sidecar + stdio NDJSON

```
desktop/
  vision-runtime/      Rust crate 源码（进 git，不随包）
  vision-assets/       随包二进制源（进 git）：2 DLL + 4 模型，44.6 MB
  vision-dist/         构建产物（gitignore）：statg-vision.exe + 上述二进制
  build/vision.js      新增 ~300 行，被现有 files 自动覆盖
  build/prepare-vision.cjs  新增 ~60 行
```

`package.json` 的 `build.extraResources` 加一行：

```json
{ "from": "vision-dist", "to": "vision-runtime" }
```

安装后落 `resources\vision-runtime\`，与 `python-runtime`、`backend`、`frontend-dist` 完全同构。

### 为什么是 stdio 而不是 HTTP

- `main.js:132-134` 已经在 `spawn(py, ['-m','uvicorn',...])`；`main.js:74-95` 有现成的
  `probeBackend()` 就绪探针；`main.js:97-110` 有 `killTree`。**sidecar 生命周期管理有逐字可抄的先例。**
- HTTP 要多管一个端口。`main.js:158-217` 的静态服务器端口占用时直接 reject 并弹致命对话框——
  不要再引入第三个可能冲突的端口。
- 不开端口 = 没有暴露面。注意一个引用错误：`desktop-api/src/main.rs:12` 绑的是 **127.0.0.1**
  不是 `0.0.0.0`（真正绑 `0.0.0.0` 的是 `src-tauri/src/mobile_server.rs`）。结论不变：只绑回环或干脆不绑。

### 协议

一行一帧，UTF-8，`\n` 分隔：

```
→ {"id":1,"method":"ping","params":{}}
← {"id":1,"ok":true,"result":{"protocol":1,"models_dir":"...","ocr":true,"yolo":true}}
← {"id":2,"ok":false,"error":{"code":"capture_failed","message":"..."}}
```

18 个方法 + `shutdown`：`ping` `monitors` `windows` `window_info` `capture` `perceive` `ocr`
`find_image` `find_color` `activate` `click` `move` `drag` `scroll` `type` `hotkey`
`clipboard_read` `clipboard_write`。约 400 行。

### 三条必须做到的

1. **stdout 只走协议帧。** 新 `main.rs` 从零起就要
   `tracing_subscriber::fmt().with_writer(std::io::stderr)`。
   （注意：带 `tracing_subscriber` 的那个 main 是 `#[cfg(feature="http-server")]` 的，
   我们反正要删掉它，所以这是新代码的硬要求，不是"照抄会踩坑"。）
2. **Windows 上 `ort` 加载失败是 panic 不是 Err。** `ort-2.0.0-rc.12/src/lib.rs:188-198` 在
   `ORT_DYLIB_PATH` 兜底失败时直接 `.expect("Failed to load ONNX Runtime dylib")`，而
   `vision/runtime.rs:12-20` 的 `ensure_onnx_runtime()` 在 Windows 上是空操作。
   新 main.rs 要加 8 行：`ort::init_from(&ort_dll).map_err(...)?.commit()`
   （mac 分支 `runtime.rs:30-32` 就是这个写法），把硬 panic 变成干净的 RPC 错误。
3. **`UiElement`/`Element`/`WindowInfo`/`WindowDetail`/`ElementKind` 都没 derive `Serialize`**
   （`perceive.rs:17`、`vision/mod.rs:122-136`、`platform/mod.rs:427-454` 全是 `#[derive(Debug, Clone)]`）。
   `rpc.rs` 里要写约 60 行 serde 适配层。

### 拉起方式

```js
const exe    = path.join(process.resourcesPath, 'vision-runtime', 'statg-vision.exe')
const dir    = path.join(process.resourcesPath, 'vision-runtime')
const models = path.join(dir, 'models')
vision = spawn(exe, [], {
  cwd: dir, windowsHide: true, stdio: ['pipe','pipe','pipe'],
  env: { ...process.env,
    NUPHUS_MODELS_DIR: models,                          // vision/models.rs:28-36 解析链第 1 优先
    ORT_DYLIB_PATH: path.join(dir, 'onnxruntime.dll'),  // examples/yolo_smoke.rs:51-58 的官方喂法
    RUST_LOG: IS_DEV ? 'desktop_api=debug,info' : 'warn'
  }
})
```

`NUPHUS_MODELS_DIR` 是纯配置复用的关键：模型放哪都不挑，开发态和安装态同一套代码。
`ORT_DYLIB_PATH` 是为了确定性（exe 同目录本来也会被 Windows 加载器找到）。

### 两个必须先设计、不能当薄封装的东西

**模型生命周期（对抗核验抓出的致命遗漏）。** `perceive_image` 每次调用都从磁盘新建三个 ONNX
会话，没有任何跨调用缓存：`perceive.rs:153 let mut ocr = PaddleOcr::new()?`（内部
`paddle_ocr.rs:44-52` 两次 `commit_from_file()`，加载 4.7MB + 10.9MB），
`perceive.rs:168 YoloDetector::new().detect(&frame)`（`yolo.rs:29-33` 的 `Mutex<Option<Session>>`
缓存随实例 drop 一起消失，下次重新加载 12.25MB）。
→ `rpc.rs` 状态里必须放常驻的 `PaddleOcr` / `YoloDetector`，加明确的失效策略
（模型文件 mtime 变化 / `ping` 时显式 reload）。**M2 就要量出单次 vs 缓存后的 perceive 耗时**，
否则 R1 的主要缓解手段「hover → 小区域截图 OCR tooltip」和交互式 UI 都不可用。
注意 `PaddleOcr` 要 `&mut self`、`YoloDetector` 内部持有 `std::sync::Mutex`，两者都不能跨 await 持有。

**目标合成与焦点抢占。** 公有 API 全都要一个 `&mut Target`（`input/mod.rs:171/202/216/222/228`
的 `send_text`/`click`/`drag`/`press`/`hotkey` 全部如此），"无目标的打字/点击"没有入口。
→ `rpc.rs` 要自己合成 Target（用 `GetForegroundWindow` 造 `Target::Tui`）。
行为后果必须写进文档：每次请求新建的 Target 永远不是 verified，于是每个输入 RPC 都会先
`SetForegroundWindow` 并 `sleep(100ms)`（`input/mod.rs:252-256`）——
**每次点击都会把焦点从 StatG 抢走，且基线延迟 100ms**。
→ 加一个"本进程已激活过则跳过"的短期缓存，把 SetForegroundWindow 从每次点击降为每次换目标一次。
另外 `WindowManager::find` 是 `&mut self`（`platform/mod.rs:27`），所以全局互斥不止一个。

---

## 4. 要写多少代码

### Rust 侧

- **原样照抄：18 个文件，4,222 行。** `platform/{mod,windows}.rs` 481 + `clipboard.rs` 128 +
  `utils/{mod,cleanup}.rs` 53 + `vision/{mod,capture,locate,models,ocr,paddle_ocr,perceive,runtime,yolo}.rs`
  2,220 + `input/{mod,mouse,keyboard,sendinput}.rs` 1,340。
  （行数口径没完全统一，实际总量约 4,923；`platform/windows.rs` 里有 3 组与 `platform/mod.rs`
  逐字重复的死代码 `enum_callback`/`search_callback`/`SearchCtx`，拷贝时顺手删掉，省 90 行。）
- **小改约 250 行受影响：** `lib.rs`（删 http-server 三处，剩 ~11 行）、
  `core/mod.rs`（删 5 个 `#[cfg(feature="http-server")]` 块，337 → **215 行**）、
  `Cargo.toml`（删 `http-server`/`http` feature 与 axum/tower/reqwest；`[lints] workspace = true`
  换成内联根 `Cargo.toml:32-39` 那 8 条 clippy allow；`xcap.workspace = true` → `xcap = "0.9.7"`）。
- **新写约 475 行：** `rpc.rs` ~400、`main.rs` ~60 重写、`build.rs` ~15（注入 PerMonitorV2 manifest）。
- **删除约 480 行：** `src/api/mod.rs` 118 + `src/api/http.rs` 269 + core 里的 cfg 块 ~90。

**最终 crate 约 4,900 行，其中约 85% 是 Nuphus 原封不动的代码。** 这正是"不想长期维护自己写的
代码"这个约束的量化答案：你要维护的是约 475 行胶水层和一份升级时的 diff，不是一个视觉栈。

两个一行改动：
1. `ort`（`Cargo.toml:50`）改为 `default-features = false`。它的默认项 `download-binaries`/
   `tls-native` 会白拖进 `ureq → native-tls → schannel` 整条 TLS 栈。安全性有据：
   `ort-sys-2.0.0-rc.12/build/main.rs:23-31` 在 `disable-linking`（`load-dynamic` 会触发）时
   直接 early-return。**M2 验证项，失败就回退，零成本。**
2. 加 `[profile.release]`：`lto=true`、`codegen-units=1`、`strip=true`、`panic="abort"`、
   `opt-level="z"`。根 `Cargo.toml` 没有任何 `[profile]` 段，这是净赚的体积杠杆。

### Electron / 前端侧

| 文件 | 行数 | 内容 |
|---|---|---|
| `build/vision.js` | ~300 | spawn/监督、NDJSON 客户端（id 关联 + 超时）、路径解析、capture 目录、退出清理 |
| `main.js` 增量 | ~40 | require、懒加载 `ensureVision()`、`ipcMain.handle('vision:*')` ×10、`before-quit` 杀进程 |
| `preload.js` 增量 | ~15 | contextBridge 暴露白名单对象（照抄 `preload.js:12-35` 的做法） |
| `build/prepare-vision.cjs` | ~60 | 从 `vision-assets/` + `target/release/` 组装 `vision-dist/`，校验 SHA256 |
| `frontend/src/api/vision.js` | ~80 | IPC 封装 |
| `frontend/src/pages/DesktopVision.jsx` | ~350-500 | 显示器选择、截图 + 元素框叠加、点击元素即打点、操作日志 |
| `frontend/src/App.jsx` + `Layout.jsx` | 各几行 | 加路由 + 菜单项 |
| `.github/workflows/vision.yml` | ~60 | windows-latest 构建 + **前端 vite build** |

**前端工程是 `desktop/` 的兄弟目录 `D:\桌面\大二上\cc园区\frontend`**，`package.json:34` 是
`{ "from": "../frontend/dist", "to": "frontend-dist" }`。所以 CI 必须先 checkout frontend →
`npm ci` → `vite build`，否则 `DesktopVision.jsx` 永远不会进安装包。

**总计新写约 1,400 行，其中 Rust 约 475 行。**

---

## 5. 构建、发布与体积

### 真实基准（已实测，不要再用旧的）

- `_release-1.2.0\StatG Setup 1.2.0.exe` = **346,103,169 B（330.0 MiB）**
- 同目录 `win-unpacked` = 1,190,588,633 B（1135.4 MiB，21,846 文件，含 `python-runtime` 791,040,119 B）
- 真实压缩比 **3.44×**
- （`release\StatG Setup 1.1.0.exe` = 112,974,647 B 是加 extraResources 之前的旧配置，不能用）

### 新增载荷

| 载荷 | 原始 | 压缩后估计 |
|---|---|---|
| `statg-vision.exe` | 8-20 MB（待实测） | ~5-8 MB |
| `onnxruntime.dll` ×2 | 15.96 MiB | ~8 MB |
| 4 个 ONNX/TXT 模型 | 26.59 MiB | ~23-25 MB |
| **合计** | **~45-55 MB** | **~36-41 MB** |

ONNX 权重是高熵浮点，可压缩性比平均值差很多，单独按 ~1.1× 估。**M4 以实测结算。**

### 模型与 DLL 进 git，不走 CI 下载

四个模型共 27,880,507 B（det 4,745,517 + rec 10,857,958 + keys 26,250 + YOLO 12,250,782），
两个 DLL 共 16,731,136 B（`_nuphus\nuphus-main\src-tauri\desktop\sherpa\onnxruntime.dll`
16,720,384 + 同目录 `onnxruntime_providers_shared.dll` 10,752）。
合计 **+44.6 MB 进 `desktop/vision-assets/`**，换完全离线的可复现构建。

为什么不照抄 Nuphus 的下载逻辑：`src-tauri/build.rs` 里所有模型下载失败只 `cargo:warning`
不中断构建（`:594-595`、`:790-794`），照抄它会得到一个"构建成功但运行时缺模型"的静默故障。
而且 nuget 那个 URL 本机实测已 404，github.com 的具体 release 地址也不通——
**幸好都不需要，DLL 和模型在本机都已就位。**

`ping` 的返回值带 `models_dir` / `ocr` / `yolo` 三个字段，让"模型没到位"在启动时就是显式错误。

### MSVC 只影响开发者，但要满足一个前提

**前提：exe 不依赖外部 VC 运行时。** 两条路任选：

1. **`-C target-feature=+crt-static`（推荐）**：静态链进 exe，`dumpbin /dependents` 里不会出现
   `VCRUNTIME140.dll`。一个 flag，零文件。
2. **应用本地部署**：把 VC 运行时 DLL 拷到 exe 同目录。StatG **已经自带**——
   `python-runtime\vcruntime140.dll` 和 `vcruntime140_1.dll` 就在运行时根目录，
   `msvcp140.dll` 在 `site-packages\sklearn\.libs\` 下。

**终端用户不需要 Rust、不需要 MSVC、连 VC++ Redistributable 都不需要。** 开发者需要 MSVC；
CI 的 `windows-latest` 自带。

### 自动更新

StatG 的更新是 `main.js:303-335 downloadUpdate()` 下载整个 Setup.exe → `spawn(detached)` →
`app.quit()`，安装程序整体覆盖。**所以 sidecar 永远和 Electron 主程序同版本，不存在单文件版本偏移**，
不需要为它设计任何更新机制。`ping` 里的 `protocol` 版本号只作启动时一次断言。

### 第三方合规

`desktop-api` 是 Apache-2.0（其 `Cargo.toml:5`，`repository = "https://github.com/mrpulor-gh/nuphus"`）。
`vision-runtime/` 要带 LICENSE 和出处声明。

---

## 6. 风险清单

| # | 严重度 | 风险 | 缓解 |
|---|---|---|---|
| R1 | 高 | 纯图标/无文字控件无法命名——这是功能天花板 | Phase 1 产品定位写明"依赖可见文字或用户指定坐标"；采用 Nuphus 自己固化的绕路（`plugin/skills/builtin/agent-orchestration/SKILL.md:191-195`：hover → 小区域截图 OCR tooltip → 仍不懂则让用户框选）；远期补 `yolo.rs:161-183` 的类别向量解析（约 40 行）+ 换带类别的检测模型 |
| R2 | 高 | 没有 UIA 语义操作，只能像素路径；对 Office/设置面板/WPF 脆得多 | Phase 1 只承诺像素 + 窗口管理；Phase 2 若要做，成本是"引擎 4 个耦合点手术"（`src/desktop/vision_ocr.rs:12-13`、`src/desktop/targets.rs:98`、`src/desktop/targets/registered.rs:10`、`src/desktop_automation/jev.rs:2`）。**不要在 Python 侧重写一套 UIA** |
| R3 | 高 | 本机今天无法编译验证任何 Rust 目标（`link.exe`/`cl.exe` 均 NOT FOUND）。所有"112 crate 闭包""无 cc"都是静态推导 | 就是 M1 这一道门 |
| R4 | 中高 | onnxruntime.dll 与模型不会自动就位（下载逻辑 100% 在 `src-tauri/build.rs`，独立编译 desktop-api 时一步都不执行） | 随包 + `NUPHUS_MODELS_DIR` + `ORT_DYLIB_PATH` + `ping` 显式报缺 |
| R5 | 中高 | **Windows only**。`platform` 模块整体 `#[cfg(windows)]`（`lib.rs:11-12`） | 文档与 UI 写明"Phase 1 仅 Windows"，`ping` 返回 platform 字段供前端禁用入口 |
| R6 | 中 | **DPI 与多显示器，且比想象的严重** | 见下方专条 |
| R7 | 中 | sidecar 崩溃或卡死 | 单请求 15s 超时；`ping` 健康检查（照抄 `probeBackend()`）；`exit` 自动重启一次；连续失败转"桌面能力不可用"UI 态 |
| R8 | 中 | 一个能全局点击、全局打字的 exe 是真实攻击面 | 只走 stdio；只在 main 进程调用；**默认关闭、用户显式开启**（语义照抄 Nuphus 的 `system_automation` 默认 false，代码不抄，约 20 行）；sidecar 不存 API key、不读配置文件；执行写操作前弹一次确认 |
| R9 | 中低 | 杀毒误报 | 复用 StatG 现有代码签名流程给这个 exe 签名 |
| R10 | 中低 | 目标应用权限更高时截不到也点不到（UIPI） | 这是明确错误不是模糊失败，`DesktopError` 的变体天然给了稳定分类（`TargetNotFound`/`ActivationFailed`/`CaptureFailed`/`OcrFailed`/`InputFailed`/`LocateFailed`）；文档说明"需与目标应用同权限运行" |
| R11 | 低 | 构建不可复现 | 提交 `Cargo.lock` + `rust-toolchain.toml` + 二进制，`cargo build --release --locked --offline` |
| R12 | 低 | Nuphus 手写 BMP 逐像素的已知瑕疵（`src/desktop/client.rs:365-373,519-618`，远程视觉路径还要 BMP→PNG） | RPC 层直接用 `image` crate（已是依赖）从 `Frame.pixels`（RGBA 裸缓冲，`core/mod.rs:163-171`）编码 PNG，绕开整个弯路，约 15 行 |

### R6 专条：DPI 与显示器原点

**PerMonitorV2 manifest 不是"小胜利"，是前置条件。** 理由：

- xcap 0.9.7 的 `[features]` 里**没有任何 default**（只有 `image` 和 `wgc`，都不默认开），
  而 desktop-api 用 `xcap.workspace = true` 不带特性 → `capture_window` 落到 **GDI 后端**
  （`platform/windows.rs:98-103 detect_gfx_backend` 对未知类名一律返回 `GfxBackend::Gdi`）。
- 在 `gdi.rs` 里，裁剪偏移 `x` 是拿 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 的
  **物理**原点去减 `GetWindowRect` 的 **DPI 虚拟化**原点——两个坐标系相减
  （`gdi.rs:212-213 x = (window_bounds.left - window_rect.left) * scale_factor`）。
- `x` 可能为负 → `x as u32` 变成 ~4.29e9 → `image` 的 `crop_dimms` 是 clamp 不是 assert →
  **release 下静默产出错图**，debug 下算术下溢 panic。
- 而 manifest 本身会改变 xcap 自己的行为分支（`capture.rs:92-101` 按 `GetCurrentProcess()` 的
  DPI awareness 决定 `scale_factor` 取 1.0 还是 `monitor.scale_factor()`），所以它是行为开关，
  必须先测再决定，不是一个纯赚的 15 行。

另外两条已知短板：

- **全屏截图只抓主显示器**（`capture.rs:145-166`、`scope_geometry` 的 Fullscreen 分支 `:56-68`）。
  → `capture` 支持 `scope:"all"`：用 `xcap::Monitor::all()` 求并集矩形后调 `capture_desktop_region`，
  纯复用现成函数，约 30 行。
- **`capture_fullscreen` 丢掉主屏原点**：它用 `Monitor::all().find(is_primary)` 抓主屏，却把
  `Frame.scope` 写成 `Scope::Fullscreen`（`capture.rs:145-150,165`），主屏的 x/y（可能不是 (0,0)）
  就此消失。只有 `capture_desktop_region` 会写成 `Scope::Element{x,y,w,h}`（`:367-371`）。
  → **`capture` 响应必须显式带 `desk_origin{x,y}`**，否则主显示器不在 (0,0) 的机器上点击会整体偏移。
  125% DPI 断言完全测不到这件事。

还有一条要改的：`CleanupQueue` 的"100MB LRU"不存在。`utils/cleanup.rs:62-65` 的 `calc_size`
返回 `pending.len() * 500 * 1024`，一句"假设平均 500KB"。我们的载荷是全屏/跨屏 PNG（每张数 MB），
所以这个上限在真实数据下形同虚设。改成 `fs::metadata().len()` 累加（约 10 行），
或者 sidecar 自己按 capture_id 建表、关闭 capture 时立即删。删除只在 30 秒 tick 上发生，
所以"5 分钟 TTL"实际是 5~5.5 分钟。

---

## 7. 五道门

### M1 — 工具链与"原样能跑"（第 1-2 天）

> **2026-10-04 状态：M1 已完整通过（go/no-go 门放行）。** 开发机已装好
> Visual Studio 生成工具 2022 (17.14.14)：MSVC 14.44.35207 在
> `D:\VS\2022\BuildTools\VC\Tools\MSVC\`，Windows 11 SDK 10.0.26100 在
> `C:\Program Files (x86)\Windows Kits\10\`。
> - `cargo check -p desktop-api --offline` 退出码 0，且经 `cargo clean -p winapi`
>   强制重编后复验通过（不是缓存）。
> - `perceive_smoke` 冒烟：**[PASS]**，`elements=69 ocr=35 yolo=42 yolo_available=true`，
>   截图 1920x1200，检出的元素带真实文字与 kind（Text / Input / Both）。
>   → **截图 → OCR → YOLO → IoU 合并 → 结构化元素列表，全链路在本机实证可用。**

1. 开发机装 Visual Studio Build Tools 2022，「使用 C++ 的桌面开发」工作负载。
2. 在**原 workspace** 里验证（这是唯一能坐实"112 crate 闭包"的方式）。

**注意：`link.exe` 不在 PATH 上，直接跑 cargo 会 `linker link.exe not found`。**
必须先 `vcvars64.bat`（或在开始菜单的 "Developer Command Prompt for VS 2022" 里跑）：

```powershell
Set-Location 'D:\桌面\大二上\cc园区\desktop\_nuphus\nuphus-main'
cmd /c '"D:\VS\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul && cargo check -p desktop-api --offline'
```

（cwd 必须在 `_nuphus\nuphus-main`，`rust-toolchain.toml` 在那里，rustup 靠 cwd 选工具链。）

3. 跑冒烟程序。**注意：`perceive_smoke` 不读 `NUPHUS_MODELS_DIR` 作为 OCR 模型来源，
   而且会在启动时把它整个覆盖掉。** 它读的是 `PS_SMOKE_OCR`
   （`examples/perceive_smoke.rs:29`），另外还必须存在 `%TEMP%\yolo_smoke\community_icon_detect.onnx`
   （`:38-41` 缺失就 `exit(2)`），然后 `:61` 才 `set_var("NUPHUS_MODELS_DIR", ...)`。
   本机 `src-tauri\desktop\models\` 只有一个 768 字节的 README，`%TEMP%\yolo_smoke` 不存在。
   所以正确写法是：

```powershell
$env:PS_SMOKE_OCR = "$env:APPDATA\Nuphus\models"
New-Item -ItemType Directory -Force "$env:TEMP\yolo_smoke" | Out-Null
Copy-Item "$env:APPDATA\Nuphus\models\icon_detect.onnx" "$env:TEMP\yolo_smoke\community_icon_detect.onnx"
cargo run -p desktop-api --example perceive_smoke --offline
```

4. **量一次 perceive 的墙钟耗时**，拆成 det 加载 / rec 加载 / YOLO 加载 / 推理四段。
   若单次 >300ms，`rpc.rs` 必须先有会话缓存再谈 18 个方法。

**门槛（go/no-go）**：`cargo check` 退出码 0；`perceive_smoke` 打印的 `ocr_count`/`yolo_count` 都 >0。
产出物：`docs/vision/m1-evidence.txt`（命令输出 + `cargo tree` 计数 + 元素清单 + perceive 四段计时）。
**这一步失败就意味着 MSVC 装不上，方案要重新评估，不要往下走。**

### M2 — 裁剪成独立 crate（第 3-4 天）

建 `desktop/vision-runtime/`，拷 18 个文件；删 `src/api/` 与 http-server feature；
`Cargo.toml` 去 workspace 耦合、内联 8 条 clippy allow、加 `[profile.release]`；
加 `rust-toolchain.toml`（1.95.0）；加 Apache-2.0 LICENSE 与出处声明；
`platform/windows.rs` 里那 3 组重复回调顺手删掉。`ort` 试 `default-features = false`。
**PerMonitorV2 manifest 在这里作为硬门槛做掉**，然后写 `build/prepare-vision.cjs` 和
`desktop/vision-assets/`。

**门槛**：`cargo build --release --offline` 出 exe，**记录实际字节数**；
`cargo test --release` 全绿；`cargo tree` 的 crate 数比 M1 下降且不含
`ureq`/`native-tls`/`schannel`/`cc`；
`dumpbin /dependents statg-vision.exe` 不含 `VCRUNTIME140.dll`（否则走应用本地部署兜底）；
**同一次 xcap 截窗口，有 manifest 与无 manifest 的输出差异要记录下来**。

### M3 — RPC 层与端到端打点（第 5-9 天）

写 `rpc.rs` + 重写 `main.rs`（含常驻模型实例、foreground Target 合成与激活缓存）。
然后 `build/drive.js`（约 120 行 Node 脚本，spawn exe、往 stdin 写 NDJSON、逐行 parse stdout）跑：

```
ping → windows（找记事本）→ window_info → activate →
type "hello from statg" → capture(scope:"primary") → perceive →
断言 OCR 结果包含 "hello" → 按某元素 rect.center() click → 再次 perceive
```

**门槛，四条断言全过才算过：**

1. `hello from statg` 出现在记事本里（产物：截图 PNG）
2. `perceive` 返回的 elements 里有 `text == "hello from statg"` 且 rect 合理（产物：`m3-perceive.json`）
3. **stdout 每一行都能 `JSON.parse`**（证明 tracing 没污染协议流）
4. **125% 显示缩放下重跑 1-3，落点仍正确**；并加一条「主显示器不在 (0,0)」的用例
   （这是 R6 的实测而非假设；125% 断言测不到显示器原点偏移）

### M4 — 打包与净环境（第 10-12 天）

`package.json` 加 extraResources 那一行；写 `build/vision.js` + `main.js`/`preload.js` 增量；
前端加页面 + 路由 + 菜单项。`npm run dist`，然后用当前配置量出真实数字：
安装包字节数（对照 346,103,169 B）、`win-unpacked` 字节数、`resources\vision-runtime\` 是否含
1 exe + 2 DLL + 4 模型。净环境验证：在一台没有 Rust、没有 MSVC 的机器上装这个包，跑 M3 同一条链。

### M5 — 决策与文档（第 13-14 天）

`docs/vision-sidecar.md`：架构、协议、已知边界（R1/R2 写最前面）、如何构建、
如何升级 vendored crate（diff 上游 desktop-api 的固定 commit）。
用 M2/M4 的实测数字替换本文所有估算。

**Phase 2 go/no-go**：基于 M3 的实际感知质量决定是否值得为 UIA 语义栈付"引擎 4 个耦合点手术"的代价。
建议标准——如果 M3 的 demo 在真实目标软件上靠 OCR + 元素框就能完成想要的 80% 操作，
Phase 2 不做，把精力投到 R1（图标语义）；如果大量目标是无文字控件，Phase 2 优先级高于一切。

---

## 8. 明确反对的路径

1. **复用那 289 个 Tauri 命令**（README 写的"约 177 个"已过期）。136 个吃 `State<AppState>`、
   41 个吃 `AppHandle`，`AppState` 是 30+ 字段巨结构，截图链 14 条命令靠 Tauri 具名窗口 +
   进程级 static（`commands/toolbar.rs:14-25` 的四个 static、`overlay.eval()`、`PRE_SCREENSHOT`）。
   搬它 = 搬整个应用。
2. **把整个引擎编成 sidecar。** 402 crate，强制终端用户有 C++ 编译器，且没法裁剪
   （`lib.rs:10-46` 无条件声明 34 个 mod、无 `[features]`）。
3. **在 Python/FastAPI 侧重写视觉栈。** 这就是"自己从零写、自己长期维护"，而且会把
   ONNX 加载、坐标空间、截图劈成 Rust/Python 两份互相对齐。**后端保持做统计，不要碰桌面。**
4. **Node 原生自动化库（nut-js / robotjs）。** robotjs 已停更；nut-js 依赖 node-gyp 构建原生模块，
   感知层还得自己写。同样违反约束。
5. **napi-rs 做成 in-process `.node` 扩展。** 引入 napi 构建链和 Electron ABI 版本耦合；
   onnxruntime 与 Electron 同进程；sidecar 一次 panic 带走整个应用（stdio 模式下只是子进程退出）。
   StatG 已经是"主进程 + 独立 Python 子进程"模型，没必要改。
6. **把 Nuphus 的 Tauri 应用一起发给用户。** 等于给用户装第二个产品，而且它的 HTTP 接口是死代码。
7. **为了体积把模型改成首启下载。** 唯一能省的是压缩后约 25 MB，代价是把
   `src-tauri/src/models/bootstrap.rs:1-118` 那套 MIRRORS + `min_size` 反投毒 + 失败降级逻辑
   抄过来长期维护，外加一个首启无网络的失败态。相对整个安装包是小数点后的数字，换不来任何东西。
8. **用 MCP 包一层。** MCP over stdio 本质和我们的 NDJSON 是同一种东西，只是没有收益的间接层。
   将来要接 LLM 工具调用时，在 NDJSON 分派器外面套一个 MCP server 是几十行的事。
9. **sidecar 绑 0.0.0.0 好让 Python 后端也能调。** 真要让 Python 调桌面能力，正确做法是
   Python → HTTP → Electron 主进程 → stdio → sidecar，让主进程做唯一守门人。

---

## 9. 一句话

视觉栈不需要"剥"也不需要"写"——它已经是 `desktop-api` 这个 4,222 行、112 crate、
无任何 C/C++ 编译单元的叶子 crate；StatG 的 `main.js:132-134` 有逐字可抄的"拉起本地子进程 +
探活 + 失败弹诊断"先例，`package.json:33-37` 有逐字可抄的"随包发二进制资源"先例。
真正要写的只有约 1,400 行（Rust 475 行），真正要装的只有开发者机器上的 MSVC，
真正要多占的是安装包里约 40 MB。
**唯一能让这事推迟的是 M1 那一个门槛：开发机上没有 `link.exe`。**

---

## 10. 实测结论（2026-10-04，M1–M3 已完成）

从这里往下全部是**实测数字**，不是估算。方案 5/6/7 节里的估算以本节为准。

### 10.1 M1 已通过

- Visual Studio 生成工具 2022 (17.14.14) 装好：MSVC 14.44.35207 在
  `D:\VS\2022\BuildTools\VC\Tools\MSVC\`，Windows 11 SDK 10.0.26100 在
  `C:\Program Files (x86)\Windows Kits\10\`
- `cargo check -p desktop-api --offline` 退出码 0（经 `cargo clean -p winapi` 强制重编复验）
- `perceive_smoke` 冒烟：**[PASS]**，`elements=69 ocr=35 yolo=42 yolo_available=true`

### 10.2 M2 已通过

| 项 | 实测 |
|---|---|
| release 构建 | 退出码 0 |
| `statg-vision.exe` | **2,089,984 字节（1.99 MB）**（带 crt-static；不带是 1.88 MB）——原估 8–20 MB，实际小 4–10 倍 |
| `cargo test --release` | **24 passed / 0 failed** |
| VC 运行时依赖 | `dumpbin /dependents` 里 **没有任何 VC 运行时 DLL**（crt-static 生效） |
| 依赖闭包 | **135 个 crate**；不含 `cc` / `ureq` / `native-tls` / `schannel` / `libsqlite3-sys` / `onig_sys` / `bzip2-sys` / `zstd-sys` |
| PerMonitorV2 manifest | 二进制内确认 `PerMonitorV2` / `dpiAwareness` / `StatG.VisionSidecar` 均在位 |
| `vision-dist` 合计 | **44.54 MB**（exe 1.99 + 2 DLL 16.0 + 4 模型 26.59） |

### 10.3 M3 已通过（15/15 + 集成测试 11/11）

`build/drive.js` 15 条、`build/test-integration.js` 11 条（后者走 `build/vision.js`
即 Electron 实际那一层，可在不启动 Electron 的前提下跑，适合进 CI）。

关键实测值：

| 操作 | 耗时 |
|---|---|
| `capture`（全屏 1920x1200） | 320–485 ms |
| `perceive`（全屏，det+rec+YOLO） | **4,600–4,900 ms** |
| `type` / `hotkey`（输入类） | 58–64 ms |
| `activate` 后同窗口连续输入 | 仍 ~60 ms（激活缓存生效，不再反复 `SetForegroundWindow` + sleep 100ms） |

模型会话常驻**已用 stderr 计数证实**：N 次 `perceive` 只出现 1 行 `[yolo] 加载 ONNX 模型`。

### 10.4 OCR 的真实能力边界（对产品定位有直接影响）

这是本节最重要的一条。用记事本做的输入回读实验：

```
输入：你好，StatG工作台
OCR ：你好.StatGT作台   /  你好、StafG工作台     ← 同一行文字被检出两次（标题栏 + 正文）
输入：hello from statg
OCR ：helofromstataab   /  helofromsta           ← 空格被吃掉，拉丁字形误识
```

结论，逐条：

1. **中文可用，但不是逐字可靠。** `你好` 完全正确；`工作台` 在两次检出中各对一次
   （另一次 `工`→`T`）。
2. **拉丁文在 ~8px 字高下不可用。** 空格被 PP-OCRv4 全部吃掉（`hello from statg` →
   `helofromsta`），个别字母误识。测试里文字的 rect 高度只有 8px，远低于 PP-OCRv4
   训练时期望的 32–48px——在这个尺寸下它能读对七八成已经超出预期。
   **产品上要么要求目标文字有合理字号，要么让用户框选后放大再识别。**
3. **中文菜单/按钮识别良好**：`文件` / `编辑` / `查看` / `纯文本` / `100%` 都对，
   偶有 `查看`→`香看`、`字符`→`学符` 这类形近误识。
4. **IoU 合并在起作用**：`kind=button source=both` 的元素（OCR 与 YOLO 都认到）确实出现，
   记事本窗口一次稳定出现 1–2 个。

→ **Phase 1 的产品宣传必须照这个写**：不要卖"全自动桌面 Agent"，要写"依赖可见文字、
中文为主、允许用户框选指定目标"。

### 10.5 踩到并已修的三处坑（升级时仍会遇到）

1. **`ort` 不能用 `default-features = false`。** default 里含 `api-24`，少了它 ort-sys
   生成的绑定变少，`ort/src/ep/vitis.rs` 会引用不存在的
   `SessionOptionsAppendExecutionProvider_VitisAI` 而编译失败。
   正确写法是显式列举：
   `default-features = false, features = ["load-dynamic", "ndarray", "tracing", "copy-dylibs", "api-24"]`
   ——这样仍然去掉了 `download-binaries` / `tls-native`，闭包里无 `ureq` / `native-tls` / `schannel`。
2. **`CleanupQueue::new()` 必须在 Tokio runtime context 里调用。** 它内部会 spawn 后台清理任务；
   在 `main()` 里先构造 `RpcState` 会 panic：
   `there is no reactor running, must be called from the context of a Tokio 1.x runtime`。
   修法是先 `rt.enter()` 再构造。
3. **`cargo check --offline` 会解析失败。** `chacha20 0.10.1` 被 yank 而 `rand 0.10.2` 需要它，
   离线模式拒绝使用 yanked 版本。本机 crates.io 可达、`.crate` 已在缓存里，联网解析一次即可；
   之后 `Cargo.lock` 已提交，`--offline` 恢复可用。CI 里能正常联网，不受影响。

### 10.6 端到端测试中自己写出来的两个 bug（这两条最值钱）

这两条都是**写测试写出来的**，读代码看不出来——它们都是"全程无报错的静默失败"。

1. **激活缓存没有时效 → 输入打空。**
   为省掉每次输入都 `SetForegroundWindow` + `sleep(100ms)`，`rpc.rs` 给激活结果加了缓存。
   但没有 TTL：`activate → perceive（5 秒）→ activate → type` 这条链里，
   第二个 activate 因命中缓存被跳过，焦点始终没恢复，
   而 `send_unicode_text` 这条上游旧接口**只在显式给了 target_hwnd 时才校验前台**，
   于是字符打到别的窗口上，`type` 还返回"已输入 N 个字符"。
   **修法**：`last_activated: Option<(isize, Instant)>` + `ACTIVATION_TTL = 1500ms`，
   比典型 perceive（全屏约 4.8 秒）短，任何视觉操作之后的下一个输入都会重新激活。
2. **`SetForegroundWindow` 不还原最小化窗口 → 全程静默失败。**
   一个被最小化的窗口，`activate` 返回 ok、`type` 返回"已输入 N 字"，
   但 PNG 只有一个 199x34 的空壳、OCR 读出"口"。上游 `force_foreground` 里有
   `ShowWindow(SW_RESTORE)`，但 `ensure_active` 走的路径到不了那一步。
   **修法**：在本层（不改逐字复制的 `input/mod.rs`）加 `restore_if_minimized(hwnd)`：
   `IsIconic` 为真就先 `ShowWindow(SW_RESTORE)` 并等 120ms，再走原来的激活。
   `build/probe-restore.js` 专门守这条：先手动最小化，再验 activate 能否还原（3/3）。

这两条也解释了测试脚本为何要挑窗口挑得那么啰嗦：
**`windows` 列表里的 `visible` 只是 `IsWindowVisible`，最小化窗口同样返回 true**，
直接用 `wins.find(title)` 会稳定挑中一个看不见的目标。

### 10.7 复现命令

```powershell
# 1. 装工具链后跑协议级验收（15 条）
cd D:\桌面\大二上\cc园区\desktop
node build\drive.js

# 2. 走 Electron 那一层的接线验收（11 条，可在 CI 跑，不需要起 Electron）
node build\test-integration.js

# 3. 单独守最小化窗口还原（3 条）
node build\probe-restore.js

# 4. 重新构建整个 sidecar（crt-static 让 exe 不依赖 VC 运行时，用户不用装 redist）
cd vision-runtime
$env:RUSTFLAGS = "-C target-feature=+crt-static"
cmd /c '"D:\VS\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && cargo build --release --locked'
cd ..
node build\prepare-vision.cjs
```
