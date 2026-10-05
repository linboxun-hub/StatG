// StatG 桌面视觉 sidecar 的构建脚本。
//
// 唯一职责：把 PerMonitorV2 DPI awareness manifest 嵌进 exe。
//
// 为什么这是必需而不是加分：
//   xcap 0.9.7 的 [features] 没有任何 default（只有 image 与 wgc，都不默认开），
//   而 xcap::Window 走的是 GDI 后端。gdi.rs 里裁剪偏移 x = (DwmGetWindowAttribute 的物理原点
//   - GetWindowRect 的 DPI 虚拟化原点) * scale_factor —— 两个坐标系相减，x 可能为负，
//   `x as u32` 会变成 ~4.29e9，image 的 crop_dimms 是 clamp 不是 assert，
//   于是 release 下静默产出错图、debug 下算术下溢 panic。
//   manifest 同时会改变 xcap 自己的行为分支（scale_factor 取 1.0 还是 monitor.scale_factor()），
//   所以它是行为开关，必须在同一处显式声明。

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(windows)]
    {
        let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR missing"));
        let manifest_path = out_dir.join("statg-vision.manifest");

        let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="StatG.VisionSidecar" type="win32"/>
  <application xmlns="urn:schemas-microsoft-com:asm.v1">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>"#;

        fs::write(&manifest_path, manifest).expect("write manifest failed");

        // /MANIFEST:EMBED 让 link.exe 把这份 manifest 编进 PE 的 RT_MANIFEST。
        let mut escaped = manifest_path.to_string_lossy().to_string();
        if escaped.contains(' ') {
            escaped = format!("\"{}\"", escaped);
        }
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{escaped}");
    }
}
