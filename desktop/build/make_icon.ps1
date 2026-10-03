$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$logo = $args[0]; $out = $args[1]
$sizes = 256,128,64,48,32,16
$src = [System.Drawing.Image]::FromFile($logo)
$pngs = New-Object System.Collections.Generic.List[byte[]]
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $pngs.Add($ms.ToArray()); $ms.Dispose()
}
$src.Dispose()
$msAll = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($msAll)
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $pngs.Count; $i++) {
  $d = $pngs[$i]; $px = $sizes[$i]
  $b = if ($px -ge 256) { 0 } else { $px }
  $w.Write([Byte]$b); $w.Write([Byte]$b); $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$d.Length); $w.Write([UInt32]$offset); $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write($d) }
$w.Flush()
[IO.File]::WriteAllBytes($out, $msAll.ToArray()); $w.Close()
"icon: $out  ({0:N1} KB, {1} sizes)" -f ((Get-Item -LiteralPath $out).Length/1KB), $sizes.Count