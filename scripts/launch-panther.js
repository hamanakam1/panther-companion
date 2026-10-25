#!/usr/bin/env node
/**
 * launch-panther.js — launch Panther Companion positioned on the right side
 * of the second (non-main) monitor, with full IPC + global hotkey support.
 *
 * Usage:  PANTHER_DB=... PANTHER_TERMINAL_LOG=... ./node_modules/.bin/electron scripts/launch-panther.js
 */
import { app, BrowserWindow, screen, ipcMain, globalShortcut } from 'electron'
import { Panther } from '../dist/src/ingest.js'
import { Store } from '../dist/src/state/store.js'
import { LocalReasoner } from '../dist/src/core/reasoner.js'
import { OllamaReasoner } from '../dist/src/reasoning/ollama.js'
import { TerminalAdapter } from '../dist/src/adapters/terminal.js'
import { BrowserAdapter } from '../dist/src/adapters/browser.js'
import { AgentEventAdapter } from '../dist/src/adapters/agent.js'
import { DesktopCaptureAdapter } from '../dist/src/adapters/desktop.js'
import { loadConfig } from '../dist/src/config.js'
import { pantherHome } from '../dist/src/paths.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = pantherHome()
const DB_PATH = process.env.PANTHER_DB ?? `${HOME}/state.sqlite`

let mainWindow = null
let panther = null

function getPanther() {
  if (!panther) {
    const config = loadConfig(null)
    const store = Store.open(DB_PATH)
    const adapters = [
      new TerminalAdapter(),
      new BrowserAdapter(),
      new DesktopCaptureAdapter(),
      new AgentEventAdapter(),
    ]
    const reasoner = config.reasoning.provider === 'ollama'
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
  const displays = screen.getAllDisplays()
  for (const d of displays) {
    console.log(`  display ${d.id}: ${d.bounds.width}x${d.bounds.height} @ (${d.bounds.x},${d.bounds.y}) main=${d.primary}`)
  }
  const mainDisplay = screen.getPrimaryDisplay()
  const second = displays.find((d) => d.id !== mainDisplay.id) || mainDisplay
  const wa = second.workArea
  const winWidth = 380
  const winHeight = 560
  const x = wa.x + wa.width - winWidth - 20
  const y = wa.y + 60

  console.log(`Positioning Panther on second monitor: x=${x}, y=${y}`)

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'src', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'surface', 'card.html'))

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
    console.log('Card loaded.')
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

function broadcastUpdate(p, result, extra) {
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

  ipcMain.handle('panther:explain', handleExplain)
  ipcMain.handle('panther:follow', handleFollow)
  ipcMain.handle('panther:prepare', handlePrepare)
  ipcMain.handle('panther:goal:set', async (_event, hypothesis) => {
    const p = getPanther()
    return p.setGoal(hypothesis, new Date().toISOString())
  })
  ipcMain.handle('panther:goal:show', async () => {
    const p = getPanther()
    return p.store.getGoal(new Date().toISOString())
  })
  ipcMain.handle('panther:feedback', async (_event, kind, insightId, topic) => {
    const p = getPanther()
    p.recordFeedback(kind, insightId, topic, new Date().toISOString())
    return { ok: true }
  })
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
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
