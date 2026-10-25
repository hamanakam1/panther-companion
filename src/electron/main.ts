import electron from "electron";
import type { BrowserWindow } from "electron";
import { Panther } from "../ingest.js";
import { Store } from "../state/store.js";
import { LocalReasoner } from "../core/reasoner.js";
import { OllamaReasoner } from "../reasoning/ollama.js";
import { TerminalAdapter } from "../adapters/terminal.js";
import { BrowserAdapter } from "../adapters/browser.js";
import { AgentEventAdapter } from "../adapters/agent.js";
import { loadConfig } from "../config.js";
import { pantherHome, cardPath } from "../paths.js";
import { CompanionController } from "../controller.js";
import { InputError } from "../bundle.js";
import { companionBounds } from "./layout.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { app, BrowserWindow: Window, ipcMain, globalShortcut, screen } = electron;
let window: BrowserWindow | null = null;
let controller: CompanionController;
const cardUrl = pathToFileURL(cardPath()).href;
function show() { if (!window) createWindow(); window?.show(); window?.focus(); }
function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  const bounds = companionBounds(displays.map(display => ({ id: display.id, workArea: display.workArea })), primary.id);
  console.log(JSON.stringify({ event: "companion-window", bounds, displays: displays.map(display => ({ id: display.id, workArea: display.workArea, primary: display.id === primary.id })) }));
  window = new Window({ ...bounds, title: "Panther Companion", minWidth: 420, minHeight: 550, show: true, alwaysOnTop: false, resizable: true,
    backgroundColor: "#11171c", webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  void window.loadFile(cardPath());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== cardUrl) event.preventDefault(); });
  window.on("closed", () => { window = null; });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName("Panther Companion");
  app.on("second-instance", show);
  app.whenReady().then(() => {
    const config = loadConfig(null);
    const store = Store.open(process.env.PANTHER_DB ?? `${pantherHome()}/state.sqlite`);
    const reasoner = config.reasoning.provider === "ollama" ? new OllamaReasoner(config.reasoning.ollamaUrl, config.reasoning.model, { fallbackToLocal: config.reasoning.fallbackToLocal }) : new LocalReasoner();
    controller = new CompanionController(new Panther({ store, adapters: [new TerminalAdapter(), new BrowserAdapter(), new AgentEventAdapter()], reasoner, threshold: config.threshold, followMinutes: config.followMinutes, insightTtlMinutes: config.insightTtlMinutes }));
    controller.start();
    ipcMain.handle("panther:action", async (event, action: string, data: unknown) => {
      if (event.senderFrame?.url !== cardUrl || event.sender !== window?.webContents) throw new Error("Unknown Companion surface.");
      try { return await controller.action(action, data); }
      catch (error) { throw new Error(error instanceof InputError ? error.message : "Companion could not finish this action. Saved evidence is retained."); }
    });
    createWindow();
    globalShortcut.register("CommandOrControl+Shift+E", () => { show(); });
    app.on("activate", show);
  });
  app.on("will-quit", () => { globalShortcut.unregisterAll(); controller?.stop(); controller?.panther.store.close(); });
  app.on("window-all-closed", () => app.quit());
}
