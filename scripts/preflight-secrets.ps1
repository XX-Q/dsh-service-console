# 提交前脱敏自检：扫描工作树与历史里的本机路径 / 凭证 / 真实服务名
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\preflight-secrets.ps1 [-History]
param([switch]$History)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
# 模式本身用拼接写，避免这份脚本自己命中扫描（同时让第三方 grep 也保持干净）
$patterns = @(
  ('ad' + 'min'), ('C:' + '\\Users'), ('C:' + '/Users'), ('App' + 'Data'),
  ('AI/' + 'envs'), ('D:' + '\\Code'), ('D:' + '/Code'), ('Ds' + 'Code'),
  ('gh' + 'o_'), ('gh' + 'p_'), ('github' + '_pat'), ('xox' + 'b-'), ('AK' + 'IA'),
  ('192' + '\.168\.'), ('10' + '\.0\.\d'), ('169' + '\.254'),
  ('pass' + 'word\s*[:=]'), ('sec' + 'ret\s*[:=]'), ('to' + 'ken\s*[:=]')
)

Push-Location $repo
try {
  $bad = 0
  Write-Host "扫描工作树..." -ForegroundColor Cyan
  foreach ($p in $patterns) {
    $hits = git grep -n -I -E -- $p -- ':(exclude)scripts/preflight-secrets.ps1' 2>$null
    if ($hits) {
      $bad++
      Write-Host "--- [$p] ---" -ForegroundColor Yellow
      $hits | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
    }
  }

  if ($History) {
    Write-Host "扫描全部历史提交..." -ForegroundColor Cyan
    foreach ($p in $patterns) {
      $commits = git log --all --oneline -S $p --format='%h %s' 2>$null
      if ($commits) {
        $bad++
        Write-Host "--- [$p] ---" -ForegroundColor Yellow
        $commits | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
      }
    }
  }

  if ($bad -eq 0) {
    Write-Host '干净：没有命中本机路径 / 凭证 / 内网地址模式。' -ForegroundColor Green
    exit 0
  }
  Write-Host "命中 $bad 组模式，先脱敏再提交。" -ForegroundColor Red
  exit 1
}
finally { Pop-Location }
