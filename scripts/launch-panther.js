#!/usr/bin/env node
/**
 * launch-panther.js — launch Panther Companion positioned on the right side
 * of the second (non-main) monitor.
 *
 * Usage:  PANTHER_DB=... node scripts/launch-panther.js
 */
import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.whenReady().then(() => {
  const displays = screen.getAllDisplays()
  console.log('Displays:')
  for (const d of displays) {
    console.log(`  ${d.id}: ${d.bounds.width}x${d.bounds.height} @ (${d.bounds.x},${d.bounds.y}) main=${d.primary} workArea=${d.workArea.width}x${d.workArea.height} @ (${d.workArea.x},${d.workArea.y})`)
  }

  const mainDisplay = screen.getPrimaryDisplay()
  const second = displays.find((d) => d.id !== mainDisplay.id) || mainDisplay

  // Right side of the second monitor's work area
  const wa = second.workArea
  const winWidth = 380
  const winHeight = 560
  const x = wa.x + wa.width - winWidth - 20   // 20px margin from right edge
  const y = wa.y + 60                          // 60px from top

  console.log(`\nPositioning Panther on second monitor: x=${x}, y=${y} (workArea: ${wa.x},${wa.y} ${wa.width}x${wa.height})`)

  const win = new BrowserWindow({
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

  win.loadFile(path.join(__dirname, '..', 'dist', 'surface', 'card.html'))

  win.webContents.on('did-finish-load', () => {
    console.log('Card loaded.')
  })

  win.on('closed', () => app.quit())
})

app.on('window-all-closed', () => app.quit())
