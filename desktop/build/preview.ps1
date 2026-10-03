# logo 预览拼图：把若干 logo-mark.png 以真实使用尺寸画到指定底色上，便于判断小尺寸清不清
# 用法：powershell -File preview.ps1 -Marks <png,png,...> -Labels <r16,r26> -Out <png> [-Bg 0f172a]
param(
  [Parameter(Mandatory = $true)][string[]]$Marks,
  [string[]]$Labels = @(),
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Bg = '0f172a',
  [int]$Big = 190,
  [int]$Small = 52
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if ($Marks.Count -eq 1 -and $Marks[0] -like '*,*') { $Marks = $Marks[0] -split ',' | ForEach-Object { $_.Trim() } }
if ($Labels.Count -eq 1 -and $Labels[0] -like '*,*') { $Labels = $Labels[0] -split ',' | ForEach-Object { $_.Trim() } }
$colW = 240
$w = 40 + $colW * $Marks.Count
$h = 60 + $Big + $Small + 90
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$bgc = [System.Drawing.Color]::FromArgb(255,
  [Convert]::ToInt32($Bg.Substring(0, 2), 16),
  [Convert]::ToInt32($Bg.Substring(2, 2), 16),
  [Convert]::ToInt32($Bg.Substring(4, 2), 16))
$g.Clear($bgc)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$font = New-Object System.Drawing.Font('Segoe UI', 11)
$brush = [System.Drawing.Brushes]::LightSteelBlue

for ($i = 0; $i -lt $Marks.Count; $i++) {
  $x = 20 + $colW * $i
  $m = [System.Drawing.Image]::FromFile($Marks[$i])
  $g.DrawImage($m, (New-Object System.Drawing.Rectangle($x, 30, $Big, $Big)))
  $smallX = $x + $Big - $Small
  $smallY = 30 + $Big + 24
  $g.DrawImage($m, (New-Object System.Drawing.Rectangle($smallX, $smallY, $Small, $Small)))
  $m.Dispose()
  $label = if ($i -lt $Labels.Count) { $Labels[$i] } else { (Split-Path $Marks[$i] -Leaf) }
  $g.DrawString($label, $font, $brush, [float]$x, [float]($h - 46))
}

$dir = Split-Path $Out -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved: $Out  ({0:N0} KB)  底色 #$Bg  大图 {1}px / 小图 {2}px" -f ((Get-Item -LiteralPath $Out).Length / 1KB), $Big, $Small
