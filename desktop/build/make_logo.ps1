# 从原始 logo 生成应用内使用的图标版本。
#
# 原始 PNG 是「黑色图形 + 透明背景」，在深色侧边栏和深色启动页上等于隐形，
# 所以这里做两件事：
#   1. 把黑色图形按亮度染成白色（保留抗锯齿边缘）
#   2. 再垫一层品牌渐变圆角底板，做成真正的应用图标
#
# 产出：logo-white.png（白图形、无底板）、logo-tile.png（渐变底板 + 白图形）
# 用法：powershell -File make_logo.ps1 -Source <原始png> -OutDir <输出目录>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$SIZE   = 512
$INSET  = 0.74    # 图形占底板的比例
$RADIUS = 0.235   # 圆角占边长的比例

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# ── 1. 读原图并缩放到目标尺寸 ──
$srcImg = [System.Drawing.Image]::FromFile($Source)

# ── 2. 染成白色图形（按亮度保留抗锯齿边缘）──
function New-Dyed($image, $size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.DrawImage($image, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.Dispose()

  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $px = $bmp.GetPixel($x, $y)
      if ($px.A -eq 0) { continue }
      $lum = (0.299 * $px.R + 0.587 * $px.G + 0.114 * $px.B) / 255.0
      if ($lum -gt 1) { $lum = 1 }
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(
          [int][math]::Round($px.A * $lum), [int][math]::Round(255 * $lum),
          [int][math]::Round(255 * $lum), [int][math]::Round(255 * $lum)))
    }
  }
  return $bmp
}

$white256 = New-Dyed $srcImg 256
$white256.Save("$OutDir\logo-white.png", [System.Drawing.Imaging.ImageFormat]::Png)
$white256.Dispose()
"  logo-white.png  白色图形（无底板）"

# ── 3. 渐变圆角底板 + 白色图形 = 应用图标 ──
try {
  $glyph = New-Dyed $srcImg $SIZE
  $tile = New-Object System.Drawing.Bitmap($SIZE, $SIZE, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $tg = [System.Drawing.Graphics]::FromImage($tile)
  $tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $r = [int]($SIZE * $RADIUS)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($SIZE - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($SIZE - $r * 2, $SIZE - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $SIZE - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()

  $ptA = New-Object System.Drawing.PointF(0, 0)
  $ptB = New-Object System.Drawing.PointF([float]$SIZE, [float]$SIZE)
  $cA = [System.Drawing.Color]::FromArgb(255, 99, 102, 241)    # #6366f1
  $cB = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)    # #8b5cf6
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($ptA, $ptB, $cA, $cB)
  $tg.FillPath($brush, $path)

  $pad = [int]($SIZE * (1 - $INSET) / 2)
  $w = $SIZE - $pad * 2
  $tg.DrawImage($glyph, (New-Object System.Drawing.Rectangle($pad, $pad, $w, $w)))
} catch {
  "CAUGHT at line {0}: {1}" -f $_.InvocationInfo.ScriptLineNumber, $_.Exception.Message
  "  STMT: $($_.InvocationInfo.Line.Trim())"
  "  SIZE=$($SIZE -is [array]) r=$($r -is [array]) pad=$($pad -is [array]) glyph=$($glyph -is [array]) tile=$($tile -is [array])"
  exit 1
}
$tg.Dispose()
$glyph.Dispose()
$tile.Save("$OutDir\logo-tile.png", [System.Drawing.Imaging.ImageFormat]::Png)
$tile.Dispose()
"  logo-tile.png   渐变底板 + 白图形"

$srcImg.Dispose()

Get-ChildItem -LiteralPath $OutDir -Filter 'logo-*.png' |
  ForEach-Object { "  {0,-18} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB) }
