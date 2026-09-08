'use strict'

const api = window.dshShell

const view = document.getElementById('view')
const overlay = document.getElementById('overlay')
const headline = document.getElementById('headline')
const subline = document.getElementById('subline')
const logline = document.getElementById('logline')
const pill = document.getElementById('statusPill')
const statusText = document.getElementById('statusText')
const cta = document.getElementById('cta')
const btnRetry = document.getElementById('btnRetry')
const btnRestart = document.getElementById('btnRestart')

const PHASE_LABELS = {
  idle: '未连接',
  probing: '检测中',
  starting: '启动中',
  online: '在线',
  offline: '离线',
  error: '异常',
}

const OWNERSHIP_LABELS = {
  none: '',
  desktop: '桌面托管',
  systemd: 'systemd',
  external: '外部进程',
}

let bootStartedAt = Date.now()
let awaitingBackend = false
let tickTimer = null
let tone = 'loading'

function setTone(next) {
  tone = next
  overlay.dataset.tone = next
}

function showOverlay() {
  overlay.hidden = false
}

function hideOverlay() {
  overlay.hidden = true
}

function setCta(visible, primaryLabel, restartLabel) {
  cta.hidden = !visible
  if (primaryLabel) btnRetry.textContent = primaryLabel
  if (restartLabel) btnRestart.textContent = restartLabel
}

function startTicking() {
  if (tickTimer !== null) return
  tickTimer = setInterval(() => {
    const seconds = ((Date.now() - bootStartedAt) / 1000).toFixed(1)
    subline.textContent = `首次启动需要加载全部插件，约 5 秒… 已用时 ${seconds}s`
  }, 100)
}

function stopTicking() {
  if (tickTimer === null) return
  clearInterval(tickTimer)
  tickTimer = null
}

function applyStatus(status) {
  const phase = status.phase || 'idle'
  pill.dataset.phase = phase

  const ownership = OWNERSHIP_LABELS[status.ownership] || ''
  statusText.textContent = ownership === '' ? PHASE_LABELS[phase] : `${PHASE_LABELS[phase]} · ${ownership}`

  if (phase === 'starting') {
    bootStartedAt = Date.now()
    awaitingBackend = true
    setTone('loading')
    showOverlay()
    headline.textContent = '正在启动后端'
    startTicking()
    setCta(false)
    return
  }

  if (phase === 'probing') {
    awaitingBackend = true
    setTone('loading')
    showOverlay()
    headline.textContent = '正在连接'
    subline.textContent = '正在检测后端…'
    setCta(false)
    return
  }

  if (phase === 'online') {
    stopTicking()
    // The overlay stays until the webview actually paints; "online" only means
    // the port answered, and the page still has to load.
    if (!awaitingBackend) hideOverlay()
    return
  }

  if (phase === 'error') {
    stopTicking()
    awaitingBackend = false
    setTone('error')
    showOverlay()
    headline.textContent = '后端启动失败'
    subline.textContent = status.detail || '请查看日志或重启后端。'
    setCta(true, '重试', '重启后端')
    return
  }

  if (phase === 'offline') {
    stopTicking()
    awaitingBackend = false
    setTone('error')
    showOverlay()
    headline.textContent = '后端未运行'
    subline.textContent = '点击下方按钮启动 DeepSeek Harness 后端。'
    setCta(true, '启动后端', '重启后端')
  }
}

function showAuthWall() {
  stopTicking()
  awaitingBackend = false
  setTone('auth')
  showOverlay()
  headline.textContent = '需要授权'
  subline.textContent =
    '该后端要求一次性令牌授权。重启后端可自动完成授权，凭据将保存 30 天，之后连接无需重复此步骤。'
  setCta(true, '重新连接', '重启后端并授权')
}

function loadBackend(url) {
  awaitingBackend = true
  setTone('loading')
  showOverlay()
  headline.textContent = '正在加载界面'
  subline.textContent = '正在载入 DeepSeek Harness…'
  setCta(false)
  view.src = url
}

api.onStatus(applyStatus)

api.onLog((line) => {
  logline.textContent = line
})

api.onLoad(({ url }) => {
  loadBackend(url)
})

function showFailure(message) {
  stopTicking()
  awaitingBackend = false
  setTone('error')
  showOverlay()
  headline.textContent = '无法连接后端'
  subline.textContent = message
  setCta(true, '重试', '重启后端')
}

api.onFailed(({ message }) => showFailure(message))

api.onAuthWall(showAuthWall)

view.addEventListener('load', () => {
  // Fires for every completed navigation, including about:blank and Chromium's
  // own error pages; only a real load clears the skeleton. Auth-wall and
  // network-failure detection live in the main process (webRequest), since the
  // frame is cross-origin and its DOM is not inspectable from here.
  if (!awaitingBackend) return
  awaitingBackend = false
  stopTicking()
  hideOverlay()
})

btnRetry.addEventListener('click', () => {
  stopTicking()
  setTone('loading')
  headline.textContent = '正在连接'
  subline.textContent = '正在检测后端…'
  setCta(false)
  awaitingBackend = true
  void api.connect()
})

btnRestart.addEventListener('click', () => {
  stopTicking()
  bootStartedAt = Date.now()
  setTone('loading')
  headline.textContent = '正在重启后端'
  subline.textContent = '正在停止并重新启动…'
  setCta(false)
  awaitingBackend = true
  void api.restartBackend()
})

document.getElementById('btnMin').addEventListener('click', () => void api.windowAction('minimize'))
document.getElementById('btnMax').addEventListener('click', () => void api.windowAction('maximize'))
document.getElementById('btnClose').addEventListener('click', () => void api.windowAction('close'))

// The main process begins probing the backend before this page exists, so any
// events it fired in that gap are already gone. Pull the current state instead
// of issuing a second connect, which would reload the webview needlessly.
void api.snapshot().then((snap) => {
  if (!snap) return
  if (snap.error) {
    showFailure(snap.error)
    return
  }
  applyStatus(snap.status)
  // A ready backend is delivered as a `load` event, not through this snapshot.
})
