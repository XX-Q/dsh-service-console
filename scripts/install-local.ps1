# task-console · 本地克隆安装（幂等）
# 在 profile 的 node_modules 里建 junction，并把任务台那一行写进 cordis.patch.yml。
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 [-Profile web]
param(
  [string]$Profile = 'web',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$linkPath = Join-Path $profileDir 'node_modules\dsh-service-console'

if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录：$profileDir（先跑一次 dsh web 生成）" }
if (-not (Test-Path (Join-Path $repo 'index.js'))) { throw "这个脚本要从仓库里的 scripts\ 目录运行" }

New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'node_modules') | Out-Null
if (Test-Path $linkPath) {
  $item = Get-Item $linkPath -Force
  if ($item.LinkType -eq 'Junction') {
    Remove-Item $linkPath -Force
  } else {
    throw "$linkPath 已存在且不是 junction，请先手动处理（可能是 pnpm 装的正式包）"
  }
}
New-Item -ItemType Junction -Path $linkPath -Target $repo | Out-Null
Write-Host "junction 就绪：$linkPath → $repo" -ForegroundColor Green

$patch = if (Test-Path $patchFile) { [IO.File]::ReadAllText($patchFile, [Text.Encoding]::UTF8) } else { '' }
if ($patch -match 'id:\s*service-console') {
  Write-Host 'cordis.patch.yml 里已有 service-console 行，跳过' -ForegroundColor Yellow
} else {
  $block = @"

# ── 本机服务任务台（dsh-service-console）────────────────────────────────────
- insert:
    - id: service-console
      name: "dsh-service-console"
      inject: [webServer, tools]
      config:
        autoAdoptJobs: true
        installSkill: true
        probeIntervalMs: 15000
        stateMaxAgeMs: 1500
"@
  [IO.File]::WriteAllText($patchFile, ($patch.TrimEnd() + "`n" + $block + "`n"), (New-Object Text.UTF8Encoding($false)))
  Write-Host "已写入 $patchFile" -ForegroundColor Green
}

Write-Host ''
Write-Host '等 HMR 重编译（约 10 秒），然后验证：' -ForegroundColor Cyan
Write-Host '  Invoke-RestMethod http://127.0.0.1:3080/service-console/api/state | Select-Object -ExpandProperty summary'
Write-Host 'GUI 刷新一次页面，右下角出现「任务台」按钮。'
