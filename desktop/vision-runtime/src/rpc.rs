//! stdio NDJSON 协议层：把 vendored 的 desktop-api 能力暴露成 20 个 JSON 方法。
//!
//! 设计要点，每条都对应上游的一处坑：
//!
//! 1. **模型会话常驻。** 上游 `vision::perceive::perceive_image(path)` 每次调用都新建三个
//!    ONNX 会话（`paddle_ocr.rs:44-52` 两次 `commit_from_file` 加载 4.7+10.9 MB，
//!    `yolo.rs` 的 `Mutex<Option<Session>>` 缓存随实例 drop 一起消失，下次重载 12.25 MB）。
//!    本层把 `PaddleOcr` / `YoloDetector` 作为 `RpcState` 的常驻字段，
//!    并直接调 `ocr_image_with_boxes` + `YoloDetector::detect` + `perceive::merge`
//!    这三个真函数。
//!    **不走 `VisionEngine::see()` / `OcrEngine::recognize` / `Locator::Query::Text`**——
//!    前两者是空壳（恒返回空），后者恒 found:false。
//!    `find_image` / `find_color` 则仍走 `Locator::find_with_fallback`
//!    （Image 与 Color 是它的两个真实实现分支，只是方法是私有的，没有别的入口）。
//!
//! 2. **目标合成 + 激活缓存。** 上游公有输入 API 全部要一个 `&mut Target`，
//!    "无目标的打字/点击"没有入口；且 `ensure_active` 对未 verified 的 Target 会先
//!    `SetForegroundWindow` 再 `sleep(100ms)`（`input/mod.rs:252-256`）。
//!    本层用 `GetForegroundWindow` 合成 `Target::Window`，并用 `last_activated`
//!    做**短 TTL 缓存**（见 ACTIVATION_TTL）：
//!    连续输入只激活一次，不反复抢焦点；
//!    但缓存会过期，任何一次耗时操作之后的下一个输入都会重新激活。
//!    这条 TTL 是实测踩出来的——没有它，"activate → perceive → type" 会静默打空。
//!
//! 3. **capture 响应带 origin。** 上游 `capture_fullscreen()` 抓到主屏却把
//!    `Frame.scope` 写成 `Scope::Fullscreen`（`capture.rs:145-150,165`），主屏原点
//!    （可能不是 (0,0)）就此消失；只有 `capture_desktop_region` 会写成 `Scope::Element{x,y,w,h}`。
//!    本层显式回 `origin:{x,y}`，否则主显示器不在左上角的机器上点击会整体偏移。
//!
//! 4. **串行。** 所有方法取 `&mut RpcState`。视觉与输入操作本就不可并行——
//!    同时两个 SetForegroundWindow 会互相打断；而 sidecar 由 Electron 主进程独占调用。

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::core::*;
use crate::input::InputEngine;
use crate::platform::WindowManager;
use crate::utils::cleanup::CleanupQueue;
use crate::vision::{
    ElementKind, ElementSource, FindMethod, FindResult, OcrBlock, PaddleOcr, Query, UiElement,
    YoloDetector,
};

/// 协议版本。Electron 主进程启动时断言一次；sidecar 始终与主程序同版本发布
/// （StatG 的更新是整体覆盖 Setup.exe，不存在单文件版本偏移）。
pub const PROTOCOL_VERSION: u32 = 1;

/// 稳定的错误码集合。上游 `DesktopError` 的变体天然给了我们分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadRequest,
    CaptureFailed,
    OcrFailed,
    InputFailed,
    LocateFailed,
    TargetNotFound,
    ActivationFailed,
    NotReady,
    InternalPanic,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::CaptureFailed => "capture_failed",
            ErrorCode::OcrFailed => "ocr_failed",
            ErrorCode::InputFailed => "input_failed",
            ErrorCode::LocateFailed => "locate_failed",
            ErrorCode::TargetNotFound => "target_not_found",
            ErrorCode::ActivationFailed => "activation_failed",
            ErrorCode::NotReady => "not_ready",
            ErrorCode::InternalPanic => "internal_panic",
        }
    }
}

/// RPC 错误：稳定码 + 给人看的消息。
#[derive(Debug)]
pub struct RpcError {
    code: ErrorCode,
    message: String,
}

impl RpcError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<DesktopError> for RpcError {
    fn from(value: DesktopError) -> Self {
        let code = match &value {
            DesktopError::TargetNotFound(_) => ErrorCode::TargetNotFound,
            DesktopError::ActivationFailed(_) => ErrorCode::ActivationFailed,
            DesktopError::CaptureFailed(_) => ErrorCode::CaptureFailed,
            DesktopError::OcrFailed(_) => ErrorCode::OcrFailed,
            DesktopError::InputFailed(_) => ErrorCode::InputFailed,
            DesktopError::LocateFailed(_) => ErrorCode::LocateFailed,
            DesktopError::SessionNotFound(_) | DesktopError::AllStrategiesFailed => {
                ErrorCode::BadRequest
            }
            DesktopError::PlatformNotSupported => ErrorCode::NotReady,
            DesktopError::Other(_) => ErrorCode::InternalPanic,
        };
        RpcError::new(code, value.to_string())
    }
}

// `Result` 此时解析到 crate::core::Result<T>（单参数别名），所以这里必须写全路径。
type RpcResult<T> = std::result::Result<T, RpcError>;

// ─────────────────────────────── 状态 ───────────────────────────────

/// 一条截图的留滞记录：PNG 落盘给 Electron 显示，Frame 留内存给 perceive/find 复用。
struct CaptureEntry {
    frame: Frame,
    path: PathBuf,
    origin: (i32, i32),
    width: u32,
    height: u32,
}

pub struct RpcState {
    windows: WindowManager,
    input: InputEngine,
    models_dir: Option<PathBuf>,
    /// 常驻 OCR 会话。`Option` 因为模型缺失时应当报错而不是 panic。
    ocr: Option<PaddleOcr>,
    /// 常驻 YOLO 检测器（内部自带懒加载 + Mutex 缓存）。
    yolo: YoloDetector,
    locator: crate::vision::Locator,
    cleanup: Arc<CleanupQueue>,
    capture_dir: PathBuf,
    captures: HashMap<String, CaptureEntry>,
    /// 本进程最近一次成功激活的 hwnd 与时刻。
    ///
    /// 这是**短 TTL 缓存，不是永久缓存**。理由是一次实测踩到的坑：
    /// 上游 `InputEngine::ensure_active` 对 `verified` 的 Target 直接返回，
    /// 不再 `SetForegroundWindow` + sleep(100ms)。如果没有时效，那么
    /// 「activate → 花 5 秒 perceive → activate → type」这条链里，
    /// 第二个 activate 会因为命中缓存而被跳过，焦点始终没恢复，
    /// 于是 type 的 SendInput 打到别的窗口上且**不报错**——
    /// send_unicode_text 这条旧接口只在显式给了 target_hwnd 时才校验前台。
    ///
    /// 保留缓存是因为连续输入（长串逐字、连击）确实不该每次都
    /// SetForegroundWindow——那会把焦点从 StatG 反复抢走。
    last_activated: Option<(isize, std::time::Instant)>,
    /// 常驻单线程运行时：避免每请求重建（~1ms 量级，但输入类请求有交互延迟感）。
    rt: tokio::runtime::Runtime,
}

/// 激活缓存的有效期。要比典型 perceive（全屏约 4.8 秒）短，
/// 这样任何一次视觉操作之后的下一个输入都会重新激活。
const ACTIVATION_TTL: std::time::Duration = std::time::Duration::from_millis(1500);

use std::sync::Arc;

impl RpcState {
    pub fn new() -> Self {
        // 运行时必须先建好，并且构造全程待在它的 context 里：
        // CleanupQueue::new() 内部会 spawn 一个后台清理任务（utils/cleanup.rs:18），
        // 在 Tokio runtime context 之外调用它会 panic ——
        // "there is no reactor running, must be called from the context of a Tokio 1.x runtime"。
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("构建 tokio 运行时失败");
        let _rt_guard = rt.enter();

        let cleanup = CleanupQueue::new();
        let models_dir = crate::vision::models::resolve_models_dir();
        // OCR 模型缺失时不在这里失败：截图与输入仍可用，perceive/ocr 会报明确的 not_ready。
        let ocr = PaddleOcr::new().ok();
        if ocr.is_none() {
            tracing::warn!("[rpc] OCR 模型未就位，perceive/ocr 将返回 not_ready");
            tracing::warn!(
                "[rpc] 提示：设 NUPHUS_MODELS_DIR 指向含 ch_PP-OCRv4_det.onnx / \
                 ch_PP-OCRv4_rec.onnx / ch_PP-OCR_keys_v1.txt 的目录"
            );
        }
        let capture_dir = std::env::var_os("STATG_CAPTURE_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                dirs::data_dir().map(|d| d.join("StatG").join("vision").join("captures"))
            })
            .unwrap_or_else(std::env::temp_dir);
        let _ = std::fs::create_dir_all(&capture_dir);

        Self {
            windows: WindowManager::new(),
            input: InputEngine::new(),
            models_dir,
            ocr,
            yolo: YoloDetector::new(),
            locator: crate::vision::Locator::new(),
            cleanup,
            capture_dir,
            captures: HashMap::new(),
            last_activated: None,
            rt,
        }
    }

    fn require_ocr(&mut self) -> RpcResult<&mut PaddleOcr> {
        if self.ocr.is_none() {
            // 模型可能是启动后才就位的，给一次补加载的机会。
            self.ocr = PaddleOcr::new().ok();
        }
        self.ocr.as_mut().ok_or_else(|| {
            RpcError::new(
                ErrorCode::NotReady,
                "OCR 模型未就位：请设置 NUPHUS_MODELS_DIR 指向含 ch_PP-OCRv4_det.onnx / \
                 ch_PP-OCRv4_rec.onnx / ch_PP-OCR_keys_v1.txt 的目录",
            )
        })
    }

    /// 这个窗口是否在本进程的有效期内刚激活过。
    ///
    /// 只认 TTL 内的命中，且目标必须就是当前前台窗口才敢说"已验证"——
    /// 否则缓存会掩盖一次已经失效的激活。
    fn recently_activated(&self, hwnd: isize) -> bool {
        match self.last_activated {
            Some((last, at)) => last == hwnd && at.elapsed() < ACTIVATION_TTL,
            None => false,
        }
    }

    /// 用当前前台窗口合成一个 Target。这是"无目标输入"的唯一入口。
    fn foreground_target(&self) -> Target {
        let hwnd = foreground_hwnd();
        Target::Window {
            hwnd,
            title: String::new(),
            // 本进程刚激活过这个窗口 → 视作已验证，
            // 让 InputEngine::ensure_active 直接返回，不反复抢焦点。
            verified: self.recently_activated(hwnd),
            gfx_backend: detect_gfx(hwnd),
        }
    }

    fn note_activated(&mut self, target: &Target) {
        if let Some(hwnd) = window_hwnd(target) {
            self.last_activated = Some((hwnd, std::time::Instant::now()));
        }
    }

    fn peek_capture(&mut self, id: &str) -> RpcResult<&CaptureEntry> {
        // 取 &mut 而不是 &：调用方随后要动 OCR 会话，而他们同属一个 state。
        // 驻留截图的清理由 store_capture 的 LRU 负责，不需要显式 take。
        self.captures
            .get(id)
            .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, format!("未知的 capture_id: {id}")))
    }

    fn store_capture(&mut self, entry: CaptureEntry) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        // 限制驻留数量：全屏 RGBA 是 1920*1200*4 ≈ 9.2 MB/帧，无上限会吃爆内存。
        if self.captures.len() >= 8 {
            let oldest = self.captures.keys().min().cloned();
            if let Some(k) = oldest {
                if let Some(e) = self.captures.remove(&k) {
                    let _ = std::fs::remove_file(&e.path);
                }
            }
        }
        let _ = &self.cleanup; // CleanupQueue 仍由上游持有；PNG 的删除走上面的 LRU
        self.captures.insert(id.clone(), entry);
        id
    }
}

#[cfg(windows)]
fn detect_gfx(hwnd: isize) -> GfxBackend {
    crate::platform::windows::detect_gfx_backend(hwnd)
}

#[cfg(not(windows))]
fn detect_gfx(_hwnd: isize) -> GfxBackend {
    GfxBackend::Unknown
}

/// 如果窗口处于最小化，先还原它。
///
/// 为什么必须有这一步（实测踩到的坑）：`SetForegroundWindow` **不会**还原最小化窗口。
/// 上游 `InputEngine::ensure_active` 只在 `is_foreground(hwnd)` 为 false 时才走
/// `force_foreground`（那里有 `ShowWindow(SW_RESTORE)`），而这条路径实际上不会生效；
/// 结果是 activate 返回 ok、type 也返回"已输入 N 个字符"，
/// 但字符全部打到了一个看不见的窗口上——**静默失败，没有任何报错**。
///
/// 实现放在本层而不是改上游：`input/mod.rs` 是逐字复制的，保持不动，
/// 升级时只需 diff 这一处。
#[cfg(windows)]
fn restore_if_minimized(hwnd: isize) {
    use ::windows::Win32::Foundation::HWND;
    use ::windows::Win32::UI::WindowsAndMessaging::{IsIconic, ShowWindow, SW_RESTORE};
    unsafe {
        if IsIconic(HWND(hwnd)).as_bool() {
            let _ = ShowWindow(HWND(hwnd), SW_RESTORE);
            // 让窗口完成还原后再让调用方去抢焦点
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
    }
}

#[cfg(not(windows))]
fn restore_if_minimized(_hwnd: isize) {}

fn window_hwnd(target: &Target) -> Option<isize> {
    match target {
        Target::Window { hwnd, .. } => Some(*hwnd),
        Target::Tui { hwnd, .. } => Some(*hwnd),
        Target::Browser { .. } => None,
    }
}

#[cfg(windows)]
fn foreground_hwnd() -> isize {
    use ::windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize }
}

#[cfg(not(windows))]
fn foreground_hwnd() -> isize {
    0
}

// ─────────────────────────────── 分派 ───────────────────────────────

pub fn dispatch(state: &mut RpcState, line: &str) -> RpcResult<Value> {
    let request: Value = serde_json::from_str(line)
        .map_err(|e| RpcError::new(ErrorCode::BadRequest, format!("JSON 解析失败: {e}")))?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, "缺少 method 字段"))?
        .to_string();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    match method.as_str() {
        "ping" => ping(state),
        "monitors" => monitors(state),
        "windows" => windows(state),
        "window_info" => {
            let hwnd = param_isize(&params, "hwnd")?;
            window_info(state, hwnd)
        }
        "capture" => {
            let scope = parse_scope(&params)?;
            capture(state, scope)
        }
        "perceive" => {
            let id = param_str(&params, "capture_id")?;
            perceive(state, &id)
        }
        "ocr" => {
            let id = param_str(&params, "capture_id")?;
            ocr(state, &id)
        }
        "find_image" => {
            let id = param_str(&params, "capture_id")?;
            let template = param_bytes(&params, "template")?;
            find_image(state, &id, template)
        }
        "find_color" => {
            let id = param_str(&params, "capture_id")?;
            find_color(state, &id, &params)
        }
        "activate" => {
            let hwnd = param_isize(&params, "hwnd")?;
            activate(state, hwnd)
        }
        "click" => {
            let x = param_i32(&params, "x")?;
            let y = param_i32(&params, "y")?;
            let button = params
                .get("button")
                .and_then(Value::as_str)
                .unwrap_or("left")
                .to_string();
            let clicks = params.get("clicks").and_then(Value::as_i64).unwrap_or(1) as i32;
            click(state, x, y, &button, clicks)
        }
        "move" => {
            let x = param_i32(&params, "x")?;
            let y = param_i32(&params, "y")?;
            move_mouse(state, x, y)
        }
        "drag" => {
            let x1 = param_i32(&params, "x1")?;
            let y1 = param_i32(&params, "y1")?;
            let x2 = param_i32(&params, "x2")?;
            let y2 = param_i32(&params, "y2")?;
            drag(state, x1, y1, x2, y2)
        }
        "scroll" => {
            let direction = param_str(&params, "direction")?;
            let amount = params.get("amount").and_then(Value::as_i64).unwrap_or(3) as i32;
            scroll(state, &direction, amount)
        }
        "type" => {
            let text = param_str(&params, "text")?;
            type_text(state, &text)
        }
        "hotkey" => {
            let keys = params
                .get("keys")
                .and_then(Value::as_array)
                .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, "缺少 keys 数组"))?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>();
            hotkey(state, &keys)
        }
        "clipboard_read" => clipboard_read(state),
        "clipboard_write" => {
            let text = param_str(&params, "text")?;
            clipboard_write(state, &text)
        }
        "shutdown" => Ok(json!({ "shutdown": true })),
        other => Err(RpcError::new(
            ErrorCode::BadRequest,
            format!("未知方法: {other}"),
        )),
    }
}

// ─────────────────────────────── 各方法 ───────────────────────────────

fn ping(state: &mut RpcState) -> RpcResult<Value> {
    let models_ready = state
        .models_dir
        .as_ref()
        .map(|d| crate::vision::models::validate_ocr_models(d).is_ok())
        .unwrap_or(false);
    let yolo_ready = state
        .models_dir
        .as_ref()
        .map(|d| crate::vision::models::yolo_model_available(d))
        .unwrap_or(false);

    Ok(json!({
        "protocol": PROTOCOL_VERSION,
        "crate": "statg-vision",
        "platform": std::env::consts::OS,
        "models_dir": state.models_dir.as_ref().map(|p| p.display().to_string()),
        // 把"模型没到位"在启动时就变成显式错误，而不是运行时的静默降级
        "ocr": models_ready,
        "yolo": yolo_ready,
    }))
}

fn monitors(_state: &mut RpcState) -> RpcResult<Value> {
    let list = xcap::Monitor::all().map_err(cap_err)?;
    let out = list
        .iter()
        .enumerate()
        .map(|(i, m)| {
            json!({
                "index": i,
                "x": m.x().ok(),
                "y": m.y().ok(),
                "width": m.width().ok(),
                "height": m.height().ok(),
                "primary": m.is_primary().ok(),
                "scale_factor": m.scale_factor().ok(),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!(out))
}

fn windows(state: &mut RpcState) -> RpcResult<Value> {
    let list = state.windows.list_all()?;
    Ok(json!(list.iter().map(window_info_json).collect::<Vec<_>>()))
}

fn window_info(state: &mut RpcState, hwnd: isize) -> RpcResult<Value> {
    let detail = state.windows.window_info(hwnd)?;
    Ok(json!({
        "hwnd": detail.hwnd,
        "title": detail.title,
        "visible": detail.visible,
        "minimized": detail.minimized,
        "maximized": detail.maximized,
        "window": rect_json(&detail.window),
        "client": rect_json(&detail.client),
        "process_id": detail.process_id,
        "process_name": detail.process_name,
        "class_name": detail.class_name,
    }))
}

fn capture(state: &mut RpcState, scope: CaptureScope) -> RpcResult<Value> {
    let (frame, origin): (Frame, (i32, i32)) = match scope {
        CaptureScope::Primary => {
            let m = primary_monitor()?;
            let x = m.x().map_err(cap_err)?;
            let y = m.y().map_err(cap_err)?;
            let w = m.width().map_err(cap_err)?;
            let h = m.height().map_err(cap_err)?;
            (crate::vision::capture_desktop_region(x, y, w, h)?, (x, y))
        }
        CaptureScope::All => {
            let rects = monitor_rects()?;
            let (x1, y1, x2, y2) = rects.iter().fold(
                (i32::MAX, i32::MAX, i32::MIN, i32::MIN),
                |(x1, y1, x2, y2), (x, y, w, h)| {
                    (
                        x1.min(*x),
                        y1.min(*y),
                        x2.max(*x + *w as i32),
                        y2.max(*y + *h as i32),
                    )
                },
            );
            if x2 <= x1 || y2 <= y1 {
                return Err(RpcError::new(ErrorCode::CaptureFailed, "没有可用的显示器"));
            }
            (
                crate::vision::capture_desktop_region(x1, y1, (x2 - x1) as u32, (y2 - y1) as u32)?,
                (x1, y1),
            )
        }
        CaptureScope::Window(hwnd) => {
            let target = target_for_hwnd(state, hwnd)?;
            // capture_with_geometry 会在截图前后各取一次几何，窗口在截图期间移动则报错——
            // 这是上游刻意做的"坐标与图像必须同源"保证，保留。
            let (frame, geom) = futures_run(&state.rt, async {
                crate::vision::capture::capture_with_geometry(&target, Scope::Window).await
            })?;
            (frame, (geom.x, geom.y))
        }
        CaptureScope::Region { x, y, w, h } => {
            (crate::vision::capture_desktop_region(x, y, w, h)?, (x, y))
        }
    };

    let width = frame.width;
    let height = frame.height;
    // PNG 先落盘，再驻留内存——同一个 id 既给 Electron 显示，也给后续 perceive/find 用。
    let path = state.capture_dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    write_png(&frame, &path)?;
    let id = state.store_capture(CaptureEntry {
        frame,
        path: path.clone(),
        origin,
        width,
        height,
    });

    Ok(json!({
        "capture_id": id,
        "path": path.display().to_string(),
        "width": width,
        "height": height,
        "origin": { "x": origin.0, "y": origin.1 },
    }))
}

fn perceive(state: &mut RpcState, capture_id: &str) -> RpcResult<Value> {
    let (pixels, width, height) = {
        let entry = state.peek_capture(capture_id)?;
        (
            entry.frame.pixels.clone(),
            entry.frame.width,
            entry.frame.height,
        )
    };
    let rgb = pixels_to_rgb(&pixels, width, height)?;

    // 常驻会话：不再每帧从磁盘重建三个 ONNX session。
    let ocr = state.require_ocr()?;
    let ocr_blocks: Vec<OcrBlock> = ocr
        .ocr_image_with_boxes(&rgb)
        .map_err(|e| RpcError::new(ErrorCode::OcrFailed, e))?;

    let yolo_available = state
        .models_dir
        .as_ref()
        .map(|d| crate::vision::models::yolo_model_available(d))
        .unwrap_or(false);

    let yolo_elements = if yolo_available {
        let rgba = image::DynamicImage::ImageRgb8(rgb).to_rgba8();
        let (w, h) = rgba.dimensions();
        let frame = Frame {
            id: uuid::Uuid::new_v4(),
            pixels: rgba.into_raw(),
            width: w,
            height: h,
            scope: Scope::Fullscreen,
            timestamp: chrono::Utc::now(),
            source: FrameSource::Screenshot,
        };
        state.yolo.detect(&frame)?
    } else {
        Vec::new()
    };

    let elements = crate::vision::perceive::merge(&ocr_blocks, &yolo_elements);
    let origin = {
        let entry = state.peek_capture(capture_id)?;
        (entry.origin, entry.width, entry.height)
    };

    Ok(json!({
        "capture_id": capture_id,
        // 上游 capture_fullscreen 会丢掉主屏原点；这里显式回出来，
        // 调用方才能把元素 rect（图像坐标）换算回屏幕坐标。
        "origin": { "x": origin.0.0, "y": origin.0.1 },
        "width": origin.1,
        "height": origin.2,
        "elements": elements.iter().map(ui_element_json).collect::<Vec<_>>(),
        "ocr_count": ocr_blocks.len(),
        "yolo_count": yolo_elements.len(),
        "yolo_available": yolo_available,
    }))
}

fn ocr(state: &mut RpcState, capture_id: &str) -> RpcResult<Value> {
    let (pixels, width, height) = {
        let entry = state.peek_capture(capture_id)?;
        (
            entry.frame.pixels.clone(),
            entry.frame.width,
            entry.frame.height,
        )
    };
    let rgb = pixels_to_rgb(&pixels, width, height)?;
    let session = state.require_ocr()?;
    let blocks = session
        .ocr_image_with_boxes(&rgb)
        .map_err(|e| RpcError::new(ErrorCode::OcrFailed, e))?;
    Ok(json!({
        "capture_id": capture_id,
        "blocks": blocks.iter().map(ocr_block_json).collect::<Vec<_>>(),
    }))
}

fn find_image(state: &mut RpcState, capture_id: &str, template: Vec<u8>) -> RpcResult<Value> {
    let (pixels, width, height) = {
        let entry = state.peek_capture(capture_id)?;
        (
            entry.frame.pixels.clone(),
            entry.frame.width,
            entry.frame.height,
        )
    };
    let frame = pixels_to_frame(pixels, width, height)?;
    let result =
        futures_run(&state.rt, async { state.locator.find_with_fallback(&frame, &Query::Image(template)).await })?;
    let mut out = find_result_json(&result);
    if let Some(o) = out.as_object_mut() {
        o.insert("capture_id".into(), json!(capture_id));
    }
    Ok(out)
}

fn find_color(state: &mut RpcState, capture_id: &str, params: &Value) -> RpcResult<Value> {
    let color = params
        .get("color")
        .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, "缺少 color"))?;
    let target = Color {
        r: color.get("r").and_then(Value::as_u64).unwrap_or(0) as u8,
        g: color.get("g").and_then(Value::as_u64).unwrap_or(0) as u8,
        b: color.get("b").and_then(Value::as_u64).unwrap_or(0) as u8,
        a: 255,
    };
    let tolerance = params.get("tolerance").and_then(Value::as_u64).unwrap_or(10) as u8;
    let (pixels, width, height) = {
        let entry = state.peek_capture(capture_id)?;
        (
            entry.frame.pixels.clone(),
            entry.frame.width,
            entry.frame.height,
        )
    };
    let frame = pixels_to_frame(pixels, width, height)?;
    let query = Query::Color { target, tolerance };
    let result = futures_run(&state.rt, async {
        state.locator.find_with_fallback(&frame, &query).await
    })?;
    let mut out = find_result_json(&result);
    if let Some(o) = out.as_object_mut() {
        o.insert(
            "color".into(),
            json!({ "r": target.r, "g": target.g, "b": target.b }),
        );
    }
    Ok(out)
}

fn activate(state: &mut RpcState, hwnd: isize) -> RpcResult<Value> {
    let target_hwnd = if hwnd > 0 { hwnd } else { foreground_hwnd() };
    // 最小化的窗口必须先还原，否则后面整套激活都是静默空转（见 restore_if_minimized）
    restore_if_minimized(target_hwnd);
    let mut target = if hwnd > 0 {
        target_for_hwnd(state, hwnd)?
    } else {
        state.foreground_target()
    };
    futures_run(&state.rt, async { state.input.activate(&mut target).await })?;
    state.note_activated(&target);
    Ok(json!({ "hwnd": window_hwnd(&target), "activated": true }))
}

fn click(state: &mut RpcState, x: i32, y: i32, button: &str, clicks: i32) -> RpcResult<Value> {
    // 上游 mouse::click_at 只在 macOS 有实体（`#[cfg(target_os = "macos")]`）。
    // Windows 上按 button 分派到 click / right_click / middle_click，
    // 这三个都不接受 clicks 参数——双击由调用方发两次，或在 hotkey 层另做。
    // 上游 mouse::click_at 只在 macOS 有实体（`#[cfg(target_os = "macos")]`）。
    // Windows 上按 button 分派到 click / right_click / middle_click。
    // 这三个 async fn 各自返回不透明 Future，无法收进同一个变量，
    // 所以每个分支自己 await（分支体是语句，类型一致）。
    // clicks（双击）这三个函数都不收——由调用方发两次请求实现。
    match button {
        "left" => futures_run(&state.rt, async { crate::input::mouse::click(x, y).await })?,
        "right" => futures_run(&state.rt, async { crate::input::mouse::right_click(x, y).await })?,
        "middle" => {
            futures_run(&state.rt, async { crate::input::mouse::middle_click(x, y).await })?
        }
        other => {
            return Err(RpcError::new(
                ErrorCode::BadRequest,
                format!("不支持的 button: {other}（支持 left / right / middle）"),
            ))
        }
    }
    Ok(json!({ "x": x, "y": y, "button": button, "clicks_requested": clicks, "clicked": true }))
}

fn move_mouse(state: &mut RpcState, x: i32, y: i32) -> RpcResult<Value> {
    futures_run(&state.rt, async { crate::input::mouse::move_to(x, y).await })?;
    Ok(json!({ "x": x, "y": y }))
}

fn drag(state: &mut RpcState, x1: i32, y1: i32, x2: i32, y2: i32) -> RpcResult<Value> {
    let start = Point { x: x1, y: y1 };
    let end = Point { x: x2, y: y2 };
    // drag 属于输入类操作，先激活前台窗口再操作。
    let mut target = state.foreground_target();
    futures_run(&state.rt, async {
        state.input.drag(&mut target, start, end).await
    })?;
    state.note_activated(&target);
    Ok(json!({ "from": { "x": x1, "y": y1 }, "to": { "x": x2, "y": y2 } }))
}

fn scroll(state: &mut RpcState, direction: &str, amount: i32) -> RpcResult<Value> {
    futures_run(&state.rt, async {
        crate::input::mouse::scroll(direction, amount).await
    })?;
    Ok(json!({ "direction": direction, "amount": amount }))
}

fn type_text(state: &mut RpcState, text: &str) -> RpcResult<Value> {
    let mut target = state.foreground_target();
    futures_run(&state.rt, async { state.input.send_text(text, &mut target).await })?;
    state.note_activated(&target);
    Ok(json!({ "typed": text.chars().count() }))
}

fn hotkey(state: &mut RpcState, keys: &[String]) -> RpcResult<Value> {
    let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
    let mut target = state.foreground_target();
    futures_run(&state.rt, async { state.input.hotkey(&mut target, &refs).await })?;
    state.note_activated(&target);
    Ok(json!({ "keys": keys }))
}

fn clipboard_read(_state: &mut RpcState) -> RpcResult<Value> {
    let text = crate::clipboard::read_text()?;
    Ok(json!({ "text": text }))
}

fn clipboard_write(_state: &mut RpcState, text: &str) -> RpcResult<Value> {
    crate::clipboard::write_text(text)?;
    Ok(json!({ "written": text.chars().count() }))
}

// ─────────────────────────────── 辅助 ───────────────────────────────

fn cap_err(e: xcap::XCapError) -> RpcError {
    RpcError::from(DesktopError::CaptureFailed(e.to_string()))
}

fn primary_monitor() -> RpcResult<xcap::Monitor> {
    xcap::Monitor::all()
        .map_err(cap_err)?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or_else(|| RpcError::new(ErrorCode::CaptureFailed, "找不到主显示器"))
}

fn monitor_rects() -> RpcResult<Vec<(i32, i32, u32, u32)>> {
    xcap::Monitor::all()
        .map_err(cap_err)?
        .iter()
        .map(|m| Ok((m.x()?, m.y()?, m.width()?, m.height()?)))
        .collect::<std::result::Result<Vec<_>, xcap::XCapError>>()
        .map_err(cap_err)
}

fn target_for_hwnd(state: &RpcState, hwnd: isize) -> RpcResult<Target> {
    if hwnd <= 0 {
        return Ok(state.foreground_target());
    }
    let detail = state.windows.window_info(hwnd)?;
    Ok(Target::Window {
        hwnd,
        title: detail.title,
        verified: state.recently_activated(hwnd),
        gfx_backend: detect_gfx(hwnd),
    })
}

enum CaptureScope {
    Primary,
    All,
    Window(isize),
    Region { x: i32, y: i32, w: u32, h: u32 },
}

fn parse_scope(params: &Value) -> RpcResult<CaptureScope> {
    let scope = params
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("primary");
    match scope {
        "primary" => Ok(CaptureScope::Primary),
        "all" => Ok(CaptureScope::All),
        "window" => Ok(CaptureScope::Window(
            params.get("hwnd").and_then(Value::as_i64).unwrap_or(0) as isize,
        )),
        "region" => {
            let x = params.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
            let y = params.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
            let w = params.get("w").and_then(Value::as_u64).unwrap_or(0) as u32;
            let h = params.get("h").and_then(Value::as_u64).unwrap_or(0) as u32;
            if w == 0 || h == 0 {
                return Err(RpcError::new(ErrorCode::BadRequest, "region 需要正的 w 与 h"));
            }
            Ok(CaptureScope::Region { x, y, w, h })
        }
        other => Err(RpcError::new(
            ErrorCode::BadRequest,
            format!("未知 scope: {other}（支持 primary / all / window / region）"),
        )),
    }
}

fn pixels_to_rgb(pixels: &[u8], width: u32, height: u32) -> RpcResult<image::RgbImage> {
    Ok(image::DynamicImage::ImageRgba8(pixels_to_rgba(pixels, width, height)?).to_rgb8())
}

fn pixels_to_rgba(pixels: &[u8], width: u32, height: u32) -> RpcResult<image::RgbaImage> {
    image::RgbaImage::from_raw(width, height, pixels.to_vec())
        .ok_or_else(|| RpcError::new(ErrorCode::CaptureFailed, "帧尺寸与像素缓冲长度不符"))
}

fn pixels_to_frame(pixels: Vec<u8>, width: u32, height: u32) -> RpcResult<Frame> {
    let rgba = pixels_to_rgba(&pixels, width, height)?;
    let (w, h) = rgba.dimensions();
    Ok(Frame {
        id: uuid::Uuid::new_v4(),
        pixels: rgba.into_raw(),
        width: w,
        height: h,
        scope: Scope::Fullscreen,
        timestamp: chrono::Utc::now(),
        source: FrameSource::Screenshot,
    })
}

fn write_png(frame: &Frame, path: &std::path::Path) -> RpcResult<()> {
    let rgba = pixels_to_rgba(&frame.pixels, frame.width, frame.height)?;
    image::DynamicImage::ImageRgba8(rgba)
        .save_with_format(path, image::ImageFormat::Png)
        .map_err(|e| RpcError::new(ErrorCode::CaptureFailed, format!("PNG 写出失败: {e}")))
}

/// 在常驻运行时上阻塞地跑完 future。
fn futures_run<T>(
    rt: &tokio::runtime::Runtime,
    future: impl std::future::Future<Output = Result<T>>,
) -> RpcResult<T> {
    rt.block_on(future).map_err(RpcError::from)
}

fn window_info_json(w: &crate::platform::WindowInfo) -> Value {
    json!({
        "hwnd": w.hwnd,
        "title": w.title,
        "x": w.x,
        "y": w.y,
        "width": w.width,
        "height": w.height,
        "visible": w.visible,
        "process_id": w.process_id,
    })
}

fn rect_json(r: &Rect) -> Value {
    json!({ "x": r.x, "y": r.y, "w": r.w, "h": r.h })
}

fn find_result_json(r: &FindResult) -> Value {
    json!({
        "found": r.found,
        "rect": r.rect.as_ref().map(rect_json),
        "confidence": r.confidence,
        "method": match r.method {
            FindMethod::ImageMatch => "image_match",
            FindMethod::TextOcr => "text_ocr",
            FindMethod::ColorScan => "color_scan",
            FindMethod::Combined => "combined",
            FindMethod::Fallback => "fallback",
        },
    })
}

fn ocr_block_json(b: &OcrBlock) -> Value {
    json!({ "text": b.text, "x": b.x, "y": b.y, "w": b.w, "h": b.h })
}

fn element_kind_str(kind: ElementKind) -> &'static str {
    match kind {
        ElementKind::Button => "button",
        ElementKind::Input => "input",
        ElementKind::Text => "text",
        ElementKind::Image => "image",
        ElementKind::Icon => "icon",
        ElementKind::Unknown => "unknown",
    }
}

fn element_source_str(source: ElementSource) -> &'static str {
    match source {
        ElementSource::Ocr => "ocr",
        ElementSource::Yolo => "yolo",
        ElementSource::Both => "both",
    }
}

fn ui_element_json(e: &UiElement) -> Value {
    json!({
        "id": e.id,
        "kind": element_kind_str(e.kind),
        "text": e.text,
        "rect": rect_json(&e.rect),
        "confidence": e.confidence,
        "source": element_source_str(e.source),
    })
}

fn param_str(params: &Value, key: &str) -> RpcResult<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, format!("缺少字符串参数 {key}")))
}

fn param_i32(params: &Value, key: &str) -> RpcResult<i32> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, format!("缺少整数参数 {key}")))
}

fn param_isize(params: &Value, key: &str) -> RpcResult<isize> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .map(|v| v as isize)
        .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, format!("缺少整数参数 {key}")))
}

/// 接受 base64 字符串（Electron 侧 `Buffer.from(x).toString('base64')`）。
fn param_bytes(params: &Value, key: &str) -> RpcResult<Vec<u8>> {
    let raw = params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(ErrorCode::BadRequest, format!("缺少参数 {key}")))?;
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, raw)
        .map_err(|e| RpcError::new(ErrorCode::BadRequest, format!("{key} 不是合法 base64: {e}")))
}
