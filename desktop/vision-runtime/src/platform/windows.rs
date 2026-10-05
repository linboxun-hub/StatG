//! Windows 平台特定实现
//!
//! 相对上游 desktop-api 的删减：删去 `enum_callback` / `search_callback` / `SearchCtx`
//! 三个 `pub` 定义。它们与 platform/mod.rs 末尾的同名私有定义逐字重复，
//! 而 mod.rs 里未加限定地调用的那对解析到本地私有版本——即本文件中这三个是死代码。
//! 删除后少一份升级时要同步的 diff。窗口枚举与搜索的实际实现见 platform/mod.rs:350-424。

use crate::core::*;

/// 检测窗口图形后端
pub fn detect_gfx_backend(hwnd: isize) -> GfxBackend {
    use ::windows::Win32::Foundation::HWND;
    use ::windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(HWND(hwnd), &mut buf) };
    if len == 0 {
        return GfxBackend::Unknown;
    }

    let class = String::from_utf16_lossy(&buf[..len as usize]);
    match class.as_str() {
        "Chrome_WidgetWin_1" | "Chrome_WidgetWin_2" | "CefBrowserWindow" => GfxBackend::DirectX,
        "Qt5QWindowIcon" | "Qt6QWindowIcon" => GfxBackend::OpenGl,
        "ConsoleWindowClass" | "#32770" => GfxBackend::Gdi,
        _ => GfxBackend::Gdi,
    }
}
