# 打一个「解释器 + 全部后端依赖」自带的 Python 运行时，随安装包一起发。
#
# 为什么要这个：以前安装包里只装了 backend/*.py，跑起来得去用户机器上现找
# Anaconda。别人的机器没装 linearmodels / matplotlib / pyreadstat，程序根本
# 打不开。现在把一份完整的 Python 连同依赖塞进 resources/python-runtime，
# 主进程优先用它，找不到才退回用户自己的环境（STATA_PYTHON 依然能覆盖）。
#
# 用的是嵌入式发行版（embed zip，约 11MB）：没有安装程序、不写注册表、整个
# 目录原样拷到哪儿都能跑 —— 装机包要的正是这个。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File desktop\build\make_pyruntime.ps1
#   powershell -File desktop\build\make_pyruntime.ps1 -Version 3.12.8 -OutDir C:\tmp\rt
#
# 产物在 desktop/python-runtime/，已写进 .gitignore，不进版本库。
# 需要联网：拉 python.org 的 zip，以及 PyPI 的包。
param(
  [string]$Version  = '3.13.9',   # 要和 backend/requirements.txt 的开发环境同代
  [string]$OutDir   = '',         # 默认 desktop/python-runtime
  [string]$Req      = '',         # 默认 build/requirements-runtime.txt
  [string]$IndexUrl = 'https://pypi.tuna.tsinghua.edu.cn/simple',
  [string]$Mirror   = 'https://registry.npmmirror.com/-/binary/python',
  [string]$CacheDir = '',         # 默认 build/.pyruntime-cache
  [string[]]$Extras = @('DoubleML'),  # 没有 Windows wheel 的包，装不上只警告
  [switch]$NoPyCache             # 删掉 __pycache__，能省几十 MB，但每次启动要重新编译
)
$ErrorActionPreference = 'Stop'

$desktop = Split-Path $PSScriptRoot -Parent
if (-not $OutDir)   { $OutDir   = Join-Path $desktop 'python-runtime' }
if (-not $Req)      { $Req      = Join-Path $PSScriptRoot 'requirements-runtime.txt' }
if (-not $CacheDir) { $CacheDir = Join-Path $PSScriptRoot '.pyruntime-cache' }

# [IO.Path]::GetFullPath 不要求路径已经存在，比 Get-Item 安全——不会因为
# 手滑打错一个目录名就把东西写到一个凭空出现的 phantom 目录里去
$OutDir   = [IO.Path]::GetFullPath($OutDir)
$Req      = [IO.Path]::GetFullPath($Req)
$CacheDir = [IO.Path]::GetFullPath($CacheDir)

# $PthName 等解压完再认，见第 3 步
$Py = Join-Path $OutDir 'python.exe'

if (-not (Test-Path -LiteralPath $Req)) { throw "找不到依赖清单：$Req" }
if (-not (Test-Path -LiteralPath $CacheDir)) {
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
}

$ZipName = "python-$Version-embed-amd64.zip"
$Zip     = Join-Path $CacheDir $ZipName

# ── 1. 下载嵌入式 Python ──
if (-not (Test-Path -LiteralPath $Zip)) {
  $url = "$Mirror/$Version/$ZipName"
  "下载 $url"
  Invoke-WebRequest -Uri $url -OutFile $Zip -TimeoutSec 300
}
"解释器 zip : {0:N1} MB（{1}）" -f ((Get-Item -LiteralPath $Zip).Length / 1MB), $ZipName

# ── 2. 解压。先确认要覆盖的目录确实是自己生成的东西 ──
if (Test-Path -LiteralPath $OutDir) {
  $empty = -not (Get-ChildItem -LiteralPath $OutDir -Force)
  $isPy  = Test-Path -LiteralPath (Join-Path $OutDir 'python.exe')
  if (-not ($empty -or $isPy)) {
    throw "输出目录里已经有别的东西且不像 Python 运行时，拒绝覆盖：$OutDir"
  }
  [IO.Directory]::Delete($OutDir, $true)
  "已清空旧的 $OutDir"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $OutDir -Force

# ── 3. 打开 site-packages ──
# 嵌入式发行版默认只认 python313.zip 和当前目录，而且 site.main() 是注释掉的，
# 所以装不进去包。 python<版本>._pth 就是干这个的：列进来的路径全部进 sys.path，
# 而且一旦写了这个文件，Python 会连注册表和 PYTHONPATH 一起忽略 —— 运行时跟着
# 安装包走，不受用户机器上其他 Python 的影响，这正是要的隔离。
#
# 文件名千万别按版本号去拼：CPython 用的是「主+次」版本（3.13 → 313），
# 拿 "3.13.9" 去掉点会得到 3139，写出来的文件 Python 根本不读，于是标准库
# 都加载不了，后面每一步都是 "No module named ..." 这种没头绪的错。
# 直接从解出来的文件里认这个名字最稳。
$pthFiles = Get-ChildItem -LiteralPath $OutDir -Filter 'python*._pth'
if ($pthFiles.Count -ne 1) {
  throw "嵌入式发行包里 python*._pth 没找到或有多个：" + ($pthFiles.Name -join ', ')
}
$PthName = $pthFiles[0].Name

# 还要知道解释器版本，用来在 ._pth 里指向它自带的 stdlib zip
$stdZip = (Get-ChildItem -LiteralPath $OutDir -Filter 'python*.zip' |
           Where-Object { $_.Name -like 'python3*' }).Name

# 必须用无 BOM 的 UTF-8：第一行前面多一个 BOM，Python 会把 "python313.zip"
# 读成别的名字，整个标准库都找不到，报错是那句很没头绪的
# "No module named 'encodings'"
$pthText = "$stdZip`n.`nLib/site-packages`nimport site`n"
[IO.File]::WriteAllText((Join-Path $OutDir $PthName), $pthText,
                        (New-Object System.Text.UTF8Encoding($false)))
$readBack = [IO.File]::ReadAllText((Join-Path $OutDir $PthName))
if ($readBack -ne $pthText) { throw "$PthName 写坏了，读回来和原文不一致" }
"  $PthName 已写入：启用 Lib/site-packages"

# ── 4. 引导 pip ──
# 嵌入式发行版不带 ensurepip，得先跑 get-pip.py。
# 这一步必须看退出码：装 pip 失败不拦，后面每一步都会变成 "No module named pip"，
# 而看着像 pip 的问题，其实是解释器起不来
# 跑原生命令（python.exe / pip）。退出码放在 $script:RC 里，函数本身不回传值。
#
# 为什么不 return 退出码：PowerShell 函数会把执行期间流经管道的**所有输出**
# 一起 return。pip 自己往 stdout 打一堆进度，混进来退出码就变成了一个数组，
# `if ($rc -ne 0)` 拿数组比大小，报出来的错完全看不出所以然。
#
# 另外也不能靠看有没有报错判断成败：PowerShell 5.1 会把原生命令写进 stderr 的
# 每一行都包成一个 ErrorRecord，本脚本 $ErrorActionPreference 是 Stop —— 于是
# pip 一句「script xxx.exe 装好了但不在 PATH 上」的**警告**就能把脚本掀翻。
# 装 DoubleML 时就是这么死的：依赖全装完，一句 plotly 的警告让脚本终止在第 6 步，
# 后面的模块校验和瘦身全没执行。stderr 有警告不等于失败，退出码才是准的。
$script:RC = 1
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string[]]$Args
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Args
  } finally {
    $ErrorActionPreference = $prev
  }
  $script:RC = $LASTEXITCODE
}

$getPip = Join-Path $OutDir 'get-pip.py'
if (-not (Test-Path -LiteralPath $getPip)) {
  Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -TimeoutSec 180
}
Invoke-Native $Py @($getPip, '--no-warn-script-location')
if ($script:RC -ne 0) { throw "引导 pip 失败（exit $script:RC）" }
# 光装完不算完，得确认 import 得到。之前栽过一次：._pth 名字写错，get-pip 看着
# 像成功了，实际 pip 装到了别处，后面每一步都是 No module named pip
Invoke-Native $Py @('-m', 'pip', '--version')
if ($script:RC -ne 0) { throw "pip 装上还是不能用（exit $script:RC）" }
"  pip 可用"

# ── 5. 装依赖 ──
$t0 = Get-Date
Invoke-Native $Py @('-m', 'pip', 'install', '--disable-pip-version-check',
                    '--index-url', $IndexUrl, '-r', $Req)
if ($script:RC -ne 0) { throw "装依赖失败（exit $script:RC）" }
"依赖装完，用了 {0:N0} 秒" -f ((Get-Date) - $t0).TotalSeconds

# ── 6. 没有 Windows wheel 的包，能装则装，装不上就降级 ──
foreach ($x in $Extras) {
  Invoke-Native $Py @('-m', 'pip', 'install', '--disable-pip-version-check',
                      '--index-url', $IndexUrl, $x)
  if ($script:RC -eq 0) {
    "  额外装上 $x"
  } else {
    "  跳过 $x：PyPI 上没有 Windows 预编译包，源码编译失败（DML 那条分支会提示未安装）"
  }
}

# get-pip.py 用完就没用了，2MB 也是肉
[IO.File]::Delete($getPip)

# ── 7. 逐模块验一遍。装完不验，等于把问题留到用户机器上 ──
$check = @(
  'numpy', 'pandas', 'scipy', 'statsmodels', 'linearmodels', 'matplotlib', 'pydantic',
  'fastapi', 'uvicorn', 'openpyxl', 'xlrd', 'pyreadstat', 'docx', 'fitz', 'pdfplumber',
  'sklearn', 'lightgbm', 'bs4', 'httpx', 'requests', 'statspai'
)
$bad = @()
foreach ($m in $check) {
  Invoke-Native $Py @('-c', "import $m")
  if ($script:RC -ne 0) { $bad += $m }
}
if ($bad.Count) { throw "这些模块 import 失败：$($bad -join ', ')" }
"  {0} 个模块全部 import 通过" -f $check.Count

# ── 8. 瘦身 ──
# test 套件：numpy / scipy / pandas / statsmodels 每个都带几 MB 到十几 MB 的
# tests/，运行时一个都不加载，纯占地方。递归找，因为 numpy、statsmodels 是
# numpy/tests、statsmodels/iola/tests 这种嵌套的
$sp = Join-Path $OutDir 'Lib\site-packages'
$trim = Get-ChildItem -LiteralPath $sp -Recurse -Directory -Filter 'tests' -Force -EA SilentlyContinue
foreach ($d in $trim) {
  [IO.Directory]::Delete($d.FullName, $true)
}
"  删掉 {0} 个 tests 目录" -f $trim.Count

# 调试符号：编译 wheel 时带的 .lib / .exp / .pdb，运行时一行代码都不碰
$libs = Get-ChildItem -LiteralPath $OutDir -Recurse -File -Force -EA SilentlyContinue |
        Where-Object { $_.Extension -in '.lib', '.exp', '.pdb' }
foreach ($f in $libs) { [IO.File]::Delete($f.FullName) }
"  删掉 {0} 个调试符号" -f $libs.Count

# 嵌入式发行版自带的 idle/Tcl 之类
foreach ($d in @('Lib\test', 'Tools')) {
  $p = Join-Path $OutDir $d
  if (Test-Path -LiteralPath $p) {
    [IO.Directory]::Delete($p, $true)
    "  删掉 $d"
  }
}

# __pycache__ 默认留着。量过：不留的话首次启动多花约 7 秒去编译，而程序装在
# C:\Program Files 下那个目录默认是只读的（Windows 只给 Users 读和执行，
# 就算以管理员身份跑也不让写），意味着每次都重编译，每次慢 7 秒。
# 所以省这 200MB 不划算，把开关留给需要的人：
#   -NoPyCache 只适合 portable 版（解压到用户自己的目录，写了就能缓存住）
if ($NoPyCache) {
  $n = 0
  Get-ChildItem -LiteralPath $sp -Recurse -Directory -Filter '__pycache__' -Force -EA SilentlyContinue |
    ForEach-Object { [IO.Directory]::Delete($_.FullName, $true); $n++ }
  "  删掉 {0} 个 __pycache__（启动会变慢，见上面注释）" -f $n
}

# ── 9. 报体积 ──
$files = Get-ChildItem -LiteralPath $OutDir -Recurse -File -Force
$total = ($files | Measure-Object -Property Length -Sum).Sum
""
"运行时就绪：$OutDir"
"  合计 {0:N1} MB，{1:N0} 个文件" -f ($total / 1MB), $files.Count
"  最大的几处："
Get-ChildItem -LiteralPath $OutDir -Recurse -Directory -Force |
  ForEach-Object {
    $s = ((Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force |
           Measure-Object -Property Length -Sum).Sum)
    [pscustomobject]@{ Path = $_.FullName.Substring($OutDir.Length + 1); MB = [math]::Round($s / 1MB, 1) }
  } | Sort-Object MB -Descending | Select-Object -First 8 |
  ForEach-Object { "    {0,7:N1} MB  {1}" -f $_.MB, $_.Path }
