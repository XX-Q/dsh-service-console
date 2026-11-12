# dsh-service-console

> **DeepSeek Harness（DSH）插件 · 跨对话的持久化任务台**
> 一张任务表，看清本机服务与后台任务「哪些现在在跑 / 哪些以前在跑现在停了 / 哪些从没跑过」，并能一键启停。
> Persistent task & service console for **DeepSeek Harness (DSH)** — one cross-conversation task table with start/stop, a popup GUI panel, and a coding-standard skill.

`deepseek-harness` · `dsh` · `dsh-plugin` · `cordis` · 任务管理 · 服务管理 · 后台任务 · 进程管理

---

## 它解决什么问题

DSH 自带的 `job_list / job_output / job_kill`（`@deepseek-ai/dsh-tool-jobs`）只管**本进程、本会话、agent 自己启动**的后台任务：宿主一退出就没了，也不能启动、不能登记"我手动起的 python 看板"。结果是：

- 换个对话，就不知道上一个对话里那些服务还在不在跑；
- 本机一堆监听端口的服务散落在终端窗口里，停哪个、哪个还活着全靠 `netstat`；
- 想让 agent 帮你启停某个常驻脚本，它没有可编程的接口。

这个插件补上这一层：**任务表落盘**（`$DSH_HOME/storages/service-console/registry.json`），把「现在在跑 / 曾经在跑 / 从没跑过」变成可查询、可启停、可交接给下一个对话的事实。

## 功能

| 能力 | 说明 |
|---|---|
| **任务表** | 每条任务带 `name / description / cwd / command / stopCommand / port / kind` 七项元信息，持久化到磁盘 |
| **三态语义** | `running`（探活通过）/ `stopped-before`（曾观测到在跑，现在不行）/ `never`（登记后从未跑过） |
| **一键启停** | 启动走 `.ps1` + WMI `Win32_Process.Create`（脱离宿主 Job，宿主重启后仍在跑）；停止优先执行任务自带 `stopCommand`，兜底 `taskkill /T /F` |
| **探活** | 端口 TCP 探测 / pid 存活 / DSH job 状态镜像三选一，判断不靠猜 |
| **GUI 弹窗** | 右下角「任务台」按钮，当前页弹层（Esc 关闭）；可**全屏**、**新页面**、切换成新标签打开；`Alt+Shift+S` |
| **控制台页面** | `/service-console`，筛选（全部 / 在跑 / 以前在跑 / 从未）、日志查看、端口扫描一键登记 |
| **DSH job 收编** | 自动收编「还在跑」的会话后台任务，历史任务按需导入；停止走 `ctx.jobs.kill` |
| **模型工具** | `service_console`：`list / register / start / stop / restart / remove / scan / adopt_job / logs` |
| **HTTP API** | `GET /service-console/api/state` 等，脚本可直接写表 |
| **编码规范 skill** | 随包安装 `task-console` skill：七项必备字段、九条常驻脚本规范、三语言骨架、排障顺序 |

## 安装

要求：DSH `0.2.1-rc.2` 及以上（Cordis 插件体系），Node 22+，Windows 10/11。

### 方式 A：从 GitHub 安装（推荐）

```powershell
dsh plugin --profile web add github:XX-Q/dsh-service-console
```

装完打开 Web GUI → **Plugins** 页，把 `dsh-service-console` 这个 bundle 打开；或者手写进 profile 的 `package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-service-console"] } }
}
```

（bundle 的具体位置按你 profile 现有顺序追加在最后即可。）

### 方式 B：本地克隆 + junction（开发/免包管理器）

```powershell
git clone https://github.com/XX-Q/dsh-service-console.git "$env:USERPROFILE\Documents\dsh-service-console"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Documents\dsh-service-console\scripts\install-local.ps1"
```

脚本做两件事（幂等）：

1. 在 `~/.dsh/profiles/web/node_modules/dsh-service-console` 建 junction 指向仓库目录；
2. 往 `~/.dsh/profiles/web/cordis.patch.yml` 追加 `- insert: [{ id: service-console, name: "dsh-service-console" }]`（已存在则跳过）。

DSH 的 HMR 会重编译 profile，插件立即生效，不用重启宿主。

### 安装校验

```powershell
Invoke-RestMethod http://127.0.0.1:3080/service-console/api/state | Select-Object -ExpandProperty summary
```

看到 `total / running / stoppedBefore / never` 就对了。GUI 刷新一次页面，右下角出现「任务台」。

## 使用

### 1. GUI 弹窗

- 点「任务台」→ 当前页弹层（iframe + 遮罩，`Esc` 关闭）
- 工具栏：**刷新 / 全屏 / 新页面 / 关闭**；`▾` 可切成"新标签页打开"，选择会被记住
- `Alt+Shift+S` 随时唤起

### 2. 页面

```
http://127.0.0.1:3080/service-console            # 完整页面
http://127.0.0.1:3080/service-console?embed=1    # 弹层紧凑版
```

### 3. 模型工具

```text
service_console(action="register",
  name="本地看板 :3000",
  description="本地看板；自带 .dashboard.pid 复用",
  kind="command",
  command="python run_dashboard.py",
  stop_command="python stop.py",
  cwd="D:\\proj\\dashboard",
  port=3000)
```

### 4. HTTP API

前缀 `/service-console`，全部 JSON：

| 方法与路径 | 作用 |
|---|---|
| `GET /api/state` | 任务表 + 汇总 + 可见 job 列表 + 最近动作 + 端口扫描结果 |
| `POST /api/entry/add` | 登记 `{name, kind, command, stopCommand, cwd, port, description}` |
| `POST /api/entry/update` | 改任务 `{id, patch}` |
| `POST /api/entry/start` \| `stop` \| `restart` | 启停 `{id}` |
| `POST /api/entry/logs` | 主日志 + 停止命令日志尾部 |
| `POST /api/entry/remove` | 只删表记录，不杀进程 |
| `POST /api/scan` | 扫描本机监听端口（进程名 + 命令行） |
| `POST /api/job/adopt` \| `job/kill` | 收编 / 停止 DSH 后台任务 |
| `POST /api/jobs/import` | 按需导入历史后台任务 |
| `POST /api/reset` | 清空任务表 |

## 任务台规范（随包 skill：`task-console`）

安装后自动出现在 `~/.dsh/skills/task-console/`，DSH 会在新会话把它放进 skill 目录。核心约束：

**每个任务必须齐七项**：`name`、`description`、`cwd`（绝对路径）、`command`、`stopCommand`、`port`、`kind`。

**常驻脚本九条**：幂等启动、PID 文件、健康检查、优雅退出、固定端口、日志交给任务台、非交互、启动打印 ready、相对路径只依赖 cwd。

完整版（含 PowerShell / Python / Node 骨架、三种写入方式、排障顺序、反例）见 [`skills/task-console/SKILL.md`](skills/task-console/SKILL.md)；`skills/task-console/scripts/register.ps1` 是一行命令完成登记+启动+自检的助手。

## 三态是怎么算出来的

| 状态 | 判定 |
|---|---|
| `running` | 端口可连接，或 pid 存活，或对应 DSH job 仍在 `running/stopping` |
| `stopped-before` | 历史上 `lastSeenRunningAt` 有值，但当前探活不通过 |
| `never` | 登记后从未被观测到运行 |
| `unknown` | 既没有端口也没有 pid，无法判断（日志会明确提示补字段） |

## 实现里踩过的坑（值得抄的结论）

- **`detached: true` 在 DSH 宿主里起不来进程**：Windows 上会被父进程的 Job 对象立刻回收（拿到 pid、进程不落地）。改用 WMI `Win32_Process.Create`，输出经 `cmd /c ... >> log 2>&1` 落盘。
- **命令写进 `.ps1` 再用 `-File` 执行**：绕开 PowerShell 引号/转义地狱，报错能完整进日志。
- **停止日志必须独立文件**：服务进程用 `>> 主日志` 持有句柄，停止命令再写主日志会 `EBUSY`。
- **停止目标取并集**：端口占用 pid ∪ 登记的壳进程 pid，先杀活的、已死的跳过，否则同一棵进程树会杀两遍报错。
- **job 的 owner 是 session id**：`ctx.jobs.list(agentId)` 才能看到别的会话在跑什么；用 `{owners:'scope'}` 订阅事件流做镜像。
- **多实例共享同一 registry**：写盘前 `syncFromDisk()`，避免后启动的空实例覆盖已登记的表。

## 兼容性与边界

- 平台：目前只在 **Windows 10/11** 实测（启停、WMI、`taskkill`、端口扫描都是 Windows 路径）。Linux/macOS 需要把启动/停止/扫描三处换成对应实现，欢迎 PR。
- DSH 版本：`0.2.1-rc.2` 实测；依赖的公开面是 `ctx.webServer`、`ctx.tools`、`ctx.jobs`、`ctx.agents`，`webserver/index-inject` 的 `tapIndex`。
- `job` 类任务只能停、不能启（由会话里的工具启动）；需要可启停就登记成 `command`。
- 任务表是单文件 JSON，并发写入按"后写合并"处理，不做跨机同步。

## 提交前自检

`scripts/preflight-secrets.ps1` 会扫描工作树（加 `-History` 扫全部历史）里的本机路径、凭证前缀、内网地址与真实服务名模式，命中即非零退出，避免再把这些示例提交上来。

## License

MIT © XX-Q
