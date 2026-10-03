# 从原始大图裁一个正圆窗口当图标。
#
# 不做任何重新上色、不补底盘、不磨圈——原图什么样就什么样，只裁。
# 原图是 3840x2160 的横版图，标志（紫圆）大致居中，先量包围盒再取正方形，
# 圆外全部清成透明。
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Size = 1024,        # 输出边长
  [double]$LumOn = 14,      # 判定「属于图形」的亮度阈值，用来量包围盒
  [double]$DarkCut = 38,    # 暗部换白的阈值：lum 低于它的像素变白；0 = 不换
  [double]$DiscLum = 45     # 量紫圈真实外沿用的阈值（紫圈≈52、圈外辉光≈31，取中）
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
public static class CircleCrop {
  // 亮度高于阈值的像素的包围盒
  public static void BBox(byte[] px, int w, int h, int stride, double lumOn,
                          out int x0, out int y0, out int x1, out int y1) {
    x0 = int.MaxValue; y0 = int.MaxValue; x1 = int.MinValue; y1 = int.MinValue;
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x < w; x++) {
        int i = row + x * 4;
        double lum = 0.299 * px[i + 2] + 0.587 * px[i + 1] + 0.114 * px[i];
        if (lum < lumOn) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x0 > x1) { x0 = y0 = 0; x1 = y1 = 0; }
  }

  // 裁成正圆：半径之外的像素清成透明，边缘 2px 柔化
  public static void CircleClip(byte[] px, int w, int h, int stride, double radiusRatio) {
    double cx = (w - 1) / 2.0, cy = (h - 1) / 2.0;
    double R = Math.Min(w, h) * 0.5 * radiusRatio;
    double feather = 2.0;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        double dx = x - cx, dy = y - cy;
        double d = Math.Sqrt(dx * dx + dy * dy);
        int i = y * stride + x * 4;
        if (d > R) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0; }
        else if (d > R - feather) {
          double t = (R - d) / feather;
          px[i + 3] = (byte)Math.Round(px[i + 3] * t);
        }
      }
    }
  }
  // 把暗部换成白色，但只换 maxRatio 半径以内的。
  // maxRatio 必须是紫圈的真实外沿：原图紫圈亮度稳定在 52，圈外还有一圈
  // 很暗的辉光（lum≈31）。不给范围限制的话，辉光会被一起染白，
  // 等于给紫圈描一道白边——之前就犯过这个错。
  public static void DarkToWhite(byte[] px, int w, int h, int stride, double lumOn, double maxRatio) {
    double cx = (w - 1) / 2.0, cy = (h - 1) / 2.0;
    double R = Math.Min(w, h) * 0.5 * maxRatio;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int i = y * stride + x * 4;
        if (px[i + 3] == 0) continue;
        double dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy > R * R) continue;   // 圈外不管，该透明就透明
        double lum = 0.299 * px[i + 2] + 0.587 * px[i + 1] + 0.114 * px[i];
        if (lum < lumOn) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
      }
    }
  }
}
'@

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# ── 1. 读原图，量标志包围盒 ──
$srcImg = [System.Drawing.Image]::FromFile($Source)
$sw = $srcImg.Width; $sh = $srcImg.Height
$srcBmp = New-Object System.Drawing.Bitmap($sw, $sh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$sg = [System.Drawing.Graphics]::FromImage($srcBmp)
$sg.DrawImage($srcImg, (New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)))
$sg.Dispose()

$srect = New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)
$sd = $srcBmp.LockBits($srect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $srcBmp.PixelFormat)
$slen = $sd.Stride * $sh
$sbytes = New-Object byte[] $slen
[System.Runtime.InteropServices.Marshal]::Copy($sd.Scan0, $sbytes, 0, $slen)
$srcBmp.UnlockBits($sd)

$bx0 = 0; $by0 = 0; $bx1 = 0; $by1 = 0
[CircleCrop]::BBox($sbytes, $sw, $sh, $sd.Stride, $LumOn, [ref]$bx0, [ref]$by0, [ref]$bx1, [ref]$by1)
$bw = $bx1 - $bx0 + 1; $bh = $by1 - $by0 + 1
$cx = [int](($bx0 + $bx1) / 2); $cy = [int](($by0 + $by1) / 2)

# 正方形边长：横向通常比纵向宽（横版图），取大者并往外扩一点，
# 保证圆左右不被切、上下留一点余量
$side = [Math]::Max($bw, $bh)
$pad = [int]($side * 0.02)
$side = $side + 2 * $pad
if ($side -gt [Math]::Min($sw, $sh)) { $side = [Math]::Min($sw, $sh) }
"源图 {0}x{1}，标志包围盒 {2}x{3} at ({4},{5})，取正方形边长 {6}" -f $sw, $sh, $bw, $bh, $bx0, $by0, $side

# ── 2. 缩放进正方形画布 ──
$work = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$wg = [System.Drawing.Graphics]::FromImage($work)
$wg.Clear([System.Drawing.Color]::FromArgb(0, 0, 0))
$wg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$wg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$wg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 裁口与原图求交：越界的部分（横版图上下留白少）保持透明
$cropX = $cx - [int]($side / 2); $cropY = $cy - [int]($side / 2)
$ix0 = [Math]::Max($cropX, 0); $iy0 = [Math]::Max($cropY, 0)
$ix1 = [Math]::Min($cropX + $side, $sw); $iy1 = [Math]::Min($cropY + $side, $sh)
if ($ix1 -gt $ix0 -and $iy1 -gt $iy0) {
  $iw = $ix1 - $ix0
  $ih = $iy1 - $iy0
  $srcRect = New-Object System.Drawing.Rectangle($ix0, $iy0, $iw, $ih)
  $k = $Size / [double]$side
  $dx = [int][math]::Floor(($ix0 - $cropX) * $k)
  $dy = [int][math]::Floor(($iy0 - $cropY) * $k)
  $dw = [int][math]::Ceiling($iw * $k)
  $dh = [int][math]::Ceiling($ih * $k)
  $wg.DrawImage($srcBmp, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)), $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
}
$wg.Dispose()

# ── 3. 量出紫圈的真实外沿 ──
# 紫圈本身亮度稳定在 52，圈外还有一圈很暗的辉光（lum≈31），再往外才是纯黑底。
# 用 DiscLum（45，取两者中线）量出来的就是紫圈外沿。这个半径同时用作两处：
# 裁圆的边界，和「暗部提白」的作用范围。
# 不给提白加范围，那圈暗辉光会被一起染白，等于给紫圈描一道白边；
# 而裁圆若按画布 99% 裁，紫圈外沿到裁口之间会留下一圈不透明的黑。
$rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
$probe = $work.Clone($rect, $work.PixelFormat)
$dx0 = 0; $dy0 = 0; $dx1 = 0; $dy1 = 0
$pd = $probe.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $probe.PixelFormat)
$plen = $pd.Stride * $Size
$pbytes = New-Object byte[] $plen
[System.Runtime.InteropServices.Marshal]::Copy($pd.Scan0, $pbytes, 0, $plen)
[CircleCrop]::BBox($pbytes, $Size, $Size, $pd.Stride, $DiscLum, [ref]$dx0, [ref]$dy0, [ref]$dx1, [ref]$dy1)
$probe.UnlockBits($pd)
$probe.Dispose()
$half = $Size / 2.0
$discR = [Math]::Max($dx1 - $dx0, $dy1 - $dy0) / 2.0
$clipRatio = $discR / $half
"紫圈外沿: {0:N0}px（画布半边 {1:N0}px，占 {2:N0}%）" -f $discR, $half, (100.0 * $clipRatio)

# ── 4. 裁成正圆 + 暗部提白 ──
$d = $work.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, $work.PixelFormat)
$len = $d.Stride * $Size
$bytes = New-Object byte[] $len
[System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $len)
[CircleCrop]::CircleClip($bytes, $Size, $Size, $d.Stride, $clipRatio)
if ($DarkCut -gt 0) {
  [CircleCrop]::DarkToWhite($bytes, $Size, $Size, $d.Stride, $DarkCut, $clipRatio)
  "  暗部（lum<{0}）已换成白色，范围 r<{1:N0}px" -f $DarkCut, $discR
}
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $d.Scan0, $len)
$work.UnlockBits($d)

$work.Save("$OutDir\logo-icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$work.Dispose()
"logo-icon.png  {0:N1} KB  {1}x{1}" -f ((Get-Item -LiteralPath "$OutDir\logo-icon.png").Length / 1KB), $Size

$srcImg.Dispose(); $srcBmp.Dispose()
