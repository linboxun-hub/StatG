# 截取应用窗口（Electron 主窗口），用于验证界面改动
# 用法：powershell -File shot.ps1 -TitleContains "Stata 助手" -Out <png 路径>
param(
  [string]$TitleContains = 'Stata',
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$WaitMs = 2500
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@

$best = $null
Get-Process -Name 'StatG', 'Stata助手', 'electron' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -eq 0) { return }
  if ($_.MainWindowTitle -notlike "*$TitleContains*") { return }
  # 先还原再最大化：最小化/隐藏的窗口拿不到真实尺寸
  [Win]::ShowWindow($_.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  [Win]::ShowWindow($_.MainWindowHandle, 3) | Out-Null   # SW_MAXIMIZE
  Start-Sleep -Milliseconds 400
  $rr = New-Object Win+RECT
  [Win]::GetWindowRect($_.MainWindowHandle, [ref]$rr) | Out-Null
  $ww = $rr.R - $rr.L; $hh = $rr.B - $rr.T
  if ($ww -lt 300 -or $hh -lt 300) { return }
  if ($null -eq $best -or ($ww * $hh) -gt ($best.W * $best.H)) {
    $best = @{ H = $_.MainWindowHandle; W = $ww; Ht = $hh; T = $_.MainWindowTitle }
  }
}
if ($null -eq $best) { throw "找不到标题包含「$TitleContains」且可见的窗口" }
$h = $best.H
"window: $h  title: $($best.T)  size: $($best.W)x$($best.Ht)"
[Win]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds $WaitMs

# 取景前一刻再还原一次：期间窗口可能又被最小化
[Win]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[Win]::ShowWindow($h, 3) | Out-Null   # SW_MAXIMIZE
Start-Sleep -Milliseconds 300

$r = New-Object Win+RECT
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
"rect: ${w}x${ht} at ($($r.L),$($r.T))"

$bmp = New-Object System.Drawing.Bitmap($w, $ht, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()

$dir = Split-Path $Out -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved: $Out  ({0:N0} KB)" -f ((Get-Item -LiteralPath $Out).Length / 1KB)
