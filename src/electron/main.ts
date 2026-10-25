import electron from 'electron'
import type { BrowserWindow } from 'electron'

const app = electron.app
const BrowserWindowCtor = electron.BrowserWindow
const ipcMain = electron.ipcMain
const globalShortcut = electron.globalShortcut
const screen = electron.screen
import { Panther } from '../ingest.js'
import { Store } from '../state/store.js'
import { LocalReasoner } from '../core/reasoner.js'
import { OllamaReasoner } from '../reasoning/ollama.js'
import { TerminalAdapter } from '../adapters/terminal.js'
import { BrowserAdapter } from '../adapters/browser.js'
import { AgentEventAdapter } from '../adapters/agent.js'
import { DesktopCaptureAdapter } from '../adapters/desktop.js'
import { loadConfig } from '../config.js'
import { pantherHome } from '../paths.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = pantherHome()
const DB_PATH = process.env.PANTHER_DB ?? `${HOME}/state.sqlite`

let mainWindow: BrowserWindow | null = null
let panther: Panther | null = null

function getPanther(): Panther {
  if (!panther) {
    const config = loadConfig(null)
    const store = Store.open(DB_PATH)
    const adapters = [
      new TerminalAdapter(),
      new BrowserAdapter(),
      new DesktopCaptureAdapter(),
      new AgentEventAdapter(),
    ]
    const reasoner = config.reasoning.provider === "ollama"
      ? new OllamaReasoner(config.reasoning.ollamaUrl, config.reasoning.model, { fallbackToLocal: config.reasoning.fallbackToLocal })
      : new LocalReasoner()
    panther = new Panther({
      store,
      adapters,
      reasoner,
      threshold: config.threshold,
      followMinutes: config.followMinutes,
      insightTtlMinutes: config.insightTtlMinutes,
    })
  }
  return panther
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindowCtor({
    width: 380,
    height,
    x: width - 400,
    y: 60,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, '..', '..', '..', 'surface', 'card.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('did-finish-load', () => {
    const p = getPanther()
    const now = new Date().toISOString()
    mainWindow?.webContents.send('panther:card-update', {
      goal: p.store.getGoal(now),
      live: p.store.getLive(),
      sources: p.sources(),
    })
  })
}

function showWindow() {
  if (!mainWindow) createWindow()
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function hideWindow() {
  if (mainWindow) mainWindow.hide()
}

function broadcastUpdate(p: Panther, result: any, extra?: any) {
  const now = new Date().toISOString()
  const status = {
    goal: p.store.getGoal(now),
    live: result.live ?? null,
    decision: result.decision,
    sources: p.sources(),
    ...extra,
  }
  if (mainWindow) {
    mainWindow.webContents.send('panther:card-update', status)
  }
}

async function handleExplain() {
  const p = getPanther()
  const result = await p.explain({ onRequest: true, now: new Date().toISOString() })
  broadcastUpdate(p, result)
  showWindow()
  return result
}

async function handleFollow() {
  const p = getPanther()
  const { session, result } = await p.follow({ now: new Date().toISOString() })
  broadcastUpdate(p, result, { session })
  showWindow()
  return { session, result }
}

async function handlePrepare() {
  const p = getPanther()
  const result = await p.prepare({ now: new Date().toISOString(), naturalPause: true })
  broadcastUpdate(p, result)
  showWindow()
  return result
}

app.whenReady().then(() => {
  createWindow()

  globalShortcut.register('CommandOrControl+Shift+E', handleExplain)
  globalShortcut.register('CommandOrControl+Shift+F', handleFollow)
  globalShortcut.register('CommandOrControl+Shift+P', handlePrepare)
  globalShortcut.register('Escape', hideWindow)
})

ipcMain.handle('panther:explain', handleExplain)
ipcMain.handle('panther:follow', handleFollow)
ipcMain.handle('panther:prepare', handlePrepare)
ipcMain.handle('panther:goal:set', async (_event, hypothesis: string | null) => {
  const p = getPanther()
  return p.setGoal(hypothesis, new Date().toISOString())
})
ipcMain.handle('panther:goal:show', async () => {
  const p = getPanther()
  return p.store.getGoal(new Date().toISOString())
})
ipcMain.handle(
  'panther:feedback',
  async (_event, kind: string, insightId: string | null, topic: string | null) => {
    const p = getPanther()
    p.recordFeedback(kind as any, insightId, topic, new Date().toISOString())
    return { ok: true }
  }
)
ipcMain.handle('panther:status', async () => {
  const p = getPanther()
  const now = new Date().toISOString()
  return {
    goal: p.store.getGoal(now),
    live: p.store.getLive(),
    sources: p.sources(),
    counts: p.store.countInsights(),
  }
})
ipcMain.handle('panther:sources', async () => {
  const p = getPanther()
  return p.sources()
})
ipcMain.on('panther:hide', hideWindow)

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
