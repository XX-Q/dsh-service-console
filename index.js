/**
 * dsh-service-console —— 本机服务 / 后台任务统一控制台（DSH 插件）
 *
 * 目标：一张任务表，回答三件事——哪些现在在跑、哪些以前在跑现在停了、哪些从来没跑过。
 *
 * 组成：
 *   1) 持久化任务表        $DSH_HOME/storages/service-console/registry.json
 *   2) 探活引擎            端口 TCP 探活 / pid 存活 / DSH job 状态镜像
 *   3) 启停                command 类用 detached 子进程启动、taskkill /T /F 停止；
 *                          port/process 类杀掉端口占用进程；job 类走 ctx.jobs.kill
 *   4) HTTP 控制台         GET  /service-console            （自带页面）
 *                          GET  /service-console/api/state  （任务表快照）
 *                          POST /service-console/api/*      （启停/登记/扫描/日志）
 *   5) GUI 按钮            webserver/index-inject 注入 launcher.js 悬浮按钮
 *   6) 模型工具            service_console（list/register/start/stop/remove/scan/adopt_job/logs）
 *
 * 零外部依赖：只用 node: 内置模块，profile 下可直接解析运行。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  appendFileSync,
} from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const HTML_FILE = join(MODULE_DIR, 'console.html')
const LAUNCHER_FILE = join(MODULE_DIR, 'launcher.js')
const ROUTE = '/service-console'

export const name = 'service-console'
export const inject = ['webServer', 'tools']

/* ────────────────────────────── 路径与持久化 ────────────────────────────── */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function dataRoot() {
  return join(dshHome(), 'storages', 'service-console')
}

function statePath() {
  return join(dataRoot(), 'registry.json')
}

function logRoot() {
  return join(dataRoot(), 'logs')
}

function emptyState() {
  return { version: 1, entries: [], events: [], lastScanAt: null, createdAt: Date.now() }
}

function normalizeEntry(entry) {
  const now = Date.now()
  const out = {
    id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
    name: typeof entry.name === 'string' && entry.name ? entry.name : '(未命名任务)',
    kind: ['port', 'command', 'process', 'job'].includes(entry.kind) ? entry.kind : 'command',
    host: typeof entry.host === 'string' && entry.host ? entry.host : '127.0.0.1',
    port: Number.isInteger(entry.port) ? entry.port : null,
    pid: Number.isInteger(entry.pid) ? entry.pid : null,
    command: typeof entry.command === 'string' ? entry.command : '',
    stopCommand: typeof entry.stopCommand === 'string' ? entry.stopCommand : '',
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    note: typeof entry.note === 'string' ? entry.note : '',
    source: typeof entry.source === 'string' ? entry.source : 'manual',
    jobId: typeof entry.jobId === 'string' ? entry.jobId : null,
    jobOwner: typeof entry.jobOwner === 'string' ? entry.jobOwner : null,
    processName: typeof entry.processName === 'string' ? entry.processName : '',
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
    history: {
      runCount: Number.isFinite(entry.history?.runCount) ? entry.history.runCount : 0,
      lastStartAt: Number.isFinite(entry.history?.lastStartAt) ? entry.history.lastStartAt : null,
      lastStopAt: Number.isFinite(entry.history?.lastStopAt) ? entry.history.lastStopAt : null,
      lastExit: typeof entry.history?.lastExit === 'string' ? entry.history.lastExit : '',
      totalRuntimeMs: Number.isFinite(entry.history?.totalRuntimeMs) ? entry.history.totalRuntimeMs : 0,
    },
    observed: {
      firstSeenAt: Number.isFinite(entry.observed?.firstSeenAt) ? entry.observed.firstSeenAt : now,
      lastSeenRunningAt: Number.isFinite(entry.observed?.lastSeenRunningAt) ? entry.observed.lastSeenRunningAt : null,
      lastSeenStoppedAt: Number.isFinite(entry.observed?.lastSeenStoppedAt) ? entry.observed.lastSeenStoppedAt : null,
      runningSince: Number.isFinite(entry.observed?.runningSince) ? entry.observed.runningSince : null,
      lastProbeAt: Number.isFinite(entry.observed?.lastProbeAt) ? entry.observed.lastProbeAt : null,
    },
    status: {
      state: entry.status?.state === 'running' ? 'running' : entry.status?.state === 'stopped' ? 'stopped' : 'unknown',
      detail: typeof entry.status?.detail === 'string' ? entry.status.detail : '',
      checkedAt: Number.isFinite(entry.status?.checkedAt) ? entry.status.checkedAt : null,
    },
  }
  return out
}

function loadState() {  const file = statePath()
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: parsed.entries.map(normalizeEntry),
        events: Array.isArray(parsed.events) ? parsed.events.slice(-400) : [],
        lastScanAt: Number.isFinite(parsed.lastScanAt) ? parsed.lastScanAt : null,
        createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : Date.now(),
      }
    }
  } catch {
    /* 首次运行或文件损坏：从空表开始，旧文件留作 .bak */
    try {
      if (existsSync(file)) renameSync(file, `${file}.bak-${Date.now()}`)
    } catch {
      /* ignore */
    }
  }
  return emptyState()
}

/** 本进程最后一次写任务表的 mtime，用于识别「磁盘被别人改过」。 */
let lastOwnWriteMtime = 0

/** 尚未落盘的本地改动计数：>0 时与磁盘合并走并集，=0 时允许磁盘全量覆盖内存。 */
let pendingMutations = 0

function saveStateNow(state) {
  try {
    mkdirSync(dataRoot(), { recursive: true })
    const file = statePath()
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
    try {
      lastOwnWriteMtime = statSync(file).mtimeMs
    } catch {
      lastOwnWriteMtime = Date.now()
    }
    pendingMutations = 0
  } catch (error) {
    console.warn(`[service-console] 任务表写入失败: ${String(error)}`)
  }
}

/**
 * 同一个 $DSH_HOME 可能被多个 DSH 实例打开（并存的自检实例、桌面端 + CLI…）。
 * 每个实例保存时整份覆盖，所以写盘前要先看磁盘：
 *   - 本进程没有待落盘改动 → 直接用磁盘内容整体替换内存（别人的删除也能传播，避免条目“复活”）；
 *   - 本进程有待落盘改动 → 按 id 并集合并，只补进磁盘上多出来的条目，不丢自己的改动。
 * @returns {number|string} 合并进来的条目数，或 'replaced'
 */
function syncFromDisk(state) {
  const file = statePath()
  let mtime
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return 0
  }
  if (mtime <= lastOwnWriteMtime) return 0
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.entries)) return 0

    if (pendingMutations === 0) {
      const before = state.entries.length
      state.entries = parsed.entries.map(normalizeEntry)
      if (Array.isArray(parsed.events)) state.events = parsed.events.slice(-400)
      if (Number.isFinite(parsed.lastScanAt)) state.lastScanAt = parsed.lastScanAt
      lastOwnWriteMtime = mtime
      if (before !== state.entries.length) console.log(`[service-console] 已同步磁盘任务表（${before} → ${state.entries.length} 条）`)
      return 'replaced'
    }

    const known = new Set(state.entries.map((entry) => entry.id))
    let added = 0
    for (const raw of parsed.entries) {
      const entry = normalizeEntry(raw)
      if (known.has(entry.id)) continue
      state.entries.push(entry)
      known.add(entry.id)
      added += 1
    }
    lastOwnWriteMtime = mtime
    if (added > 0) console.log(`[service-console] 从磁盘补入 ${added} 条（另一实例写入）`)
    return added
  } catch {
    return 0
  }
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function newId() {
  return 'svc-' + Math.random().toString(16).slice(2, 10)
}

function logEvent(state, entry, action, result) {
  state.events.push({
    t: Date.now(),
    id: entry?.id ?? null,
    name: entry?.name ?? '',
    action,
    result: String(result ?? ''),
  })
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400)
}

function rel(ms) {
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))} 秒前`
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
  return `${Math.round(diff / 86400000)} 天前`
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function tcpProbe(host, port, timeoutMs = 700) {
  return new Promise((done) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return done(false)
    const socket = new net.Socket()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      done(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try {
      socket.connect(port, host || '127.0.0.1')
    } catch {
      finish(false)
    }
  })
}

function tailFile(file, maxBytes = 65536) {
  try {
    const st = statSync(file)
    if (!st.isFile()) return ''
    const start = Math.max(0, st.size - maxBytes)
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(st.size - start)
      const read = readSync(fd, buffer, 0, buffer.length, start)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

let cachedShell
function shellBin() {
  if (cachedShell) return cachedShell
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 8000 })
    cachedShell = 'pwsh'
  } catch {
    cachedShell = 'powershell.exe'
  }
  return cachedShell
}

const SYSTEM_PROCESS = new Set([
  'system',
  'system idle process',
  'svchost.exe',
  'lsass.exe',
  'services.exe',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'dwm.exe',
  'fontdrvhost.exe',
  'spoolsv.exe',
  'mpssvc.exe',
  'searchindexer.exe',
  'sihost.exe',
  'shellexperiencehost.exe',
  'runtimebroker.exe',
  'textinputhost.exe',
  'ctfmon.exe',
])

/**
 * 扫描本机监听端口并关联进程。
 * @param {boolean} force 是否跳过 4 秒缓存
 */
function runScan(force = false) {
  const cache = runScan.cache ?? { at: 0, rows: [], error: null }
  runScan.cache = cache
  if (!force && cache.rows.length > 0 && Date.now() - cache.at < 4000) return cache

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$conns = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::1','[::1]') })",
    '$pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique)',
    '$procs = @(Get-CimInstance Win32_Process | Where-Object { $pids -contains $_.ProcessId } | Select-Object ProcessId,Name,CommandLine)',
    '@{ conns = @($conns | Select-Object LocalAddress,LocalPort,OwningProcess); procs = $procs } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ')

  let raw = ''
  try {
    raw = execFileSync(shellBin(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    cache.at = Date.now()
    cache.error = String(error?.message ?? error)
    return cache
  }

  let parsed
  try {
    parsed = JSON.parse(String(raw).trim() || '{}')
  } catch (error) {
    cache.at = Date.now()
    cache.error = `扫描结果解析失败: ${String(error)}`
    return cache
  }

  const conns = Array.isArray(parsed?.conns) ? parsed.conns : parsed?.conns ? [parsed.conns] : []
  const procs = Array.isArray(parsed?.procs) ? parsed.procs : parsed?.procs ? [parsed.procs] : []
  const byPid = new Map(procs.map((p) => [p?.ProcessId, p]))

  const seen = new Set()
  const rows = []
  for (const conn of conns) {
    const port = Number(conn?.LocalPort)
    const pid = Number(conn?.OwningProcess)
    if (!Number.isInteger(port)) continue
    const key = `${port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    const proc = byPid.get(pid)
    const procName = typeof proc?.Name === 'string' ? proc.Name : ''
    rows.push({
      port,
      address: String(conn?.LocalAddress ?? ''),
      pid: Number.isInteger(pid) ? pid : null,
      processName: procName,
      commandLine: typeof proc?.CommandLine === 'string' ? proc.CommandLine : '',
      system: SYSTEM_PROCESS.has(procName.toLowerCase()) || (port < 1024 && !/[\\/](python|node|pwsh|powershell)/i.test(String(proc?.CommandLine ?? ''))),
    })
  }
  rows.sort((a, b) => a.port - b.port)
  cache.at = Date.now()
  cache.error = null
  cache.rows = rows
  return cache
}

function pidForPort(port) {
  try {
    const out = execFileSync(
      shellBin(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -First 1).OwningProcess`],
      { encoding: 'utf8', timeout: 12000, windowsHide: true },
    )
    const pid = Number(String(out).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function killTree(pid) {
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 })
}

/* ────────────────────────────── 随包分发的 skill ────────────────────────────── */

/** 随插件分发的 task-console skill 版本；同版本不重复写盘，避免覆盖用户改过的副本。 */
const SKILL_VERSION = '1.0.0'
const SKILL_MARKER = `<!-- dsh-service-console-skill: ${SKILL_VERSION} -->`

/**
 * 把包内 `skills/task-console/` 安装到 `$DSH_HOME/skills/task-console/`。
 * DSH 的 skill provider 只扫用户/项目根，包内技能不会自动出现，所以插件装载时自带一次安装。
 * `.ps1` 落盘时补 UTF-8 BOM：Windows PowerShell 5.1 读无 BOM 的中文脚本会报语法错。
 * @returns {{installed: boolean, reason: string, path: string}}
 */
function installBundledSkill() {
  const sourceDir = join(MODULE_DIR, 'skills', 'task-console')
  const sourceFile = join(sourceDir, 'SKILL.md')
  const targetDir = join(dshHome(), 'skills', 'task-console')
  const targetFile = join(targetDir, 'SKILL.md')
  if (!existsSync(sourceFile)) return { installed: false, reason: '包内没有 skills/task-console', path: targetFile }
  try {
    const incoming = readFileSync(sourceFile, 'utf8')
    const existing = existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : ''
    const ours = existing.includes('dsh-service-console-skill:') || existing.includes('任务台（task-console）')
    if (existing.includes(SKILL_MARKER)) return { installed: false, reason: '已是当前版本', path: targetFile }
    if (existing && !ours) return { installed: false, reason: '目标位置已有别的同名 skill，保留它', path: targetFile }

    mkdirSync(join(targetDir, 'scripts'), { recursive: true })
    const body = incoming.includes(SKILL_MARKER) ? incoming : `${incoming.trimEnd()}\n\n${SKILL_MARKER}\n`
    writeFileSync(targetFile, body, 'utf8')

    const registerSource = join(sourceDir, 'scripts', 'register.ps1')
    if (existsSync(registerSource)) {
      const script = readFileSync(registerSource, 'utf8')
      writeFileSync(join(targetDir, 'scripts', 'register.ps1'), `\uFEFF${script.replace(/^\uFEFF/, '')}`, 'utf8')
    }
    return { installed: true, reason: existing ? '已升级' : '首次安装', path: targetFile }
  } catch (error) {
    return { installed: false, reason: String(error?.message ?? error), path: targetFile }
  }
}

/* ────────────────────────────── 插件主体 ────────────────────────────── */

export function apply(ctx, config = {}) {
  const options = {
    autoAdoptJobs: config?.autoAdoptJobs !== false,
    installSkill: config?.installSkill !== false,
    probeIntervalMs: Number.isFinite(config?.probeIntervalMs) && config.probeIntervalMs >= 3000 ? config.probeIntervalMs : 15000,
    stateMaxAgeMs: Number.isFinite(config?.stateMaxAgeMs) && config.stateMaxAgeMs >= 500 ? config.stateMaxAgeMs : 1500,
  }

  const state = loadState()
  const skill = options.installSkill ? installBundledSkill() : { installed: false, reason: 'config.installSkill=false', path: '' }
  let saveTimer = null
  const scheduleSave = () => {
    pendingMutations += 1
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      syncFromDisk(state)
      saveStateNow(state)
    }, 200)
    saveTimer.unref?.()
  }

  const jobs = ctx.get('jobs')
  /** DSH 后台任务镜像：id → 最后一次看到的 JobView */
  const jobMirror = new Map()

  const recordJob = (view) => {
    if (!view || typeof view.id !== 'string') return
    const prev = jobMirror.get(view.id)
    jobMirror.set(view.id, {
      id: view.id,
      kind: view.kind,
      label: view.label,
      status: view.status,
      detail: view.progress ?? view.detail ?? '',
      owner: view.owner ?? prev?.owner ?? null,
      startedAt: view.startedAt,
      finishedAt: view.finishedAt ?? null,
    })
  }

  /** job 的 label 常常是一整条 shell 命令，任务表里只留一个能认出用途的短名。 */
  const jobNameOf = (view) => {
    const label = String(view?.label ?? '').replace(/\s+/g, ' ').trim()
    if (!label) return String(view?.id ?? 'background job')
    return label.length > 64 ? `${label.slice(0, 64)}…` : label
  }

  const seedJobs = () => {
    if (!jobs) return
    try {
      for (const view of jobs.list()) recordJob(view)
    } catch {
      /* ignore */
    }
    const agents = ctx.get('agents')
    try {
      for (const agent of agents?.list?.() ?? []) {
        try {
          for (const view of jobs.list(agent.id)) recordJob(view)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const autoAdoptJobs = () => {
    if (!options.autoAdoptJobs) return
    let changed = false
    for (const view of jobMirror.values()) {
      // 只自动收编「还在跑」的任务：历史 job 是海量的，交给“导入历史后台任务”按钮按需拉取
      if (view.status !== 'running' && view.status !== 'stopping') continue
      const exists = state.entries.some((entry) => entry.kind === 'job' && entry.jobId === view.id)
      if (exists) continue
      const entry = normalizeEntry({
        id: newId(),
        name: jobNameOf(view),
        kind: 'job',
        jobId: view.id,
        jobOwner: view.owner ?? null,
        source: 'auto-job',
        note: `${view.kind} 后台任务，自动登记`,
      })
      entry.status = { state: 'running', detail: `${view.kind} · ${view.status}`, checkedAt: Date.now() }
      entry.observed.lastSeenRunningAt = Date.now()
      entry.observed.runningSince = Date.now()
      state.entries.push(entry)
      logEvent(state, entry, 'auto-adopt', view.id)
      changed = true
    }
    if (changed) scheduleSave()
  }

  /** 按需把当前可见的历史后台任务（已结束的）导进任务表。 */
  const importHistoricalJobs = () => {
    seedJobs()
    let added = 0
    for (const view of jobMirror.values()) {
      if (state.entries.some((entry) => entry.kind === 'job' && entry.jobId === view.id)) continue
      const live = view.status === 'running' || view.status === 'stopping'
      const entry = normalizeEntry({
        id: newId(),
        name: jobNameOf(view),
        kind: 'job',
        jobId: view.id,
        jobOwner: view.owner ?? null,
        source: 'job-history',
        note: `${view.kind} 后台任务（历史导入）`,
      })
      entry.status = { state: live ? 'running' : 'stopped', detail: `${view.kind} · ${view.status}${view.detail ? ` · ${view.detail}` : ''}`, checkedAt: Date.now() }
      if (Number.isFinite(view.startedAt)) {
        entry.history.lastStartAt = view.startedAt
        entry.observed.lastSeenRunningAt = live ? Date.now() : view.startedAt
      }
      if (Number.isFinite(view.finishedAt)) entry.history.lastStopAt = view.finishedAt
      state.entries.push(entry)
      added += 1
    }
    if (added > 0) {
      logEvent(state, null, 'import-history', `${added} 个历史任务`)
      scheduleSave()
    }
    return added
  }

  /**
   * 清掉自动收编的“噪声”：从未被观测到在跑的空壳，以及观测存活不足 60 秒的临时命令。
   * 真正跑过一阵子的任务会留下来，变成“以前在跑，现在停了”。
   */
  const pruneAutoEntries = () => {
    const before = state.entries.length
    for (let i = state.entries.length - 1; i >= 0; i -= 1) {
      const entry = state.entries[i]
      if (entry.source !== 'auto-job') continue
      const view = entry.jobId ? jobMirror.get(entry.jobId) : null
      const live = view && (view.status === 'running' || view.status === 'stopping')
      if (live) continue
      if (!entry.observed.lastSeenRunningAt) {
        state.entries.splice(i, 1)
        continue
      }
      if (entry.history.totalRuntimeMs < 60000) state.entries.splice(i, 1)
    }
    if (state.entries.length !== before) scheduleSave()
  }

  if (jobs?.events?.subscribe) {
    ctx.effect(() => {
      const dispose = jobs.events.subscribe({ owners: 'scope' }, (event) => {
        try {
          if (event?.type === 'removed') {
            jobMirror.delete(event.job?.id)
            return
          }
          if (event?.job) recordJob(event.job)
          autoAdoptJobs()
        } catch {
          /* ignore */
        }
      })
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }
    })
  }

  /* ── 探活 ── */

  const computeStatus = async (entry) => {
    const now = Date.now()
    if (entry.kind === 'job') {
      const view = entry.jobId ? jobMirror.get(entry.jobId) : null
      if (view) {
        if (view.status === 'running' || view.status === 'stopping') {
          return { state: 'running', detail: `${view.kind} · ${view.status}`, checkedAt: now }
        }
        return { state: 'stopped', detail: `${view.kind} · ${view.status}${view.detail ? ` · ${view.detail}` : ''}`, checkedAt: now }
      }
      return {
        state: entry.observed.lastSeenRunningAt ? 'stopped' : 'unknown',
        detail: entry.observed.lastSeenRunningAt ? '已结束（当前注册表里查不到这个 job）' : '任务已不在当前注册表（宿主可能重启过）',
        checkedAt: now,
      }
    }

    if (entry.port) {
      const ok = await tcpProbe(entry.host || '127.0.0.1', entry.port)
      if (ok) return { state: 'running', detail: `${entry.host || '127.0.0.1'}:${entry.port} 可连接`, checkedAt: now }
      if (entry.pid && pidAlive(entry.pid) && entry.kind !== 'port') {
        return { state: 'running', detail: `pid ${entry.pid} 存活（端口未监听）`, checkedAt: now }
      }
      return { state: 'stopped', detail: `${entry.host || '127.0.0.1'}:${entry.port} 无监听`, checkedAt: now }
    }

    if (entry.pid) {
      const alive = pidAlive(entry.pid)
      return {
        state: alive ? 'running' : 'stopped',
        detail: alive ? `pid ${entry.pid} 存活${entry.processName ? ` (${entry.processName})` : ''}` : `pid ${entry.pid} 已退出`,
        checkedAt: now,
      }
    }

    if (entry.command) return { state: 'stopped', detail: '有启动命令但未运行', checkedAt: now }
    return { state: 'unknown', detail: '未登记端口 / pid / 命令', checkedAt: now }
  }

  const refreshEntries = async (maxAgeMs = options.stateMaxAgeMs) => {
    const now = Date.now()
    const pending = state.entries.filter((entry) => !entry.status.checkedAt || now - entry.status.checkedAt > maxAgeMs)
    if (pending.length === 0) return
    const results = await Promise.all(pending.map((entry) => computeStatus(entry).catch(() => ({ state: 'unknown', detail: '探活失败', checkedAt: Date.now() }))))
    let changed = false
    pending.forEach((entry, index) => {
      const next = results[index]
      const before = entry.status.state
      entry.status = next
      entry.observed.lastProbeAt = next.checkedAt
      if (next.state === 'running') {
        entry.observed.lastSeenRunningAt = next.checkedAt
        if (!entry.observed.runningSince) entry.observed.runningSince = next.checkedAt
      } else if (next.state === 'stopped') {
        entry.observed.lastSeenStoppedAt = next.checkedAt
        if (entry.observed.runningSince) {
          entry.history.lastStopAt = next.checkedAt
          entry.history.totalRuntimeMs += Math.max(0, next.checkedAt - entry.observed.runningSince)
          entry.observed.runningSince = null
        }
      }
      if (before !== next.state) changed = true
    })
    if (changed) scheduleSave()
  }

  const categoryOf = (entry) => {
    if (entry.status.state === 'running') return 'running'
    if (entry.observed.lastSeenRunningAt) return 'stopped-before'
    return 'never'
  }

  const serializeEntry = (entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    host: entry.host,
    port: entry.port,
    pid: entry.pid,
    command: entry.command,
    stopCommand: entry.stopCommand,
    cwd: entry.cwd,
    note: entry.note,
    description: entry.note,
    source: entry.source,
    jobId: entry.jobId,
    processName: entry.processName,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    status: entry.status,
    category: categoryOf(entry),
    history: entry.history,
    observed: entry.observed,
  })

  const summaryOf = () => {
    const out = { total: state.entries.length, running: 0, stoppedBefore: 0, never: 0, unknown: 0 }
    for (const entry of state.entries) {
      const category = categoryOf(entry)
      if (category === 'running') out.running += 1
      else if (category === 'stopped-before') out.stoppedBefore += 1
      else if (category === 'never') out.never += 1
      else out.unknown += 1
    }
    return out
  }

  const findEntry = (id) => state.entries.find((entry) => entry.id === id)

  /* ── 动作 ── */

  const actionStart = async (entry) => {
    if (entry.kind === 'job') throw new Error('DSH 后台任务由会话/工具启动，控制台只能停止；需要重启请登记一条 command 任务')
    if (entry.port && !entry.command) {
      if (await tcpProbe(entry.host || '127.0.0.1', entry.port)) return '端口已在监听，无需启动'
      throw new Error('这条任务只登记了端口，没有启动命令；请先编辑补上 command')
    }
    const command = String(entry.command || '').trim()
    if (!command) throw new Error('缺少启动命令')
    if (entry.pid && pidAlive(entry.pid)) throw new Error(`已经在跑（pid ${entry.pid}）`)
    const cwd = entry.cwd && isAbsolute(entry.cwd) ? entry.cwd : process.cwd()
    if (!existsSync(cwd)) throw new Error(`工作目录不存在: ${cwd}`)

    mkdirSync(logRoot(), { recursive: true })
    const logFile = join(logRoot(), `${entry.id}.log`)
    const scriptFile = join(logRoot(), `${entry.id}.ps1`)
    appendFileSync(logFile, `\n===== ${new Date().toISOString()} 启动 =====\n> cd ${cwd}\n> ${command}\n`, 'utf8')

    // 命令写进 .ps1 再 -File 执行：绕开 -Command 的引号/转义地狱，报错也能完整落进日志
    const scriptBody = [
      `# dsh-service-console · ${entry.name}`,
      `$ErrorActionPreference = 'Continue'`,
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
      `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
      `$env:PYTHONIOENCODING = 'utf-8'`,
      `$env:PYTHONUTF8 = '1'`,
      `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`,
      command,
      ``,
    ].join('\r\n')
    writeFileSync(scriptFile, scriptBody, 'utf8')

    // 实测：Windows 上 detached 的子进程会被父进程所在的 Job 立刻回收（spawn 返回 pid 但不落地）。
    // 改用 WMI Win32_Process.Create —— 由 WMI 服务创建进程，真正脱离当前进程的作业对象，
    // 输出经 cmd 重定向落到日志文件；taskkill /T 仍能顺着 cmd 杀掉整棵进程树。
    const inner = `cmd.exe /c powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptFile}" >> "${logFile}" 2>&1`
    const psInvoke = [
      `$ErrorActionPreference='Stop'`,
      `$arg = @{ CommandLine = '${inner.replace(/'/g, "''")}'; CurrentDirectory = '${cwd.replace(/'/g, "''")}' }`,
      `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arg`,
      `"$($res.ReturnValue) $($res.ProcessId)"`,
    ].join('; ')

    let pid = null
    try {
      const out = execFileSync(shellBin(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psInvoke], {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      })
      const [rc, rawPid] = String(out).trim().split(/\s+/)
      if (rc === '0' && Number(rawPid) > 0) pid = Number(rawPid)
    } catch {
      pid = null
    }

    if (!pid) {
      // 兜底：普通子进程（随宿主存活），输出用管道回填日志
      const child = spawn(shellBin(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk) => appendFileSync(logFile, chunk))
      child.stderr?.on('data', (chunk) => appendFileSync(logFile, chunk))
      child.unref()
      pid = child.pid ?? null
    }

    if (!pid) throw new Error('进程创建失败：WMI 与 spawn 都没有返回 pid')

    entry.pid = pid
    entry.history.runCount += 1
    entry.history.lastStartAt = Date.now()
    entry.history.lastExit = ''
    entry.status = { state: 'running', detail: `已启动 pid ${entry.pid ?? '?'}`, checkedAt: Date.now() }
    entry.observed.lastSeenRunningAt = Date.now()
    entry.observed.runningSince = Date.now()
    logEvent(state, entry, 'start', `pid ${entry.pid ?? '?'}`)
    scheduleSave()
    return `已启动，pid ${entry.pid ?? '?'}，日志 ${logFile}`
  }

  /** 任务自带的停止命令（优于 taskkill）：写成 .ps1 同步执行，输出落在独立的 .stop.log。 */
  const runStopCommand = (entry) => {
    const command = String(entry.stopCommand || '').trim()
    if (!command) return { ok: true, output: '', skipped: true }
    const cwd = entry.cwd && isAbsolute(entry.cwd) && existsSync(entry.cwd) ? entry.cwd : process.cwd()
    mkdirSync(logRoot(), { recursive: true })
    const scriptFile = join(logRoot(), `${entry.id}.stop.ps1`)
    // 服务进程用 `>> 主日志` 重定向持有该文件句柄，Windows 上再写会 EBUSY；停止日志单独落盘
    const stopLog = join(logRoot(), `${entry.id}.stop.log`)
    writeFileSync(
      scriptFile,
      [
        `# dsh-service-console stop · ${entry.name}`,
        `$ErrorActionPreference = 'Continue'`,
        `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`,
        command,
        ``,
      ].join('\r\n'),
      'utf8',
    )
    const mark = (text) => {
      try {
        appendFileSync(stopLog, text, 'utf8')
      } catch {
        /* 日志写不进去不能拖垮停止流程 */
      }
    }
    mark(`\n===== ${new Date().toISOString()} 停止命令 =====\n> ${command}\n`)
    try {
      const out = execFileSync(shellBin(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        cwd,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      })
      mark(String(out ?? ''))
      return { ok: true, output: String(out ?? '') }
    } catch (error) {
      const message = String(error?.stdout ?? '') + String(error?.stderr ?? '') + String(error?.message ?? error)
      mark(`[stop-command 失败] ${message}\n`)
      return { ok: false, output: message }
    }
  }

  /** 统一收尾：清 pid、记历史、写状态。 */
  const finishStopped = (entry, detail, lastExit) => {
    entry.pid = null
    entry.history.lastStopAt = Date.now()
    entry.history.lastExit = lastExit
    entry.status = { state: 'stopped', detail, checkedAt: Date.now() }
    entry.observed.lastSeenStoppedAt = Date.now()
    if (entry.observed.runningSince) {
      entry.history.totalRuntimeMs += Math.max(0, Date.now() - entry.observed.runningSince)
      entry.observed.runningSince = null
    }
  }

  const actionStop = async (entry) => {
    if (entry.kind === 'job') {
      if (!jobs) throw new Error('当前进程没有 jobs 服务')
      if (!entry.jobId) throw new Error('缺少 job id')
      const result = jobs.kill(entry.jobId, entry.jobOwner ?? undefined, '由服务控制台停止')
      logEvent(state, entry, 'stop', `job ${result}`)
      scheduleSave()
      return result === 'requested' ? `已请求停止 ${entry.jobId}` : `${entry.jobId} 已经结束`
    }

    const notes = []
    // 端口占用者最权威（可能和登记的壳进程 pid 不同），再叠加登记 pid，两个都当目标
    const portPid = entry.port ? pidForPort(entry.port) : null
    const ownPid = entry.pid && pidAlive(entry.pid) ? entry.pid : null
    const pids = [...new Set([portPid, ownPid].filter(Boolean))]

    const stillAlive = async () => {
      if (entry.port && (await tcpProbe(entry.host || '127.0.0.1', entry.port))) return true
      return pids.some((p) => pidAlive(p))
    }

    if (entry.stopCommand) {
      const result = runStopCommand(entry)
      notes.push(result.ok ? '已执行停止命令' : `停止命令失败（${result.output.slice(0, 160)}）`)
      for (let i = 0; i < 12 && (await stillAlive()); i += 1) await sleep(500)
      if (!(await stillAlive())) {
        const detail = notes.join(' · ')
        finishStopped(entry, `${detail}；已停止`, 'stop-command')
        logEvent(state, entry, 'stop', `stop-command ${entry.id}`)
        scheduleSave()
        return `${detail}；已停止`
      }
      notes.push('进程未退出，回退 taskkill')
    }

    if (pids.length === 0) {
      const detail = notes.length ? notes.join(' · ') : '没有可停止的进程'
      entry.status = { state: 'stopped', detail, checkedAt: Date.now() }
      scheduleSave()
      return notes.length ? `${detail}；没有找到在跑的进程` : '没有找到在跑的进程（可能已经停止）'
    }

    const killed = []
    for (const target of pids) {
      if (!pidAlive(target)) continue
      try {
        killTree(target)
        killed.push(target)
      } catch (error) {
        // 同一棵进程树里先杀掉的子进程会让后面的 taskkill 报错；进程确实没了就不算失败
        if (pidAlive(target)) notes.push(`taskkill ${target} 失败（${String(error?.message ?? error).slice(0, 80)}）`)
        else killed.push(target)
      }
    }
    const pidText = (killed.length > 0 ? killed : pids).join(' / ')
    const detail = `${notes.length ? `${notes.join(' · ')}；` : ''}已停止 pid ${pidText}`
    finishStopped(entry, detail, 'killed by console')
    logEvent(state, entry, 'stop', `taskkill ${pidText}`)
    scheduleSave()
    return notes.length ? `${notes.join(' · ')}；已 taskkill ${pidText}` : `已停止（pid ${pidText}）`
  }

  const actionAdd = (payload) => {
    const entry = normalizeEntry({
      name: payload.name,
      kind: payload.kind,
      host: payload.host,
      port: Number.isInteger(payload.port) ? payload.port : null,
      command: payload.command,
      stopCommand: payload.stopCommand,
      cwd: payload.cwd,
      note: payload.note ?? payload.description,
      source: payload.source ?? 'manual',
      jobId: payload.jobId,
      jobOwner: payload.jobOwner,
      processName: payload.processName,
      pid: Number.isInteger(payload.pid) ? payload.pid : null,
    })
    state.entries.push(entry)
    logEvent(state, entry, 'register', entry.kind)
    scheduleSave()
    return entry
  }

  const actionRemove = (entry) => {
    const index = state.entries.indexOf(entry)
    if (index >= 0) state.entries.splice(index, 1)
    logEvent(state, entry, 'remove', entry.name)
    scheduleSave()
  }

  const actionUpdate = (entry, patch) => {
    if (typeof patch.name === 'string') entry.name = patch.name.trim() || entry.name
    if (typeof patch.command === 'string') entry.command = patch.command
    if (typeof patch.stopCommand === 'string') entry.stopCommand = patch.stopCommand
    if (typeof patch.cwd === 'string') entry.cwd = patch.cwd
    if (typeof patch.note === 'string') entry.note = patch.note
    else if (typeof patch.description === 'string') entry.note = patch.description
    if (typeof patch.host === 'string' && patch.host) entry.host = patch.host
    if (Number.isInteger(patch.port)) entry.port = patch.port
    entry.updatedAt = Date.now()
    logEvent(state, entry, 'update', Object.keys(patch).join(','))
    scheduleSave()
    return entry
  }

  const actionAdoptJob = (jobId) => {
    const view = jobMirror.get(jobId)
    if (!view) throw new Error(`没有看到后台任务 ${jobId}（只能登记当前进程内可见的任务）`)
    const exists = state.entries.find((entry) => entry.kind === 'job' && entry.jobId === jobId)
    if (exists) return exists
    const entry = actionAdd({
      name: jobNameOf(view),
      kind: 'job',
      jobId: view.id,
      jobOwner: view.owner ?? null,
      source: 'job',
      note: `手动登记：${view.kind} 后台任务`,
    })
    return entry
  }

  const jobRows = () =>
    [...jobMirror.values()]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .map((view) => ({
        ...view,
        registered: state.entries.some((entry) => entry.kind === 'job' && entry.jobId === view.id),
      }))

  /* ── HTTP ── */

  const sendJson = (res, code, value) => {
    const body = JSON.stringify(value)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const sendFile = (res, file, type) => {
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': body.length })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`读取失败: ${String(error)}`)
    }
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 1024 * 1024) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const originAccepted = (req) => {
    const remote = String(req.socket?.remoteAddress ?? '')
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (loopback) return true
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.replace(/\/+$/, '') || ROUTE

          if (path === ROUTE || path === `${ROUTE}/`) {
            return sendFile(res, HTML_FILE, 'text/html; charset=utf-8')
          }
          if (path === `${ROUTE}/launcher.js`) {
            return sendFile(res, LAUNCHER_FILE, 'application/javascript; charset=utf-8')
          }
          if (!path.startsWith(`${ROUTE}/api/`)) {
            sendJson(res, 404, { ok: false, error: 'not found' })
            return
          }
          if (req.method === 'POST' && !originAccepted(req)) {
            sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
            return
          }

          const op = path.slice(`${ROUTE}/api/`.length)

          if (op === 'state' && req.method !== 'POST') {
            syncFromDisk(state)
            seedJobs()
            autoAdoptJobs()
            await refreshEntries()
            const scan = runScan(false)
            sendJson(res, 200, {
              ok: true,
              now: Date.now(),
              summary: summaryOf(),
              entries: state.entries
                .map(serializeEntry)
                .sort((a, b) => (a.category === b.category ? b.updatedAt - a.updatedAt : a.category.localeCompare(b.category))),
              jobs: jobRows(),
              events: state.events.slice(-60).reverse(),
              scan: { at: scan.at, error: scan.error, rows: scan.rows },
              route: ROUTE,
            })
            return
          }

          const raw = req.method === 'POST' ? await readBody(req) : ''
          let payload = {}
          try {
            payload = raw.trim() ? JSON.parse(raw) : {}
          } catch {
            sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }

          if (op === 'refresh') {
            await refreshEntries(0)
            sendJson(res, 200, { ok: true, summary: summaryOf(), entries: state.entries.map(serializeEntry) })
            return
          }
          if (op === 'scan') {
            const scan = runScan(true)
            sendJson(res, 200, { ok: true, at: scan.at, error: scan.error, rows: scan.rows })
            return
          }
          if (op === 'entry/add') {
            if (typeof payload.name !== 'string' || payload.name.trim().length === 0) throw new Error('缺少任务名')
            const entry = actionAdd({
              ...payload,
              name: payload.name.trim(),
              port: Number.isInteger(payload.port) ? payload.port : payload.port ? Number(payload.port) : null,
            })
            await refreshEntries(0)
            sendJson(res, 200, { ok: true, entry: serializeEntry(entry) })
            return
          }
          if (op === 'entry/update') {
            const entry = findEntry(String(payload.id ?? ''))
            if (!entry) throw new Error('任务不存在')
            actionUpdate(entry, payload.patch ?? payload)
            sendJson(res, 200, { ok: true, entry: serializeEntry(entry) })
            return
          }
          if (op === 'entry/remove') {
            const entry = findEntry(String(payload.id ?? ''))
            if (!entry) throw new Error('任务不存在')
            actionRemove(entry)
            sendJson(res, 200, { ok: true })
            return
          }
          if (op === 'entry/start') {
            const entry = findEntry(String(payload.id ?? ''))
            if (!entry) throw new Error('任务不存在')
            const message = await actionStart(entry)
            await refreshEntries(0)
            sendJson(res, 200, { ok: true, message, entry: serializeEntry(entry) })
            return
          }
          if (op === 'entry/stop') {
            const entry = findEntry(String(payload.id ?? ''))
            if (!entry) throw new Error('任务不存在')
            const message = await actionStop(entry)
            await refreshEntries(0)
            sendJson(res, 200, { ok: true, message, entry: serializeEntry(entry) })
            return
          }
          if (op === 'entry/restart') {
            const entry = findEntry(String(payload.id ?? ''))
            if (!entry) throw new Error('任务不存在')
            try {
              await actionStop(entry)
            } catch (error) {
              console.warn(`[service-console] 重启前停止失败: ${String(error)}`)
            }
            await new Promise((r) => setTimeout(r, 600))
            const message = await actionStart(entry)
            await refreshEntries(0)
            sendJson(res, 200, { ok: true, message, entry: serializeEntry(entry) })
            return
          }
          if (op === 'entry/logs') {
            const entry = findEntry(String(payload.id ?? url.searchParams.get('id') ?? ''))
            if (!entry) throw new Error('任务不存在')
            const file = join(logRoot(), `${entry.id}.log`)
            const stopFile = join(logRoot(), `${entry.id}.stop.log`)
            const main = tailFile(file, 120000)
            const stopText = tailFile(stopFile, 40000)
            const text = stopText.trim() ? `${main}\n\n===== 停止命令日志 =====\n${stopText}` : main
            sendJson(res, 200, { ok: true, id: entry.id, file, stopFile, text })
            return
          }
          if (op === 'job/adopt') {
            const entry = actionAdoptJob(String(payload.jobId ?? ''))
            sendJson(res, 200, { ok: true, entry: serializeEntry(entry) })
            return
          }
          if (op === 'job/kill') {
            if (!jobs) throw new Error('当前进程没有 jobs 服务')
            const jobId = String(payload.jobId ?? '')
            const view = jobMirror.get(jobId)
            const result = jobs.kill(jobId, view?.owner ?? undefined, '由服务控制台停止')
            logEvent(state, { id: jobId, name: view?.label ?? jobId }, 'job-kill', result)
            scheduleSave()
            sendJson(res, 200, { ok: true, message: result === 'requested' ? `已请求停止 ${jobId}` : `${jobId} 已经结束` })
            return
          }
          if (op === 'jobs/seed') {
            seedJobs()
            autoAdoptJobs()
            sendJson(res, 200, { ok: true, jobs: jobRows() })
            return
          }
          if (op === 'jobs/import') {
            const added = importHistoricalJobs()
            sendJson(res, 200, { ok: true, added, message: added > 0 ? `导入了 ${added} 个历史后台任务` : '没有新的历史任务可导入' })
            return
          }
          if (op === 'reset') {
            const count = state.entries.length
            state.entries.length = 0
            logEvent(state, null, 'reset', `清空 ${count} 条`)
            saveStateNow(state)
            sendJson(res, 200, { ok: true, message: `任务表已清空（${count} 条）` })
            return
          }
          sendJson(res, 404, { ok: false, error: `未知操作 ${op}` })
        } catch (error) {
          try {
            sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          } catch {
            /* ignore */
          }
        }
      },
    }),
  )

  /* ── GUI 悬浮按钮 ── */

  ctx.effect(() =>
    ctx.webServer.tapIndex((html) => {
      const tag = `<script src="${ROUTE}/launcher.js" defer data-service-console="1"></script>`
      if (typeof html !== 'string' || html.includes('data-service-console')) return html
      return html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : `${html}\n${tag}`
    }),
  )

  /* ── 模型工具 ── */

  const TOOL_NAME = 'service_console'
  const TOOL_DESCRIPTION =
    '本机服务控制台：登记 / 启停 / 查看本机长期运行的服务与后台任务。任务台代码规范要求每个任务都带 name、description、cwd、启动命令、停止方式与探活端口；启动任何长期运行的服务后，用 action=register 登记进任务表，用户在 Web GUI 的“任务台”（task-console skill）里就能看到并一键启停。'

  const PROMPT = [
    '本机有一个服务控制台（service_console 工具 + Web GUI 右下角“任务台”按钮 + /service-console 页面）。',
    '登记规范（task-console）：任何长期运行的进程/服务（后台 job、dev server、面板、轮询/定时脚本）都必须登记成任务表的一条任务，字段齐全：name（认得出用途）、description（干什么、谁在用、注意事项）、cwd（绝对路径）、command（启动命令）、stop_command（任务自带停止脚本，没有就留空走 taskkill）、port（能探活就填）。',
    '启停：action=start / stop / restart（job 类 stop 走 jobs.kill；command 类优先执行 stop_command，失败或没有才 taskkill 进程树）。',
    '登记前先 action=list 去重，不要为已在表里的任务重复登记；改配置用 action=list 拿到 id 后让用户或脚本走 API entry/update。',
  ].join('\n')

  const promptService = ctx.get('systemPrompt')
  if (promptService?.section) {
    try {
      promptService.section({ name: 'tool:service-console', text: PROMPT })
    } catch {
      /* 不同版本的 section 签名差异不阻塞主功能 */
    }
  }

  const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
    },
    required: ['ok', 'text'],
  }

  const renderList = () => {
    if (state.entries.length === 0) return '任务表为空。'
    const lines = state.entries.map((entry) => {
      const category = categoryOf(entry)
      const tag = category === 'running' ? '在跑' : category === 'stopped-before' ? '以前在跑，现在停了' : '从未观测到在跑'
      const addr = entry.port ? ` ${entry.host}:${entry.port}` : ''
      const cmd = entry.command ? ` cmd=${entry.command}` : ''
      const last = entry.observed.lastSeenRunningAt ? ` 上次在跑 ${rel(entry.observed.lastSeenRunningAt)}` : ''
      return `- ${entry.id} [${entry.kind}] ${entry.name}${addr} — ${tag}${last}${cmd}`
    })
    const summary = summaryOf()
    return `共 ${summary.total} 条：在跑 ${summary.running}，以前在跑现在停了 ${summary.stoppedBefore}，从未启动 ${summary.never}\n${lines.join('\n')}`
  }

  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'register', 'start', 'stop', 'restart', 'remove', 'scan', 'adopt_job', 'logs'],
          description: 'list 列表；register 登记；start/stop/restart 启停；remove 删除；scan 扫描本机监听端口；adopt_job 把 DSH 后台任务登记进表；logs 读日志',
        },
        id: { type: 'string', description: '任务 id（start/stop/restart/remove/logs）' },
        name: { type: 'string', description: '任务名称（register）' },
        kind: { type: 'string', enum: ['command', 'port', 'process', 'job'], description: '任务类型，默认 command' },
        command: { type: 'string', description: '启动命令（PowerShell 语法），用于启动 command 类任务' },
        stop_command: { type: 'string', description: '停止命令（可选，优先于 taskkill）：任务自带的 stop 脚本，例如 python stop.py' },
        description: { type: 'string', description: '任务用途描述（必填推荐）：干什么的、谁在用、注意事项' },
        cwd: { type: 'string', description: '工作目录（绝对路径）' },
        port: { type: 'integer', description: '监听端口（用于探活）' },
        host: { type: 'string', description: '探活地址，默认 127.0.0.1' },
        note: { type: 'string', description: '备注' },
        job_id: { type: 'string', description: 'DSH 后台任务 id（adopt_job）' },
      },
      required: ['action'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }]
      },
    },
    async execute(args) {
      try {
        const action = String(args?.action ?? '')
        if (action === 'list') {
          await refreshEntries()
          return { ok: true, text: renderList() }
        }
        if (action === 'register') {
          const entry = actionAdd({
            name: String(args.name ?? '').trim() || '(未命名任务)',
            kind: ['command', 'port', 'process', 'job'].includes(args.kind) ? args.kind : 'command',
            command: String(args.command ?? ''),
            stopCommand: String(args.stop_command ?? ''),
            cwd: String(args.cwd ?? ''),
            port: Number.isInteger(args.port) ? args.port : null,
            host: String(args.host ?? '127.0.0.1'),
            note: String(args.description ?? args.note ?? ''),
            jobId: typeof args.job_id === 'string' ? args.job_id : null,
            source: 'agent',
          })
          await refreshEntries(0)
          return { ok: true, text: `已登记 ${entry.id} ${entry.name}（当前状态：${entry.status.detail}）` }
        }
        if (action === 'scan') {
          const scan = runScan(true)
          const rows = scan.rows.filter((row) => !row.system).slice(0, 40)
          const text = rows.length
            ? rows.map((row) => `- ${row.port} (${row.processName || 'unknown'}${row.pid ? ` pid ${row.pid}` : ''}) ${row.commandLine.slice(0, 160)}`).join('\n')
            : '没扫到非系统监听端口。'
          return { ok: true, text: `本机监听端口（非系统）：\n${text}` }
        }
        if (action === 'adopt_job') {
          seedJobs()
          const entry = actionAdoptJob(String(args.job_id ?? ''))
          return { ok: true, text: `已把 ${entry.jobId} 登记为任务 ${entry.id}（${entry.name}）` }
        }
        const entry = findEntry(String(args.id ?? ''))
        if (!entry) return { ok: false, text: `任务不存在: ${args.id ?? '(缺 id)'}` }
        if (action === 'start') return { ok: true, text: await actionStart(entry) }
        if (action === 'stop') return { ok: true, text: await actionStop(entry) }
        if (action === 'restart') {
          try {
            await actionStop(entry)
          } catch (error) {
            console.warn(`[service-console] 重启前停止失败: ${String(error)}`)
          }
          await new Promise((r) => setTimeout(r, 600))
          return { ok: true, text: await actionStart(entry) }
        }
        if (action === 'remove') {
          actionRemove(entry)
          return { ok: true, text: `已删除 ${entry.id}` }
        }
        if (action === 'logs') {
          const main = tailFile(join(logRoot(), `${entry.id}.log`), 40000)
          const stop = tailFile(join(logRoot(), `${entry.id}.stop.log`), 12000)
          const text = stop.trim() ? `${main}\n\n===== 停止命令日志 =====\n${stop}` : main
          return { ok: true, text: text || '（暂无日志，command 类任务启动后才会写日志）' }
        }
        return { ok: false, text: `未知 action: ${action}` }
      } catch (error) {
        return { ok: false, text: String(error?.message ?? error) }
      }
    },
  })

  /* ── 后台探活循环 ── */

  ctx.effect(() => {
    const tick = () => {
      syncFromDisk(state)
      seedJobs()
      autoAdoptJobs()
      pruneAutoEntries()
      refreshEntries(0).catch(() => {})
    }
    const handle = setInterval(tick, options.probeIntervalMs)
    handle.unref?.()
    const first = setTimeout(tick, 1200)
    first.unref?.()
    return () => {
      clearInterval(handle)
      clearTimeout(first)
      saveStateNow(state)
    }
  })

  ctx.effect(() => () => saveStateNow(state))

  console.log(`[service-console] 已装载：${ROUTE} · 任务表 ${statePath()} · 现有 ${state.entries.length} 条 · skill: ${skill.installed ? `已${skill.reason}` : skill.reason}`)
}
