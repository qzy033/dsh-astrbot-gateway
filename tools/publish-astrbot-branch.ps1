# 把 AstrBot 侧插件推成单独分支，让分支**根目录**就是插件本体。
#
# 为什么需要：AstrBot 从仓库装插件时，下载完仓库会要求仓库根目录有 metadata.yaml，
# 本仓库根放的是项目本体，插件在 astrbot-plugin/ 子目录里，直接填仓库地址会报
# 「未找到 metadata.yaml」。所以把插件子树推成一个分支，安装地址写
#   https://github.com/<owner>/<repo>/tree/astrbot-plugin
#
# 用法：
#   先干跑看看要推什么：  powershell -File tools\publish-astrbot-branch.ps1
#   确认没问题再真推：    powershell -File tools\publish-astrbot-branch.ps1 -Apply
param(
    [string]$Remote = "origin",
    [string]$Branch = "astrbot-plugin",
    [string]$Prefix = "astrbot-plugin/astrbot_plugin_dsh_gateway",
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Test-Path (Join-Path $repoRoot $Prefix))) {
    throw "找不到插件目录: $Prefix"
}
if (-not (Test-Path (Join-Path $repoRoot (Join-Path $Prefix "metadata.yaml")))) {
    throw "$Prefix 下没有 metadata.yaml，AstrBot 装了也认不出来"
}

$tmp = "_astrbot-plugin-split"
Write-Host "== 把 $Prefix 拆成一个独立的历史" -ForegroundColor Cyan
git subtree split --prefix=$Prefix -b $tmp

Write-Host "== 推送到 $Remote 的 $Branch 分支" -ForegroundColor Cyan
if (-not $Apply) {
    Write-Host "  干跑：真实执行会把上面这条历史强推到 $Remote/$Branch" -ForegroundColor Yellow
    Write-Host "  确认无误后加 -Apply 再跑一次" -ForegroundColor Yellow
    git branch -D $tmp | Out-Null
    exit 0
}
git push $Remote "${tmp}:${Branch}" --force
git branch -D $tmp | Out-Null
Write-Host "== 完成。AstrBot 里填装地址：" -ForegroundColor Green
Write-Host "   https://github.com/<owner>/<repo>/tree/$Branch"
