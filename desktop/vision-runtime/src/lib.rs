// StatG 桌面视觉 sidecar — Nuphus desktop-api 的 vendored 副本（Apache-2.0，见 NOTICE.md）。
// 感知 · 查找 · 操作 · 沟通
//
// 相对上游的删减：整个 `api`（HTTP 服务）与 `http-server` feature 已移除——
// 上游的 SessionManager::create 是 TODO 桩（造出 hwnd:0 的 placeholder 目标），不可用。
// 对外协议改为 stdio NDJSON，见 src/rpc.rs。

pub mod clipboard;
pub mod core;
pub mod input;
// platform（WindowManager 等）为 Windows 专属：hwnd/Target::Window 仅在 cfg(windows) 下存在。
// Linux/macOS 编译时该模块整体不编译，避免 Target::Window 引用错误。
#[cfg(windows)]
pub mod platform;
pub mod rpc;
pub mod utils;
pub mod vision;

pub use core::*;
pub use input::*;
#[cfg(windows)]
pub use platform::*;
pub use vision::*;
