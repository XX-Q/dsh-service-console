# Changelog

## 1.0.1 — 2026-11-12

- 修复：同一个 $DSH_HOME 被多个 DSH 实例打开时，任务表会出现“删了又回来”的条目。
  现在写盘前先读磁盘：本进程没有待落盘改动就整表采用磁盘内容（别人的删除会传播），
  有改动才按 id 并集合并，并记录自身写入 mtime 判断“磁盘是否被别人改过”。
- 修复：scheduleSave() 落盘前同样走一次同步，杜绝两个实例互相覆盖。
- 仓库历史重建：移除此前误提交的本机路径与真实服务名示例（改为 python / D:\\proj\\dashboard / :3000 这类通用占位）。

## 1.0.0 — 2026-11-12

首个公开版本。

- 任务表持久化（`$DSH_HOME/storages/service-console/registry.json`），三态语义：在跑 / 以前在跑现在停了 / 从来没跑过
- 一键启停：`.ps1` + WMI `Win32_Process.Create` 启动；`stopCommand` 优先、`taskkill /T /F` 兜底
- 探活：端口 TCP / pid 存活 / DSH job 状态镜像
- GUI：右下角悬浮按钮 + 当前页弹层（全屏 / 新页面 / 新标签模式记忆 / `Alt+Shift+S`）
- 控制台页面：筛选、日志、端口扫描一键登记、历史 job 导入
- 模型工具 `service_console` 与 HTTP API（state / entry/* / scan / job/*）
- 随包安装 `task-console` skill（七项必备字段 + 九条脚本规范 + 三语言骨架 + `scripts/register.ps1`）
- 修复：停止日志与被服务进程占用句柄的主日志分离（`EBUSY`）；停止目标取端口 pid ∪ 登记 pid 并集；多实例共享 registry 时写盘前合并磁盘
