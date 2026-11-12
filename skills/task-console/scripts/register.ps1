# task-console · 登记助手
# 用法：
#   .\register.ps1 -Name "我的看板 :3000" -Command "python run_dashboard.py" -Cwd "D:\proj\dashboard" `
#                  -Port 3000 -StopCommand "python stop.py" -Description "本地看板"
# 依赖：任务台插件已装载（默认 http://127.0.0.1:3080/service-console）
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $false)][string]$Description = '',
  [Parameter(Mandatory = $false)][string]$Command = '',
  [Parameter(Mandatory = $false)][string]$StopCommand = '',
  [Parameter(Mandatory = $false)][string]$Cwd = '',
  [Parameter(Mandatory = $false)][int]$Port = 0,
  [ValidateSet('command', 'port', 'process', 'job')][string]$Kind = 'command',
  [string]$Base = 'http://127.0.0.1:3080/service-console',
  [switch]$Start,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

if ($Cwd -and -not [IO.Path]::IsPathRooted($Cwd)) { throw "cwd 必须是绝对路径：$Cwd" }
if ($Kind -eq 'command' -and -not $Command) { throw 'kind=command 必须提供 -Command' }
if ($Kind -eq 'command' -and -not $Cwd) { Write-Warning '建议提供 -Cwd，否则工作目录是 DSH 宿主进程的 cwd' }

function Post-Json([string]$Path, $Payload) {
  $json = $Payload | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  Invoke-RestMethod -Uri "$Base/api/$Path" -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes
}

# 查重：同名任务直接复用
$state = Invoke-RestMethod -Uri "$Base/api/state" -Method Get
$existing = $state.entries | Where-Object { $_.name -eq $Name } | Select-Object -First 1
if ($existing) {
  Write-Host "已存在：$($existing.id)  $($existing.name)  → $($existing.status.state)" -ForegroundColor Yellow
  $id = $existing.id
}
else {
  $payload = @{ name = $Name; kind = $Kind; description = $Description; command = $Command; stopCommand = $StopCommand; cwd = $Cwd }
  if ($Port -gt 0) { $payload.port = $Port }
  $added = Post-Json 'entry/add' $payload
  $id = $added.entry.id
  Write-Host "已登记：$id  $($added.entry.name)  → $($added.entry.status.state)" -ForegroundColor Green
}

if ($Start) {
  $started = Post-Json 'entry/start' @{ id = $id }
  Write-Host "启动：$($started.message)" -ForegroundColor Cyan
}

if ($Check) {
  $after = (Invoke-RestMethod -Uri "$Base/api/state").entries | Where-Object { $_.id -eq $id }
  $line = "{0}  {1}/{2}  {3}" -f $after.id, $after.status.state, $after.category, $after.status.detail
  if ($after.status.state -eq 'running') { Write-Host $line -ForegroundColor Green } else { Write-Host $line -ForegroundColor Yellow }
  Write-Host ("日志：{0}" -f (Join-Path $env:USERPROFILE ".dsh\storages\service-console\logs\$id.log"))
}

Write-Output $id
