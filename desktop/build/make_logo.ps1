# 从原始大图生成「镂空」logo。
#
# 原图是 3840×2160 的横版图（紫圈 + 白柱），要先按标志的包围盒裁成正方形。
# 「镂空」= 只保留图形的外壁，内部掏空透明，这样放在深色侧边栏上能透出底色，
#   不会像实心图标那样糊成一团。壁厚靠形态学腐蚀（min 滤波）保证均匀——
#   直接缩小内层再相减会让圆环很粗、柱子很细，粗细不一致。
#
# 腐蚀是逐像素重活，用 Add-Type 现场编一段 C# 跑（PowerShell 循环慢 2~3 个数量级）。
#
# 产出：logo-mark.png（镂空、透明底）、logo-tile.png（镂空 + 深色圆角底，给 .ico 用）
# 用法：powershell -File make_logo.ps1 -Source <原图> -OutDir <输出目录>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Size = 1024,     # 工作分辨率：越大越锐利（侧边栏 52px / 启动页 200px / ico 最大 256px）
  [int]$Erode = 36,      # 腐蚀半径 = 镂空壁厚。壁厚最多到「最细笔画宽度的一半」，
                         # 再细的笔画（折线）会整条被腐蚀掉、退回实心，这是正常结果
  [string]$DumpDir = ''  # 给了就把镂空前的裁切图存到这里（调试用）
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
public static class ImgUtil {
  // 取亮度高于阈值的像素的包围盒
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

  // 就地镂空：二值掩码（亮度 >= lumOn）→ 均匀腐蚀 radius → 两者之差即外壁；
  // 最后对外壁 alpha 做 3x3 均值柔化，避免放大后锯齿明显
  public static void Hollow(byte[] px, int w, int h, int stride, double lumOn, int radius) {
    byte[] o = new byte[w * h];
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x < w; x++) {
        int i = row + x * 4;
        double lum = 0.299 * px[i + 2] + 0.587 * px[i + 1] + 0.114 * px[i];
        o[y * w + x] = (lum >= lumOn) ? (byte)255 : (byte)0;
      }
    }
    // 可分离 min 滤波（横、纵各用独立数组，避免原地写导致单向半径翻倍）
    byte[] t = new byte[o.Length];
    byte[] e = new byte[o.Length];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        byte m = 255;
        for (int k = -radius; k <= radius; k++) {
          int xx = x + k; if (xx < 0 || xx >= w) continue;
          byte v = o[y * w + xx]; if (v < m) m = v;
        }
        t[y * w + x] = m;
      }
    }
    for (int x = 0; x < w; x++) {
      for (int y = 0; y < h; y++) {
        byte m = 255;
        for (int k = -radius; k <= radius; k++) {
          int yy = y + k; if (yy < 0 || yy >= h) continue;
          byte v = t[yy * w + x]; if (v < m) m = v;
        }
        e[y * w + x] = m;
      }
    }
    // 外壁（二值）
    byte[] s = new byte[w * h];
    for (int k = 0; k < s.Length; k++) s[k] = (byte)(o[k] - e[k]);
    // 3x3 均值柔化
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int sum = 0, n = 0;
        for (int dy = -1; dy <= 1; dy++) {
          int yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (int dx = -1; dx <= 1; dx++) {
            int xx = x + dx; if (xx < 0 || xx >= w) continue;
            sum += s[yy * w + xx]; n++;
          }
        }
        int a = sum / n;
        int i = y * stride + x * 4;
        if (a < 8) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0; }
        else px[i + 3] = (byte)a;
      }
    }
  }
}
'@

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# ── 1. 读原图，按标志包围盒裁正方形 ──
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
[ImgUtil]::BBox($sbytes, $sw, $sh, $sd.Stride, 55, [ref]$bx0, [ref]$by0, [ref]$bx1, [ref]$by1)
$bw = $bx1 - $bx0 + 1; $bh = $by1 - $by0 + 1
$side = [Math]::Max($bw, $bh)
$cx = [int](($bx0 + $bx1) / 2); $cy = [int](($by0 + $by1) / 2)
"标志包围盒: {0}x{1} at ({2},{3})  取正方形边长 {4}（原图 {5}x{6}）" -f $bw, $bh, $bx0, $by0, $side, $sw, $sh

# 正方形裁口可能越界（原图顶/底边距小），越界部分填黑——黑底在镂空阈值以下，不影响
$cropX = $cx - [int]($side / 2); $cropY = $cy - [int]($side / 2)
$work = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$wg = [System.Drawing.Graphics]::FromImage($work)
$wg.Clear([System.Drawing.Color]::FromArgb(0, 0, 0))
$wg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$wg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$wg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 把裁口与原图求交，交到的区域才画，没交到的地方保持黑底
$ix0 = [Math]::Max($cropX, 0); $iy0 = [Math]::Max($cropY, 0)
$ix1 = [Math]::Min($cropX + $side, $sw); $iy1 = [Math]::Min($cropY + $side, $sh)
if ($ix1 -gt $ix0 -and $iy1 -gt $iy0) {
  # 注意：PowerShell 会把 New-Object 参数表里的 `-` 当成参数名，减法必须先落到变量上
  $iw = $ix1 - $ix0
  $ih = $iy1 - $iy0
  $srcRect = New-Object System.Drawing.Rectangle($ix0, $iy0, $iw, $ih)
  $k = $Size / [double]$side
  $dx = [int][math]::Floor(($ix0 - $cropX) * $k)
  $dy = [int][math]::Floor(($iy0 - $cropY) * $k)
  $dw = [int][math]::Ceiling($iw * $k)
  $dh = [int][math]::Ceiling($ih * $k)
  $dstRect = New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)
  $wg.DrawImage($srcBmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
}
$wg.Dispose()

# ── 2. 镂空 ──
$wrect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
if ($DumpDir) {
  if (-not (Test-Path -LiteralPath $DumpDir)) { New-Item -ItemType Directory -Force -Path $DumpDir | Out-Null }
  $work.Save("$DumpDir\_crop.png", [System.Drawing.Imaging.ImageFormat]::Png)
}
$wd = $work.LockBits($wrect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, $work.PixelFormat)
$wlen = $wd.Stride * $Size
$wbytes = New-Object byte[] $wlen
[System.Runtime.InteropServices.Marshal]::Copy($wd.Scan0, $wbytes, 0, $wlen)
Write-Output ("  hollow: size={0} erode={1} lumOn=55" -f $Size, $Erode)
[ImgUtil]::Hollow($wbytes, $Size, $Size, $wd.Stride, 55, $Erode)
[System.Runtime.InteropServices.Marshal]::Copy($wbytes, 0, $wd.Scan0, $wlen)
$work.UnlockBits($wd)

$work.Save("$OutDir\logo-mark.png", [System.Drawing.Imaging.ImageFormat]::Png)
$work.Dispose()
"  logo-mark.png   镂空图形（透明底）"

# ── 3. 深色圆角底板版（.ico 用：要经得起白/黑任务栏和 16px 小尺寸）──
$INSET = 0.80
$RADIUS = 0.235
$tile = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$tg = [System.Drawing.Graphics]::FromImage($tile)
$tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$tr = [int]($Size * $RADIUS)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $tr * 2, $tr * 2, 180, 90)
$path.AddArc($Size - $tr * 2, 0, $tr * 2, $tr * 2, 270, 90)
$path.AddArc($Size - $tr * 2, $Size - $tr * 2, $tr * 2, $tr * 2, 0, 90)
$path.AddArc(0, $Size - $tr * 2, $tr * 2, $tr * 2, 90, 90)
$path.CloseFigure()
$pg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF([float]$Size, [float]$Size)),
  [System.Drawing.Color]::FromArgb(255, 74, 32, 148),      # 中心紫
  [System.Drawing.Color]::FromArgb(255, 8, 6, 16))         # 边角近黑
$tg.FillPath($pg, $path)
$pg.Dispose(); $path.Dispose()

$mark = [System.Drawing.Image]::FromFile("$OutDir\logo-mark.png")
$pad = [int]($Size * (1 - $INSET) / 2)
$mw = $Size - $pad * 2
$tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$tg.DrawImage($mark, (New-Object System.Drawing.Rectangle($pad, $pad, $mw, $mw)))
$tg.Dispose()
$tile.Save("$OutDir\logo-tile.png", [System.Drawing.Imaging.ImageFormat]::Png)
$mark.Dispose(); $tile.Dispose()
"  logo-tile.png   镂空 + 深色圆角底"

$srcImg.Dispose(); $srcBmp.Dispose()

Get-ChildItem -LiteralPath $OutDir -Filter 'logo-*.png' |
  ForEach-Object { "  {0,-18} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB) }
