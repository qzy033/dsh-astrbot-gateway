# 把 dsh-astrbot-gateway 挂进 dsh 的 profile（默认优先 desktop，其次 web；可用 -ProfileDir 指定）。
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
    [string]$PluginDir = '',
    # 可选：DSH Desktop 的运行时源码路径（app.asar 或解包后的 app 目录）。
    # 不填时 validate-tool-schemas.mjs 会自己探测常见安装位置。
    [string]$Asar = ''
)

$ErrorActionPreference = 'Stop'

# 注意：Windows PowerShell 5.1 里 $PSScriptRoot 在 param 默认值求值时还是空的，
# 所以路径必须在脚本体里再算。
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $PluginDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
}
if ([string]::IsNullOrWhiteSpace($ProfileDir)) {
    # 桌面端用 desktop、命令行/Web 版用 web。没指定时优先挑 desktop：
    # 这个插件的主要用户是桌面端，挑错 profile 会表现成「装了没反应」。
    $profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
    $desktopProfile = Join-Path $profilesRoot 'desktop'
    $webProfile = Join-Path $profilesRoot 'web'
    if (Test-Path $desktopProfile) { $ProfileDir = $desktopProfile }
    elseif (Test-Path $webProfile) { $ProfileDir = $webProfile }
    else { $ProfileDir = $desktopProfile }
    Write-Host "未指定 -ProfileDir，自动选: $ProfileDir" -ForegroundColor Yellow
    Write-Host "  装错 profile 会表现成「装了没反应」；要换就重跑并加 -ProfileDir" -ForegroundColor DarkGray
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

# ── 0. 检查 profile 自己的 cordis.patch.yml ──────────────────────────────
# 两种情况要分清：
#   A) `- insert:` 块里又插了一遍 dsh-astrbot-gateway —— 这是**重复 id**，
#      bundle 已经在 bundles 里插过一次，再来一次 DSH 启动会抛
#      duplicate loader entry id 并进恢复模式，必须拒绝。
#   B) `- id: dsh-astrbot-gateway` + `config:` —— 这是**按 id 覆盖配置**，
#      是推荐写法，不能误判成重复。
# 另外顺手提示：已有覆盖块里如果写着 `disabled: true`，装进 bundles 后它仍会被禁用。
Write-Step "检查 profile cordis.patch.yml 里的 $PkgName 条目"

$profilePatch = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path $profilePatch) {
    $patchLines = Get-Content $profilePatch -Encoding UTF8
    $idPattern = [regex]::Escape($PkgName)
    $insertIdLine = "^(\s*)-\s*(id|name):\s*['`"]?$idPattern['`"]?\s*$"
    $topIdLine = "^-\s*id:\s*['`"]?$idPattern['`"]?\s*$"

    $insertIndent = $null
    $duplicateInsert = $false
    foreach ($line in $patchLines) {
        if ($line -match '^(\s*)-\s*insert:\s*$') {
            $insertIndent = $Matches[1].Length
            continue
        }
        if ($null -ne $insertIndent) {
            if ($line -match '^(\s*)-\s+' -and $Matches[1].Length -le $insertIndent) {
                $insertIndent = $null
            } elseif ($line -match $insertIdLine) {
                $duplicateInsert = $true
                break
            }
        }
    }

    if ($duplicateInsert) {
        # 注意：here-string 的结束符必须顶格，PS 5.1 才认，所以这里用普通拼接。
        throw ("profile 的 cordis.patch.yml 在 insert 块里又插了一遍 ${PkgName}:`n" +
               "  $profilePatch`n" +
               "本包是 bundle 插件，只要出现在 dsh.profile.bundles 里就会自动挂载；`n" +
               "两处都写 = 同一个 id 插两次 = DSH 启动抛 duplicate loader entry id + 进恢复模式。`n" +
               "请把那一行 insert 删掉，只保留 `- id: $PkgName` + config 的覆盖写法，再重跑本脚本。")
    }

    # 已有同名覆盖块且 disabled: true → 装进 bundles 后仍会被禁用，提醒一句。
    $topIdx = -1
    for ($i = 0; $i -lt $patchLines.Count; $i++) {
        if ($patchLines[$i] -match $topIdLine) { $topIdx = $i; break }
    }
    if ($topIdx -ge 0) {
        $disabled = $false
        for ($j = $topIdx + 1; $j -lt [Math]::Min($topIdx + 40, $patchLines.Count); $j++) {
            if ($patchLines[$j] -match '^-\s') { break }
            if ($patchLines[$j] -match '^\s*disabled:\s*true\s*$') { $disabled = $true; break }
        }
        if ($disabled) {
            Write-Host "    注意：profile patch 里这一段写着 disabled: true，装进 bundles 后插件仍会被禁用。" -ForegroundColor Yellow
            Write-Host "    要启用请把 disabled 改成 false 或整行删掉，再重启 DSH。" -ForegroundColor Yellow
        } else {
            Write-Skip "已有按 id 覆盖配置的段落（这是推荐写法）"
        }
    } else {
        Write-Skip "profile patch 干净，没有 $PkgName 的重复 insert"
    }
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

    # 用真 dsh-tools 校验 parameters / output.schema（子集不对会抛 JsonSchemaError）。
    # 退出码：0=通过；1=有违规（必须拦）；2=环境问题（找不到 DSH 源码，只警告）。
    $schemaCheck = [System.IO.Path]::GetFullPath((Join-Path $PluginDir '..\..\tools\validate-tool-schemas.mjs'))
    if (Test-Path $schemaCheck) {
        Write-Host "    运行 tools\validate-tool-schemas.mjs（真 dsh-tools）..." -ForegroundColor DarkGray
        $schemaArgs = @('--plugin', $PluginDir)
        if (-not [string]::IsNullOrWhiteSpace($Asar)) { $schemaArgs += @('--asar', $Asar) }
        & $node.Source $schemaCheck @schemaArgs 2>&1 | ForEach-Object {
            Write-Host "    $_" -ForegroundColor DarkGray
        }
        $schemaExit = $LASTEXITCODE
        if ($schemaExit -eq 1) {
            throw "工具 schema 未通过 dsh-tools 校验（退出码 1），挂载会炸，先修好再装"
        } elseif ($schemaExit -eq 2) {
            Write-Host "    (警告) 找不到 DSH Desktop 源码，跳过真校验" -ForegroundColor Yellow
            Write-Host "    如果 DSH 装在非默认位置，加 -Asar <app.asar 或 app 目录> 再跑一次" -ForegroundColor DarkGray
        } else {
            Write-Host "    工具 schema 通过真校验" -ForegroundColor Green
        }
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
Write-Host "    cache\bridge_status.json  ->  dispatch.reuseSession: true、poller 不是 none"
Write-Host "    capabilities 里 tools / timer / interval 都是 true"
Write-Host "    工具列表里出现 bridge_inbox / bridge_claim / bridge_complete"


# ── 收尾提醒：DSH 侧装完，还差 AstrBot 侧那两步 ────────────────────────────
Write-Host ""
Write-Host "DSH 侧装好了。AstrBot 侧还差两步：" -ForegroundColor Cyan
Write-Host "  1. 装插件：面板 -> 插件管理 -> 插件市场搜 astrbot_plugin_dsh_gateway，"
Write-Host "     或 安装插件 -> 仓库地址填 https://github.com/qzy033/astrbot_plugin_dsh_gateway"
Write-Host "  2. 填配置：只填「转达目标账号」一个就行（桥接目录留空时会和本插件默认目录对齐）"
Write-Host "直达链路：docs/install-astrbot.md、docs/install.md。"
