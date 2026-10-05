**StatG 桌面视觉 sidecar — vendored 声明**

## 来源

本目录 `src/` 的绝大部分代码逐字复制自 [`Nuphus`](https://github.com/mrpulor-gh/nuphus) 的
`src-tauri/crates/desktop-api` crate（Apache-2.0），版本 2.0.0，复制时间 2026-10-04。

按 Nuphus 仓库的 Apache-2.0 许可要求：

- 完整 Apache-2.0 许可文本见 `LICENSE-APACHE-2.0.txt`（上游原样拷贝）
- 上游版权声明保留在下列文件的头部
- 对本文件的任何修改在对应文件的文件头注释中说明

## 复制关系

以下文件**逐字复制，未做任何修改**：

| 文件 |
|---|
| `src/input/mouse.rs` |
| `src/input/keyboard.rs` |
| `src/input/sendinput.rs` |
| `src/input/mod.rs` |
| `src/clipboard.rs` |
| `src/utils/mod.rs` |
| `src/utils/cleanup.rs` |
| `src/vision/capture.rs`（仅把 `capture_desktop_region` 改为 `pub`） |
| `src/vision/locate.rs` |
| `src/vision/models.rs` |
| `src/vision/ocr.rs` |
| `src/vision/paddle_ocr.rs` |
| `src/vision/perceive.rs` |
| `src/vision/runtime.rs` |
| `src/vision/yolo.rs` |

以下文件**有修改**，改在文件头逐条列出：

| 文件 | 修改 |
|---|---|
| `src/lib.rs` | 删去 `api` 模块与 `http-server` feature；新增 `rpc` 模块 |
| `src/core/mod.rs` | 删去 `AppKind` / `TargetSpec` / `SessionHandle` / `Viewport` / `SessionManager` 及其 `Arc`/`RwLock`/`HashMap` 依赖（随 http-server 一并移除） |
| `src/platform/windows.rs` | 删去 `enum_callback` / `search_callback` / `SearchCtx` 三个 `pub` 定义（与 `platform/mod.rs` 末尾的同名私有定义逐字重复，且本 crate 中无任何引用） |
| `src/main.rs` | **完全重写**——从 HTTP 服务改为 stdio NDJSON |
| `src/rpc.rs` | **新增**——协议层 |

以下内容**被删除**：`src/api/mod.rs`、`src/api/http.rs`、`examples/`、`tests/wintest.rs`。
删除原因见 `src/lib.rs` 文件头（上游的 HTTP 会话层是 TODO 桩，不可用）。

## 二进制产物的来源

`../vision-assets/` 下的 DLL 与模型不是本 crate 构建出来的，来源如下：

| 文件 | 来源 | 大小 |
|---|---|---|
| `onnxruntime.dll` | Nuphus `src-tauri/desktop/sherpa/`，ONNX Runtime 1.27.0（Microsoft.ML.OnnxRuntime nuget 包），SHA-256 前 12 位 `F4DCDDCBE283` | 15.95 MB |
| `onnxruntime_providers_shared.dll` | 同上，SHA-256 前 12 位 `92CEE8B204EF` | 0.01 MB |
| `models/ch_PP-OCRv4_det.onnx` | RapidOCR / SWHL PP-OCRv4 文本检测，SHA-256 前 12 位 `D2A7720D45A5` | 4.53 MB |
| `models/ch_PP-OCRv4_rec.onnx` | RapidOCR / SWHL PP-OCRv4 文本识别，SHA-256 前 12 位 `48FC40F24F6D` | 10.35 MB |
| `models/ch_PP-OCR_keys_v1.txt` | PaddleOCR 字符字典（6623 类），SHA-256 前 12 位 `A1C84D9BDB9A` | 0.03 MB |
| `models/icon_detect.onnx` | OmniParser icon_detect（YOLO，12 MB 级），SHA-256 前 12 位 `0432FACE5E01` | 11.68 MB |

合计 42.54 MB。**这些文件进 git 而不走 CI 下载**，换取完全离线可复现的构建：
上游 `src-tauri/build.rs` 里所有模型下载失败只发 `cargo:warning` 不中断构建，照抄它会得到一个
"构建成功但运行时缺模型"的静默故障。

## 为什么不用上游整棵引擎

`src/`（nuphus 引擎）与桌面能力没有干净的依赖边界：`lib.rs` 无条件声明 34 个顶层 `pub mod`，
`Cargo.toml` 一个 `[features]` 段都没有，从 `desktop` 出发的引用闭包覆盖 33/34 个模块，
依赖闭包 402 个 crate 且含 `libsqlite3-sys` / `onig_sys` / `bzip2-sys` / `zstd-sys` 的
`cc` → `cl.exe`——那会强制要求终端用户机器上装有 C++ 编译器。

`desktop-api` 则是叶子 crate：Cargo.toml 无任何 `path =` 依赖，闭包约 112 个 crate 且不含 `cc`，
自带 lib + bin + 三个 example，Nuphus 自己的 CI 就把 `cargo test -p desktop-api --lib`
当独立构建单元在跑。这是选它的全部理由。

## 升级方式

把上游 `src-tauri/crates/desktop-api` 固定 commit 与 `src/lib.rs`、`src/core/mod.rs`、
`src/platform/windows.rs`、`src/main.rs`、`src/rpc.rs` 这五个文件做 diff。
逐字复制的那批应当零 diff；有差异的部分就是需要人工复核的改动面。
`rpc.rs` 是本 crate 自有的，升级时只需确认上游签名没变。
