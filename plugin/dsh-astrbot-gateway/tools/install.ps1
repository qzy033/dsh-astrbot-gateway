# 把 dsh-astrbot-gateway 挂进 dsh 的 profile（默认 web，可用 -ProfileDir 指到 desktop）。
#
# ⚠️ 本文件必须保存为 UTF-8 **带 BOM**。Windows PowerShell 5.1 对无 BOM 的 .ps1 会按
#    系统 ANSI（中文机器上是 GBK）解析，中文全部变乱码并直接语法报错。
#    用编辑器或脚本改完务必确认 BOM 还在（很多编辑工具会悄悄去掉它）。
#
# 默认 dry-run：只打印将要做什么，不改任何文件。
# 真正执行：  powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Apply
# 装到 DSH Desktop：  ... -File tools\install.ps1 -Apply -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
#
# 做了两件事：
#   1. 在 profile 里把本包登记为本地 file: 依赖（pnpm add）
#   2. 把 "dsh-astrbot-gateway" 追加进 profile package.json 的 dsh.profile.bundles
#
# 改 package.json 前会自动备份。可重复执行（幂等）。
#
# 不做什么（重要）：**绝不碰 profile 的 cordis.patch.yml**。本包是 bundle 插件，
# 靠 dsh.profile.bundles 挂载；若那里再手写一行同样的 insert，同一个 id 会出现
# 两次，DSH 启动直接抛 duplicate loader entry id 并进恢复模式。见下面第 0 步。

[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$ProfileDir = '',
    [string]$PluginDir = ''
)

$ErrorActionPreference = 'Stop'

# 注意：Windows PowerShell 5.1 里 $PSScriptRoot 在 param 默认值求值时还是空的，
# 所以路径必须在脚本体里再算。
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $PluginDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
}
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
}
$PkgName = 'dsh-astrbot-gateway'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Skip($msg) { Write-Host "    (跳过) $msg" -ForegroundColor DarkGray }

Write-Host "profile : $ProfileDir"
Write-Host "plugin  : $PluginDir"
Write-Host "apply   : $Apply"
Write-Host ''

# ── 前置检查 ──────────────────────────────────────────────────────────────
if (-not (Test-Path $ProfileDir)) { throw "profile 目录不存在: $ProfileDir" }
$profilePkg = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $profilePkg)) { throw "profile package.json 不存在: $profilePkg" }
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
    throw "插件 package.json 不存在: $PluginDir"
}
if (-not (Test-Path (Join-Path $PluginDir 'cordis.patch.yml'))) {
    throw "插件缺少 cordis.patch.yml: $PluginDir"
}
if (-not (Test-Path (Join-Path $PluginDir 'lib\index.js'))) {
    throw "插件缺少 lib\index.js: $PluginDir"
}

# ── 0. 防重复行：profile 自己的 cordis.patch.yml 里不能再插同一行 ─────────
# DSH 组 profile 时是「每个 bundle 一层 patch + profile patch 一层」，最后统一
# 检查 id 唯一性。本包是 bundle 插件，bundles 列表已经会让它挂载一次；profile
# patch 里再写一行同样的 insert，就凑出两个同 id 条目，桌面端启动抛
#   dsh-plugin-desktop: duplicate loader entry id "dsh-astrbot-gateway" in the composed profile
# 然后进恢复模式；而恢复内部要跑 pnpm remove，离线时连恢复都会失败（真实踩过）。
Write-Step "检查 profile cordis.patch.yml 有没有 $PkgName 的重复 insert 行"

$profilePatch = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path $profilePatch) {
    $patchText = Get-Content $profilePatch -Raw -Encoding UTF8
    $pattern = "(?m)^\s*-\s*(id|name):\s*['""]?" + [regex]::Escape($PkgName) + "['""]?\s*$"
    if ([regex]::IsMatch($patchText, $pattern)) {
        # 注意：here-string 的结束符必须顶格，PS 5.1 才认，所以这里用普通拼接。
        throw ("profile 的 cordis.patch.yml 里已经有 $PkgName 的 insert 行:`n" +
               "  $profilePatch`n" +
               "本包是 bundle 插件，只要出现在 dsh.profile.bundles 里就会自动挂载；`n" +
               "两处都写 = 同一个 id 插两次 = DSH 启动抛 duplicate loader entry id + 进恢复模式。`n" +
               "请先删掉该文件里那一行（保留注释与 ``[]`` 结构），再重跑本脚本。")
    }
    Write-Skip "profile patch 干净，没有 $PkgName 的重复行"
} else {
    Write-Skip "profile 没有 cordis.patch.yml（无需检查）"
}

# ── 0.5 离线门禁：自测 + 真 dsh-tools schema 校验 ────────────────────────
# 插件挂载失败会让 DSH 整个插件树加载不了，桌面端还会进恢复模式回滚 profile；
# 而恢复要跑 pnpm，离线时连恢复都会失败。所以**写 profile 之前**必须先证明插件挂得上。
Write-Step "离线门禁：插件自测 + 工具 schema 校验"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "    找不到 node，跳过门禁（风险自负）" -ForegroundColor Yellow
} else {
    $selftest = Join-Path $PluginDir 'tests\selftest.mjs'
    if (Test-Path $selftest) {
        Write-Host "    运行 tests\selftest.mjs ..." -ForegroundColor DarkGray
        & $node.Source $selftest | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "插件自测未通过（node tests\selftest.mjs），先修好再装" }
        Write-Host "    自测通过" -ForegroundColor Green
    }

    # 用 asar 里的真 dsh-tools 校验 parameters / output.schema（子集不对会抛 JsonSchemaError）
    $schemaCheck = [System.IO.Path]::GetFullPath((Join-Path $PluginDir '..\..\tools\validate-tool-schemas.mjs'))
    if (Test-Path $schemaCheck) {
        Write-Host "    运行 tools\validate-tool-schemas.mjs（真 dsh-tools）..." -ForegroundColor DarkGray
        & $node.Source $schemaCheck --plugin $PluginDir | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "工具 schema 未通过 dsh-tools 校验，挂载会炸，先修好再装" }
        Write-Host "    工具 schema 通过真校验" -ForegroundColor Green
    } else {
        Write-Host "    (跳过) 找不到 $schemaCheck" -ForegroundColor DarkGray
    }
}

# ── 1. package.json 的 bundles 列表 ──────────────────────────────────────
Write-Step "检查 dsh.profile.bundles"

$raw = Get-Content $profilePkg -Raw -Encoding UTF8
$json = $raw | ConvertFrom-Json
if (-not $json.dsh -or -not $json.dsh.profile -or -not $json.dsh.profile.bundles) {
    throw "profile package.json 里没有 dsh.profile.bundles，先手工确认结构"
}

$bundles = @($json.dsh.profile.bundles)
if ($bundles -contains $PkgName) {
    Write-Skip "bundles 里已经有 $PkgName"
} else {
    $newBundles = $bundles + $PkgName
    Write-Host "    将把 $PkgName 追加到 bundles 末尾：" -ForegroundColor Yellow
    Write-Host "      $($bundles -join ', ')  ->  $($newBundles -join ', ')" -ForegroundColor Yellow

    if ($Apply) {
        $backup = "$profilePkg.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $profilePkg $backup
        Write-Host "    已备份 -> $backup" -ForegroundColor DarkGray

        # 用 JSON 重写，缩进保持 2 空格，避免手改 YAML/JSON 出错
        $json.dsh.profile.bundles = $newBundles
        $out = $json | ConvertTo-Json -Depth 32
        # ConvertTo-Json 在 PS5.1 里会把非 ASCII 转成 \uXXXX，也会把数组压成一行；
        # 用 .NET 写 UTF-8 无 BOM，保持可读。
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($profilePkg, $out + "`n", $utf8)
        Write-Host "    已更新 $profilePkg" -ForegroundColor Green
    } else {
        Write-Host "    [dry-run] 未修改（加 -Apply 才会写）" -ForegroundColor DarkGray
    }
}

# ── 2. 登记本地依赖 ──────────────────────────────────────────────────────
Write-Step "检查 profile 依赖"

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$depSpec = "file:$PluginDir"
$hasDep = $false
if ($json.dependencies -and $json.dependencies.PSObject.Properties.Name -contains $PkgName) {
    $hasDep = $true
    Write-Skip "dependencies 里已有 $PkgName = $($json.dependencies.$PkgName)"
}

# 关键：pnpm 对 `file:` 依赖是**复制**一份进 node_modules，不是建软链。
# 所以改完插件源码后必须把已安装的那份删掉再 install，否则 pnpm 会说
# "Already up to date" 并继续用旧代码——dsh 加载的就是那个旧副本。
$installed = Join-Path $ProfileDir "node_modules\$PkgName"
$installedMain = Join-Path $installed 'lib\index.js'
$sourceMain = Join-Path $PluginDir 'lib\index.js'
$needRefresh = $false
if (Test-Path $installedMain) {
    $same = (Get-FileHash $installedMain).Hash -eq (Get-FileHash $sourceMain).Hash
    if ($same) {
        Write-Skip "node_modules 里的副本已是最新（与源码一致）"
    } else {
        $needRefresh = $true
        Write-Host "    检测到 node_modules 里的副本与源码不一致（旧 $((Get-Item $installedMain).Length) 字节 / 新 $((Get-Item $sourceMain).Length) 字节）" -ForegroundColor Yellow
    }
} elseif ($hasDep) {
    $needRefresh = $true
    Write-Host "    node_modules 里缺少 $PkgName，需要重新安装" -ForegroundColor Yellow
}

if ((-not $hasDep) -or $needRefresh) {
    if ($Apply) {
        if (-not $pnpm) { throw "找不到 pnpm，无法自动登记依赖" }

        if ($needRefresh -and (Test-Path $installed)) {
            Remove-Item $installed -Recurse -Force
            Write-Host "    已删除过期副本 node_modules\$PkgName" -ForegroundColor DarkGray
            Write-Host "    将执行：pnpm --dir `"$ProfileDir`" install" -ForegroundColor Yellow
            & $pnpm.Source --dir $ProfileDir install
        } else {
            Write-Host "    将执行：pnpm --dir `"$ProfileDir`" add `"$depSpec`"" -ForegroundColor Yellow
            & $pnpm.Source --dir $ProfileDir add $depSpec
        }
        if ($LASTEXITCODE -ne 0) { throw "pnpm 失败（退出码 $LASTEXITCODE）" }

        # 装完再验一次，避免「以为更新了其实没更新」
        if ((Get-FileHash $installedMain).Hash -ne (Get-FileHash $sourceMain).Hash) {
            throw "安装后副本仍与源码不一致，请检查 $installed"
        }
        Write-Host "    依赖已登记，且副本与源码一致" -ForegroundColor Green
    } else {
        Write-Host "    [dry-run] 未执行（加 -Apply 才会跑）" -ForegroundColor DarkGray
    }
}

# ── 收尾 ─────────────────────────────────────────────────────────────────
Write-Host ''
if ($Apply) {
    Write-Step "完成。请重启 dsh 让插件加载，然后检查："
} else {
    Write-Step "dry-run 结束。正式执行："
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Apply"
    Write-Step "执行后请重启 dsh 让插件加载，然后检查："
}
Write-Host "    cache\bridge_status.json  ->  `"uplink`": true"
Write-Host "    工具列表里出现 bridge_inbox / bridge_claim / bridge_complete"


# ── 收尾提醒：DSH 侧装完，还差 AstrBot 侧那两步 ────────────────────────────
Write-Host ""
Write-Host "DSH 侧装好了。AstrBot 侧还差两步：" -ForegroundColor Cyan
Write-Host "  1. 装插件：面板 -> 插件管理 -> 安装插件，填仓库地址 <仓库地址>/tree/astrbot-plugin"
Write-Host "  2. 填配置：只填「转达目标账号」一个就行（桥接目录留空时会和本插件默认目录对齐）"
Write-Host "详细的看 docs/install-astrbot.md。"
