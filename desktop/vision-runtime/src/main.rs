//! StatG 桌面视觉 sidecar — stdio NDJSON 入口。
//!
//! 协议：一行一帧，UTF-8，'\n' 分隔。
//!   → {"id":1,"method":"ping","params":{}}
//!   ← {"id":1,"ok":true,"result":{...}}
//!   ← {"id":1,"ok":false,"error":{"code":"capture_failed","message":"..."}}
//!
//! 三条硬约束：
//! 1. **stdout 只走协议帧。** 日志走 stderr（tracing 的 `.with_writer(std::io::stderr)`），
//!    对应 Electron 主进程已经在收集 stderr 并在失败时弹给用户的那套逻辑。
//! 2. **Windows 上 ort 的 dylib 解析失败是 panic 而不是 Err**
//!    （ort-2.0.0-rc.12/src/lib.rs 在 ORT_DYLIB_PATH 兜底失败时直接 `.expect`）。
//!    上游 `vision::runtime::ensure_onnx_runtime()` 在 Windows 上是空操作（只有 macOS 有实体），
//!    所以这里自己显式 `ort::init_from().commit()`，把硬 panic 变成一个干净的启动错误。
//! 3. **逐行串行处理。** 不做并发——视觉与输入操作本就不可并行（同时两个 SetForegroundWindow
//!    会互相打断），且 build script 那类宿主机可执行文件的链接也不需要高吞吐。

use std::io::{BufRead, Write};
use std::sync::Mutex;

use statg_vision::rpc::{dispatch, RpcState};

fn main() {
    // 日志只走 stderr，绝不污染 stdout 的协议流。
    // 默认 warn：生产环境不希望每帧都打点，排障时用 RUST_LOG=statg_vision=debug 打开。
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    if let Err(message) = init_onnx_runtime_strict() {
        // 记日志但不退出：模型缺失应当是运行时的显式错误（ping 会报 ocr/yolo=false），
        // 而不是让整个 sidecar 起不来——截图与输入不依赖 onnxruntime。
        tracing::error!("[onnx] {message}");
    }

    let state = Mutex::new(RpcState::new());
    let stdin = std::io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("[stdio] 读取失败: {e}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = {
            // 单条请求 panic 不该带走整个 sidecar。注意：catch_unwind 只在
            // panic="unwind" 下有效，所以 [profile.release] 里刻意不设 panic="abort"。
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dispatch(&mut *guard, trimmed)
            }));
            match result {
                Ok(Ok(value)) => serde_json::json!({ "ok": true, "result": value }),
                Ok(Err(err)) => serde_json::json!({
                    "ok": false,
                    "error": { "code": err.code(), "message": err.message() }
                }),
                Err(_) => serde_json::json!({
                    "ok": false,
                    "error": { "code": "internal_panic", "message": "sidecar 内部 panic，已捕获" }
                }),
            }
        };

        // id 从请求里回抄；请求本身解析不出来时 id 置 null，调用方靠顺序也能发现对不上。
        let id = serde_json::from_str::<serde_json::Value>(trimmed)
            .ok()
            .and_then(|v| v.get("id").cloned())
            .unwrap_or(serde_json::Value::Null);
        let mut out = serde_json::Map::new();
        out.insert("id".into(), id);
        if let Some(ok) = response.get("ok") {
            out.insert("ok".into(), ok.clone());
        }
        if let Some(err) = response.get("error") {
            out.insert("error".into(), err.clone());
        }
        if let Some(res) = response.get("result") {
            out.insert("result".into(), res.clone());
        }

        let mut text = serde_json::to_string(&serde_json::Value::Object(out))
            .unwrap_or_else(|_| r#"{"id":null,"ok":false,"error":{"code":"serialize_failed","message":"response serialization failed"}}"#.to_string());
        text.push('\n');
        if let Err(e) = std::io::stdout().write_all(text.as_bytes()) {
            tracing::error!("[stdio] 写出失败: {e}（下游可能已关闭管道）");
            break;
        }
        let _ = std::io::stdout().flush();
    }
}

/// 显式把 onnxruntime 加载到 ort 的 load-dynamic 解析器里。
///
/// 优先级：`ORT_DYLIB_PATH` → exe 同目录的 `onnxruntime.dll`（Windows 加载器本来就会先看应用目录，
/// 这里显式做一遍是为了让失败可报告而不是 panic）→ 都不设，交给 ort 默认行为。
#[cfg(windows)]
fn init_onnx_runtime_strict() -> Result<(), String> {
    let candidate = std::env::var_os("ORT_DYLIB_PATH")
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| {
            let sibling = std::env::current_exe()
                .ok()?
                .parent()?
                .join("onnxruntime.dll");
            sibling.exists().then_some(sibling)
        });

    match candidate {
        Some(path) => {
            // commit() 返回 bool：false 表示全局环境已存在且未被替换。
            // 这不是错误（首次 init 后重复调用即如此），但值得留痕。
            let replaced = ort::init_from(&path)
                .map_err(|e| format!("无法加载 ONNX Runtime ({}): {e}", path.display()))?
                .commit();
            if !replaced {
                tracing::debug!("[onnx] 全局环境已存在，init_from 未替换");
            }
        }
        None => {
            tracing::warn!(
                "[onnx] 未找到 onnxruntime.dll（ORT_DYLIB_PATH 与 exe 同目录都没有），交给 ort 默认解析"
            );
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn init_onnx_runtime_strict() -> Result<(), String> {
    statg_vision::vision::runtime::ensure_onnx_runtime()
}
