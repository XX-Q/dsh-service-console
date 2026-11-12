---
name: task-console
description: 任务台登记与运维规范（本机常驻服务编码规范）。凡是长期运行的东西——dev server、看板、轮询/定时脚本、后台 job——都要按本规范实现 start/stop/status 三件套，并登记进任务台（name、description、cwd、启动命令、停止方式、探活端口）。用 service_console 工具或 /service-console 的 HTTP API 写入与启停。
whenToUse: 要启动或维护任何长期运行的本地服务/脚本时；要写一个新的常驻服务并希望它能被任务台启停时；用户问“任务台 / 服务控制台 / 哪些在跑 / 停掉某个服务 / 把服务登记进去”时。
---

# 任务台（task-console）

任务台 = DSH 里那张持久化任务表（`~/.dsh/storages/service-console/registry.json`）+ 三个入口：

| 入口 | 用法 |
|---|---|
| GUI | 右下角「任务台」按钮（弹窗；可全屏、可新页面），`Alt+Shift+S` |
| 页面 | `http://127.0.0.1:3080/service-console`（`?embed=1` 是弹层紧凑版） |
| 工具 / API | `service_console` 工具；`POST /service-console/api/*` |

它回答三件事：**现在在跑** / **以前在跑、现在停了** / **从来没跑过**。

---

## 一、硬性规范：每个任务必须齐这七项

登记时缺一项，这个任务就是"半成品"——用户看不出用途、你也没法一键启停。

| # | 字段 | 要求 | 反例 |
|---|---|---|---|
| 1 | `name` | 人能一眼认出的名字，带端口或用途 | `python` / `server` |
| 2 | `description` | 干什么、谁在用、注意事项（一条就够，别写散文） | 空 |
| 3 | `cwd` | **绝对路径**，脚本按这个目录找相对资源 | `.` / 相对路径 |
| 4 | `command` | 启动命令（**PowerShell 语法**），能重复执行 | 交互式命令、`??` 猜测 |
| 5 | `stop_command` | 任务自带停止脚本（`python stop.py`）；没有就留空 → 任务台 `taskkill /T /F` | 只写启动不写停止 |
| 6 | `port` | 能监听就填，任务台靠它 TCP 探活判定"在跑" | 随机端口 / 不填 |
| 7 | `kind` | `command`（可启停）/ `port`（只观测）/ `process` / `job`（DSH 后台任务） | 把常驻服务登记成 `port` 却指望能启动 |

> `port` 优先：有端口就有客观的"在跑/没在跑"，不依赖 pid 是否被复用。
> `stop_command` 优先于 taskkill：能优雅退出就别硬杀（数据库 flush、删 PID 文件、收尾上传）。

## 二、常驻服务脚本的编码规范

写一个新的长期运行脚本时，按这九条写，它才配进任务台：

1. **幂等启动**：已有实例在跑就复用/直接退出 0，不要抢端口报 EADDRINUSE。
2. **PID 文件**：`<cwd>/.<name>.pid`（或项目自己的 `.dashboard.pid` 约定），启动写、停止删。
3. **健康检查**：暴露 `GET /api/health`（HTTP 服务）或 `status` 子命令，返回 `{ok, pid, port}`。
4. **优雅退出**：处理 SIGTERM / Ctrl+C / `CTRL_CLOSE_EVENT`，close 监听、flush 数据、删 PID。
5. **固定端口**：写死默认端口并允许 `--port` 覆盖；随机端口等于放弃探活。
6. **日志落 stdout**：任务台已经把 stdout/stderr 重定向到 `~/.dsh/storages/service-console/logs/<id>.log`，**不要**再自己 `>>` 一份（会双写）。
7. **非交互**：不许 `Read-Host` / `input()` / 需要点确认的弹窗；任务台是无终端启动的。
8. **启动即打印 ready**：`[name] listening on http://127.0.0.1:<port>`，日志里一眼看出成没成。
9. **相对路径只依赖 `cwd`**：所有资源用 `Path(__file__).parent` / `__dirname` 或 cwd 拼，别依赖调用者的位置。

## 三、登记流程（写入）

### 3.1 用工具（agent 首选）

```text
service_console(action="register",
  name="本地看板 :3000",
  description="本地看板；自带 .dashboard.pid 复用，重复启动会复用已有实例",
  kind="command",
  command="python run_dashboard.py",
  stop_command="python stop.py",
  cwd="D:\\proj\\dashboard",
  port=3000)
```

登记前后各做一次 `action="list"`：先查重（同名别登记两遍），后确认状态是 `running` 或 `stopped`（而不是 `unknown`）。

### 3.2 用 HTTP（脚本 / 无工具时）

```powershell
$body = @{
  name='本地看板 :3000'; kind='command'; port=3000
  command='python run_dashboard.py'
  stop_command='python stop.py'
  cwd='D:\proj\dashboard'
  description='本地看板'
} | ConvertTo-Json -Compress
Invoke-RestMethod 'http://127.0.0.1:3080/service-console/api/entry/add' `
  -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

配套脚本：`scripts/register.ps1`（见本 skill 目录），一条命令完成登记 + 自检。

### 3.3 从已有进程反推登记

新服务可能是别人起的，用扫描接口拿现成的 pid/命令行：

```powershell
Invoke-RestMethod 'http://127.0.0.1:3080/service-console/api/scan' -Method Post -Body '{}' -ContentType 'application/json' |
  Select-Object -ExpandProperty rows | Where-Object { -not $_.system } |
  Format-Table port, pid, processName, commandLine -AutoSize
```

## 四、启停与排障

| 动作 | 接口 | 说明 |
|---|---|---|
| 启动 | `action="start"` / `api/entry/start` | 生成 `.ps1` → WMI `Win32_Process.Create`（**不用 `detached:true`**，Windows 上会被宿主 Job 回收） |
| 停止 | `action="stop"` / `api/entry/stop` | 有 `stop_command` 先执行并等 ≤6s；没退出再 `taskkill /PID <pid> /T /F` |
| 重启 | `action="restart"` | 先停后启，中间 600ms |
| 日志 | `action="logs"` / `api/entry/logs` | 读 `logs/<id>.log` 尾部 |
| 删除 | `action="remove"` | 只删表记录，**不杀进程** |

排障顺序：

1. `list` 里状态 `unknown` → 既没 `port` 也没 `pid`，补探活字段。
2. 启动成功但立刻 `stopped` → 读日志（`logs`），通常是相对路径、缺依赖、端口被占。
3. 停止后仍显示 `running` → 探活的是别人的端口；确认 `port` 没写错，或进程没被 taskkill 干净。
4. 停止命令老失败 → `stop_command` 里避免交互式确认，改 `--yes` / `-Force`。

## 五、模板

### PowerShell 常驻脚本

```powershell
param([int]$Port = 18799)
$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.demo.pid'
if (Test-Path $pidFile) {
  $old = (Get-Content $pidFile -Raw).Trim()
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    Write-Output "[demo] 已有实例 pid=$old，复用"; exit 0
  }
}
$PID | Set-Content $pidFile
Write-Output "[demo] listening on http://127.0.0.1:$Port"
try { $listener = [Net.HttpListener]::new(); $listener.Prefixes.Add("http://127.0.0.1:$Port/"); $listener.Start(); while ($true) { $ctx = $listener.GetContext(); $ctx.Response.StatusCode = 200; $ctx.Response.Close() } }
finally { Remove-Item $pidFile -ErrorAction SilentlyContinue }
```

### Python（stdlib）

```python
# demo.py —— 幂等启动 / 健康检查 / 优雅退出
import json, os, signal, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PID_FILE = ROOT / '.demo.pid'
PORT = int(sys.argv[sys.argv.index('--port') + 1]) if '--port' in sys.argv else 18799


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


if PID_FILE.exists():
    old = PID_FILE.read_text().strip()
    if old.isdigit() and pid_alive(int(old)):
        print(f'[demo] 已有实例 pid={old}，复用', flush=True)
        raise SystemExit(0)

PID_FILE.write_text(str(os.getpid()))


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'ok': True, 'pid': os.getpid(), 'port': PORT}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): print('[demo]', *a, flush=True)


def stop(*_):
    PID_FILE.unlink(missing_ok=True)
    print('[demo] stopped', flush=True)   # 任务台会把 stdout 写进日志
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
print(f'[demo] listening on http://127.0.0.1:{PORT}', flush=True)
ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
```

### Node

```js
// demo.js —— node demo.js --port 18799
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const root = __dirname
const pidFile = path.join(root, '.demo.pid')
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 18799
fs.writeFileSync(pidFile, String(process.pid))
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, pid: process.pid, port }))
})
server.listen(port, '127.0.0.1', () => console.log(`[demo] listening on http://127.0.0.1:${port}`))
const stop = () => { try { fs.unlinkSync(pidFile) } catch {} ; server.close(() => process.exit(0)) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
```

> 写 `.ps1` 文件时注意编码：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会把中文注释读成乱码并报语法错，`.ps1` 一律存成 **UTF-8 with BOM**（任务台自己生成的 `.ps1` 已按纯 ASCII 头部处理）。

## 六、反例（别这么干）
- ❌ 起完服务不登记，用户不知道它在跑。
- ❌ 同名登记三次，表里三条一样的任务。
- ❌ `cwd` 写 `~` 或相对路径 → WMI 启动时工作目录不对，读不到配置。
- ❌ 用 `python -m http.server` 这种**没有停止脚本**的一次性命令当"常驻服务"（可以登记，但要清楚只能 taskkill）。
- ❌ 端口写 0（随机）→ 任务台永远判 `stopped`。
- ❌ 把 `cmd /c start` 或 `detached` 塞进 command 里再嵌套一层 → 拿到的 pid 是壳进程，`stop` 后真进程还活着。
- ❌ 在 command 里自己 `>> log` → 日志双写、顺序错乱。

## 七、一页速查

```
登记   service_console action=register name/description/cwd/command/stop_command/port
查表   service_console action=list
启动   service_console action=start  id=svc-xxxx
停止   service_console action=stop   id=svc-xxxx     # stop_command → taskkill
重启   service_console action=restart id=svc-xxxx
日志   service_console action=logs    id=svc-xxxx
扫描   service_console action=scan
收编   service_console action=adopt_job job_id=bash-xxxx
```

数据在 `$DSH_HOME/storages/service-console/registry.json`，日志在同目录 `logs/<id>.log`。**登记即承诺可启停**——做不到可启停的服务，宁可只登记成 `port` 说明清楚。
