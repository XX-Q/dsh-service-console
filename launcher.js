/**
 * dsh-service-console · GUI 注入脚本
 * 由 webserver/index-inject（tapIndex）注入到 DSH Web GUI 的 index.html。
 *
 * 交互：
 *   右下角「任务台」胶囊按钮 → 默认在当前页弹出任务台（iframe + 遮罩）
 *   弹层里：放大到全屏（Fullscreen API）/ 在新页面打开 / 关闭（ESC 也可）
 *   胶囊右侧小箭头 → 选「弹窗打开 / 新标签打开」，选择记在 localStorage
 *
 * 约束：经典脚本、无构建、无依赖、重复注入幂等、样式走 Shadow DOM 不污染宿主。
 */
(() => {
  if (window.__dshServiceConsoleLauncher) return
  window.__dshServiceConsoleLauncher = true

  const script = document.currentScript
  let base = '/service-console'
  try {
    if (script && script.src) {
      const url = new URL(script.src)
      base = url.pathname.replace(/\/launcher\.js$/, '').replace(/\/+$/, '') || '/service-console'
    }
  } catch {
    /* 保持默认 */
  }
  const api = base + '/api'
  const pageUrl = (embed) => `${base}${embed ? '?embed=1' : ''}`
  const MODE_KEY = 'dsh-service-console-open-mode'
  const readMode = () => {
    try {
      return localStorage.getItem(MODE_KEY) === 'tab' ? 'tab' : 'popup'
    } catch {
      return 'popup'
    }
  }
  const writeMode = (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      /* ignore */
    }
  }

  const host = document.createElement('div')
  host.id = 'dsh-service-console-launcher'
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;pointer-events:none;'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      .wrap { pointer-events: auto; display: flex; align-items: center; gap: 6px;
        font: 12px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #dfe7ef; }
      .pillgroup { display: inline-flex; align-items: stretch; border-radius: 999px; overflow: hidden;
        border: 1px solid #2b3d50; box-shadow: 0 6px 22px rgba(0,0,0,.45);
        background: rgba(18, 26, 36, .94); backdrop-filter: blur(8px); }
      button.pill, button.caret {
        display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border: 0;
        color: #dfe7ef; background: transparent; font: inherit; padding: 8px 13px;
        transition: background .12s ease;
      }
      button.caret { padding: 8px 9px 8px 4px; color: #8ea3b6; }
      button.pill:hover, button.caret:hover { background: rgba(46, 70, 96, .55); color: #fff; }
      .icon { width: 14px; height: 14px; fill: currentColor; opacity: .92; }
      .label { letter-spacing: .3px; }
      .counts { display: inline-flex; gap: 5px; margin-left: 2px; }
      .tag { font-variant-numeric: tabular-nums; padding: 1px 7px; border-radius: 999px; font-size: 11px;
        border: 1px solid #2b3d50; color: #8497a8; }
      .tag.run { color: #3ddc97; border-color: #245c46; background: #10231b; }
      .tag.past { color: #f2b544; border-color: #5c4a24; background: #241f10; }
      .tag.off { display: none; }
      .hint { opacity: 0; transform: translateX(4px); transition: .15s; color: #8497a8; font-size: 11px;
        background: rgba(18, 26, 36, .94); border: 1px solid #2b3d50; border-radius: 8px; padding: 3px 8px; }
      .wrap:hover .hint { opacity: 1; transform: none; }

      .menu { position: absolute; right: 0; bottom: 44px; min-width: 168px; padding: 6px;
        background: #121a24; border: 1px solid #2b3d50; border-radius: 10px;
        box-shadow: 0 14px 36px rgba(0,0,0,.55); display: none; }
      .menu.on { display: block; }
      .menu button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 10px;
        border: 0; border-radius: 7px; background: transparent; color: #dfe7ef; font: inherit; cursor: pointer; text-align: left; }
      .menu button:hover { background: #1b2836; }
      .menu .on-mark { color: #4f9cf9; width: 12px; }

      .overlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
        background: rgba(4, 8, 12, .62); backdrop-filter: blur(3px); pointer-events: auto; }
      .overlay.on { display: flex; }
      .panel { display: flex; flex-direction: column; width: min(1280px, 94vw); height: 88vh;
        background: #0b1017; border: 1px solid #2b3d50; border-radius: 14px; overflow: hidden;
        box-shadow: 0 24px 70px rgba(0,0,0,.7); }
      .panel:fullscreen { width: 100vw; height: 100vh; border-radius: 0; border: 0; }
      .bar { display: flex; align-items: center; gap: 10px; padding: 9px 12px 9px 16px;
        border-bottom: 1px solid #22303f; background: #0f1720; color: #dfe7ef; }
      .bar .title { font-weight: 600; letter-spacing: .4px; }
      .bar .addr { color: #6d8296; font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
      .bar .grow { flex: 1; }
      .bar button { border: 1px solid #22303f; background: #17222f; color: #cdd9e5; border-radius: 7px;
        padding: 5px 10px; font: inherit; cursor: pointer; }
      .bar button:hover { border-color: #35506b; background: #1b2836; color: #fff; }
      .bar button.close { color: #ef8a88; border-color: #4a2626; }
      .bar button.close:hover { background: #2a1717; }
      iframe { flex: 1; width: 100%; border: 0; background: #0b1017; }
    </style>
    <div class="wrap" style="position: relative">
      <span class="hint">Alt+Shift+S 打开任务台</span>
      <div class="pillgroup">
        <button class="pill" type="button" title="本机服务任务台">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 5h16a1 1 0 0 1 1 1v3H3V6a1 1 0 0 1 1-1Zm-1 6h18v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7Zm3 2v2h4v-2H6Z"/>
          </svg>
          <span class="label">任务台</span>
          <span class="counts">
            <span class="tag run off" data-role="run">0</span>
            <span class="tag past off" data-role="past">0</span>
          </span>
        </button>
        <button class="caret" type="button" title="打开方式">▾</button>
      </div>
      <div class="menu" data-role="menu">
        <button data-mode="popup"><span class="on-mark">✓</span>弹窗打开（当前页）</button>
        <button data-mode="tab"><span class="on-mark">✓</span>新标签页打开</button>
      </div>
      <div class="overlay" data-role="overlay">
        <div class="panel" data-role="panel">
          <div class="bar">
            <span class="title">本机服务任务台</span>
            <span class="addr" data-role="addr"></span>
            <span class="grow"></span>
            <button type="button" data-act="refresh" title="重新载入任务台">刷新</button>
            <button type="button" data-act="fullscreen" title="放大到全屏">全屏</button>
            <button type="button" data-act="tab" title="在新页面打开">新页面</button>
            <button type="button" class="close" data-act="close" title="关闭（Esc）">关闭</button>
          </div>
          <iframe data-role="frame" title="本机服务任务台" allow="fullscreen; clipboard-write" allowfullscreen></iframe>
        </div>
      </div>
    </div>
  `

  const pill = root.querySelector('button.pill')
  const caret = root.querySelector('button.caret')
  const menu = root.querySelector('[data-role="menu"]')
  const overlay = root.querySelector('[data-role="overlay"]')
  const panel = root.querySelector('[data-role="panel"]')
  const frame = root.querySelector('[data-role="frame"]')
  const addr = root.querySelector('[data-role="addr"]')
  const tagRun = root.querySelector('[data-role="run"]')
  const tagPast = root.querySelector('[data-role="past"]')

  let opened = false

  const syncMenu = () => {
    const mode = readMode()
    for (const button of menu.querySelectorAll('button')) {
      button.querySelector('.on-mark').style.visibility = button.dataset.mode === mode ? 'visible' : 'hidden'
    }
  }

  const openTab = () => {
    window.open(location.origin + pageUrl(false), '_blank', 'noopener')
  }

  const openPopup = () => {
    if (!opened) {
      frame.src = pageUrl(true)
      addr.textContent = location.origin + base
      opened = true
    }
    overlay.classList.add('on')
    menu.classList.remove('on')
    try {
      document.documentElement.style.overflow = 'hidden'
    } catch {
      /* ignore */
    }
    frame.focus?.()
  }

  const closePopup = () => {
    overlay.classList.remove('on')
    try {
      document.documentElement.style.overflow = ''
    } catch {
      /* ignore */
    }
    if (document.fullscreenElement === panel) document.exitFullscreen?.().catch(() => {})
  }

  const openPreferred = () => {
    if (readMode() === 'tab') openTab()
    else openPopup()
  }

  pill.addEventListener('click', openPreferred)
  caret.addEventListener('click', (event) => {
    event.stopPropagation()
    syncMenu()
    menu.classList.toggle('on')
  })
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]')
    if (!button) return
    writeMode(button.dataset.mode)
    menu.classList.remove('on')
    openPreferred()
  })
  document.addEventListener('click', (event) => {
    if (!event.composedPath().includes(host)) menu.classList.remove('on')
  })

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePopup()
  })
  root.querySelector('[data-act="close"]').addEventListener('click', closePopup)
  root.querySelector('[data-act="tab"]').addEventListener('click', () => {
    openTab()
    closePopup()
  })
  root.querySelector('[data-act="refresh"]').addEventListener('click', () => {
    try {
      frame.contentWindow.location.reload()
    } catch {
      frame.src = pageUrl(true)
    }
  })
  root.querySelector('[data-act="fullscreen"]').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen()
      else await panel.requestFullscreen({ navigationUI: 'hide' })
    } catch {
      /* 浏览器拒绝全屏时静默退回弹窗 */
    }
  })
  panel.addEventListener('fullscreenchange', () => {})
  document.addEventListener('fullscreenchange', () => {
    const button = root.querySelector('[data-act="fullscreen"]')
    if (button) button.textContent = document.fullscreenElement === panel ? '还原' : '全屏'
  })

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.classList.contains('on')) {
      closePopup()
      return
    }
    if (event.altKey && event.shiftKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault()
      openPreferred()
    }
  })

  let timer = null
  const refresh = async () => {
    if (document.hidden) return
    try {
      const res = await fetch(api + '/state', { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (!data || !data.ok || !data.summary) return
      const running = Number(data.summary.running) || 0
      const past = Number(data.summary.stoppedBefore) || 0
      tagRun.textContent = String(running)
      tagPast.textContent = String(past)
      tagRun.classList.toggle('off', running === 0)
      tagPast.classList.toggle('off', past === 0)
      pill.title = `本机服务任务台 · 在跑 ${running} · 以前在跑现在停了 ${past} · 合计 ${Number(data.summary.total) || 0}`
    } catch {
      /* 控制台暂时不可达时静默 */
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh()
  })

  const mount = () => {
    if (!document.body) return
    if (!document.body.contains(host)) document.body.appendChild(host)
    syncMenu()
    refresh()
    if (!timer) timer = setInterval(refresh, 30000)
  }

  if (document.body) mount()
  else window.addEventListener('DOMContentLoaded', mount, { once: true })

  window.__dshServiceConsole = { open: openPopup, close: closePopup, openTab }
})()
