# 从原始大图生成应用图标。
#
# 原图是 3840×2160 的横版图（紫圈 + 白柱折线）。三步：
#   1. 按包围盒裁正方形，外围留一点白容纳原图自带的柔光
#   2. Recolor 重新上色——关键一步。原图被压得又暗又闷：紫圈是纯色 (77,21,148)
#      （亮度才 52），圈内是纯黑。原样贴到深色侧边栏上，圈和底色糊成一片。
#      这里按饱和度把像素分成白/紫两类，按亮度给 alpha：偏白的（柱/折线）→ 纯白，
#      偏紫的（圈+柔光）→ 品牌紫且暗处半透明，于是柔光变成一圈真正的辉光
#   3. 垫一块深紫圆盘当底，图标才有「体」；浅色任务栏、16px 小尺寸也都撑得住
#
# 附带给一个镂空版（只留外壁、内部掏空），需要的话可以自己换。
#
# 用法：powershell -File make_logo.ps1 -Source <原图> -OutDir <输出目录>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Size = 1024,     # 工作分辨率：越大越锐利（侧边栏 52px / 启动页 200px / ico 最大 256px）
  [int]$Thin = 22,         # 把紫圈磨细多少像素（只动紫像素，白柱白线不动）
  [string]$DumpDir = '',  # 给了就把镂空前的裁切图存到这里（调试用）
  [double]$Pad = 0.05      # 裁切时在标志外围留的白，用来容纳原图自带的柔光
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
  // 取「图形」的最远半径：以画面中心为圆心，找 lum >= lumOn 的像素离中心的最大距离
  public static double Radius(byte[] px, int w, int h, int stride, double lumOn) {
    double cx = (w - 1) / 2.0, cy = (h - 1) / 2.0;
    double best = 0;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int i = y * stride + x * 4;
        double lum = 0.299 * px[i + 2] + 0.587 * px[i + 1] + 0.114 * px[i];
        if (lum < lumOn) continue;
        double dx = x - cx, dy = y - cy;
        double d = Math.Sqrt(dx * dx + dy * dy);
        if (d > best) best = d;
      }
    }
    return best;
  }

  // 重新上色——这是「效果好不好」的关键一步。
  // 原图的紫圈是纯色 (77,21,148)，亮度只有 52，圈内是纯黑。亮度直接当 alpha 用，
  // 圈会淡得看不见；把整片外圈柔光也算进去，圈又会糊成一坨。所以白/紫各给一条
  // 独立的 alpha 曲线：
  //   紫圈：lum 36→52 升到全不透明，柔光（更暗）整段切掉，只留干净的一道边
  //   白柱/折线：lum 90→255 线性升起，正好是标准抗锯齿该有的覆盖率
  // 颜色按「饱和度」分流：偏白的走白色，其余走品牌紫。
  public static void Recolor(byte[] px, int w, int h, int stride,
                             double vt0, double vt1, int vr, int vg, int vb,
                             double wt0, double wt1, int wr, int wg, int wb) {
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x < w; x++) {
        int i = row + x * 4;
        int R = px[i + 2], G = px[i + 1], B = px[i];
        double lum = 0.299 * R + 0.587 * G + 0.114 * B;
        int mx = Math.Max(R, Math.Max(G, B));
        int mn = Math.Min(R, Math.Min(G, B));
        double sat = mx > 0 ? (mx - mn) / (double)mx : 0;
        double a;
        int cr, cg, cb;
        if (sat < 0.25) {                       // 白：柱、折线、圆点
          cr = wr; cg = wg; cb = wb;
          a = (lum - wt0) / (wt1 - wt0);
        } else {                                // 紫：圈
          cr = vr; cg = vg; cb = vb;
          a = (lum - vt0) / (vt1 - vt0);
        }
        if (a <= 0) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0; continue; }
        if (a > 1) a = 1;
        px[i] = (byte)cb; px[i + 1] = (byte)cg; px[i + 2] = (byte)cr;
        px[i + 3] = (byte)Math.Round(a * 255.0);
      }
    }
  }
  // 径向渐变圆盘：中心 c1 → 边缘 c2，圆外透明。给图标当「底」，撑住浅色背景和小尺寸
  // 注意：GDI+ 32bppArgb 的内存布局是 BGRA——蓝在第一个字节。写反了不会报错，
  // 只会把深紫 (61,34,120) 变成暗红 (120,34,61)，中间糊成一坨猪肝色，很难查。
  public static void Disc(byte[] px, int w, int h, int stride,
                          int r1, int g1, int b1, int r2, int g2, int b2, double radiusRatio) {
    double cx = (w - 1) / 2.0, cy = (h - 1) / 2.0;
    double R = Math.Min(w, h) * 0.5 * radiusRatio;
    double feather = 3.0;
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        double dx = x - cx, dy = y - cy;
        double d = Math.Sqrt(dx * dx + dy * dy);
        int i = y * stride + x * 4;
        if (d > R) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0; continue; }
        double t = d / R; if (t > 1) t = 1;
        px[i] = (byte)Math.Round(b1 + (b2 - b1) * t);   // B
        px[i + 1] = (byte)Math.Round(g1 + (g2 - g1) * t); // G
        px[i + 2] = (byte)Math.Round(r1 + (r2 - r1) * t); // R
        px[i + 3] = (byte)(d > R - feather ? Math.Round(255.0 * (R - d) / feather) : 255);
      }
    }
  }

  // 把「紫圈」磨细：只对紫像素（白柱白线不受影响）做腐蚀，
  // 被腐蚀掉的那圈清成透明。腐蚀是均匀的，所以圈的内外两边同时内收，
  // 圈变细，同时圈和柱子之间的空隙还会变大一点。
  public static void ThinViolet(byte[] px, int w, int h, int stride, int radius) {
    byte[] m = new byte[w * h];          // 紫像素（不透明核心）
    for (int y = 0; y < h; y++) {
      int row = y * stride;
      for (int x = 0; x < w; x++) {
        int i = row + x * 4;
        if (px[i + 3] < 128) continue;
        int R = px[i + 2], G = px[i + 1], B = px[i];
        int mx = Math.Max(R, Math.Max(G, B));
        int mn = Math.Min(R, Math.Min(G, B));
        double sat = mx > 0 ? (mx - mn) / (double)mx : 0;
        if (sat >= 0.25) m[y * w + x] = 255;   // 紫
      }
    }
    if (radius <= 0) return;
    byte[] t = new byte[m.Length];
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) {
        byte mn = 255;
        for (int k = -radius; k <= radius; k++) {
          int xx = x + k; if (xx < 0 || xx >= w) continue;
          if (m[y * w + xx] < mn) mn = m[y * w + xx];
        }
        t[y * w + x] = mn;
      }
    for (int x = 0; x < w; x++)
      for (int y = 0; y < h; y++) {
        byte mn = 255;
        for (int k = -radius; k <= radius; k++) {
          int yy = y + k; if (yy < 0 || yy >= h) continue;
          if (t[yy * w + x] < mn) mn = t[yy * w + x];
        }
        if (mn == 0 && m[y * w + x] == 255) {
          int i = y * stride + x * 4;   // 原本是紫、腐蚀后不是了 → 抠掉
          px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
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
$cx = [int](($bx0 + $bx1) / 2); $cy = [int](($by0 + $by1) / 2)
$pad = [int]($Pad * [Math]::Max($bw, $bh))
$side = [Math]::Max($bw, $bh) + 2 * $pad
"标志包围盒: {0}x{1} at ({2},{3})  加 {4}px 留白后取正方形边长 {5}（原图 {6}x{7}）" -f `
  $bw, $bh, $bx0, $by0, $pad, $side, $sw, $sh

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

# ── 2. 量出圈的半径，然后重新上色 ──
$cloneRect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
$wrect = $cloneRect

# 对一张 bitmap 就地执行 C# 像素操作
function Invoke-Pixels($bmp, [scriptblock]$op) {
  $r = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
  $d = $bmp.LockBits($r, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, $bmp.PixelFormat)
  $len = $d.Stride * $bmp.Height
  $bytes = New-Object byte[] $len
  [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $len)
  & $op $bmp.Width $bmp.Height $d.Stride $bytes
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $d.Scan0, $len)
  $bmp.UnlockBits($d)
}

# 圈的外半径：以中心为圆心，找亮度 >= 48 的像素（也就是圈的实心本体）离中心最远的距离
$probe = $work.Clone($cloneRect, $work.PixelFormat)
$ringR = 0
Invoke-Pixels $probe { param($w, $h, $s, $b) $script:ringR = [ImgUtil]::Radius($b, $w, $h, $s, 48) }
$probe.Dispose()
$half = $Size / 2.0
"圈外半径: {0:N0}px（画布半边 {1:N0}px，占 {2:N0}%）" -f $ringR, $half, (100.0 * $ringR / $half)

# 重新上色：白→纯白，紫→深品牌紫，#7C3AED（比之前的浅薰衣草深，色相 258° 是正紫）
Invoke-Pixels $work { param($w, $h, $s, $b) [ImgUtil]::Recolor($b, $w, $h, $s, 36, 52, 124, 58, 237, 90, 255, 255, 255, 255) }

# 圈磨细（只动紫像素，白柱白线不动）
if ($Thin -gt 0) {
  Invoke-Pixels $work { param($w, $h, $s, $b) [ImgUtil]::ThinViolet($b, $w, $h, $s, $Thin) }
  "  圈磨细: {0}px（原 142px 左右）" -f $Thin
}

# 侧边栏/启动页用：中间掏空，透明底，让后面的底色透出来
$work.Save("$OutDir\logo-icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
"  logo-icon.png   圈磨细 + 中间镂空（侧边栏 52px / 启动页 200px 用它）"

# .ico 用：垫一块深紫圆盘当底。透明图标贴到白色任务栏上，白柱子会消失
$disc = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$ratio = $ringR / $half
Invoke-Pixels $disc { param($w, $h, $s, $b) [ImgUtil]::Disc($b, $w, $h, $s, 53, 25, 107, 12, 10, 30, $script:ratio) }
$dg = [System.Drawing.Graphics]::FromImage($disc)
$dg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$dg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$dg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$dg.DrawImage($work, $cloneRect)
$dg.Dispose()
$disc.Save("$OutDir\logo-ico.png", [System.Drawing.Imaging.ImageFormat]::Png)
$disc.Dispose()
"  logo-ico.png   同款 + 深紫圆盘（.ico 用，浅色背景才撑得住）"

$work.Dispose()
$srcImg.Dispose(); $srcBmp.Dispose()

Get-ChildItem -LiteralPath $OutDir -Filter 'logo-*.png' |
  ForEach-Object { "  {0,-26} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB) }
