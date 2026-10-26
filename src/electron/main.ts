import electron from "electron";
import type { BrowserWindow } from "electron";
import { appendFileSync } from "node:fs";
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
import { createCompanionServer } from "../http.js";
import { claimWriter, describeHolder } from "../state/writer.js";
import { companionBounds } from "./layout.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { app, BrowserWindow: Window, ipcMain, globalShortcut, screen } = electron;
let window: BrowserWindow | null = null;
let controller: CompanionController | undefined;
let teardown = () => {};
const cardUrl = pathToFileURL(cardPath()).href;
/** Where the panel points: its own bundle when it owns the store, the owner's server when it does not. */
let target = cardUrl;

/**
 * Diagnostics go to a file, synchronously.
 *
 * A double-clicked app has no terminal, and a piped stdout loses everything
 * buffered when the process is stopped — so a start-up failure would leave no
 * trace at all. One JSON line per event, appended next to the store.
 */
function note(event: string, detail: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail });
  try { appendFileSync(`${pantherHome()}/panel.log`, `${line}\n`); } catch { /* logging must never stop the panel */ }
  console.log(line);
}

process.on("uncaughtException", error => note("panel-uncaught", { message: error.message, stack: error.stack }));
process.on("unhandledRejection", reason => note("panel-rejection", { reason: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined }));

function show() {
  if (window) { window.show(); window.focus(); return; }
  // A second launch is a request to reveal the panel, not to start a second one.
  createWindow();
}

/**
 * Quit for real.
 *
 * `app.quit()` is a request, and a request that is refused (a renderer that will
 * not close, a window mid-load) leaves the process alive holding the writer
 * lease and the single-instance lock. Then the next launch finds no ready state
 * and shows nothing at all. So: clean up once, ask politely, and exit anyway.
 */
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  note("panel-shutdown", { reason });
  const cleanUp = teardown;
  teardown = () => {};
  try { cleanUp(); } catch (error) { note("panel-shutdown-failed", { message: error instanceof Error ? error.message : String(error) }); }
  app.quit();
  setTimeout(() => { note("panel-shutdown-forced", { reason }); app.exit(0); }, 1500).unref();
}

function createWindow() {
  try {
    const primary = screen.getPrimaryDisplay();
    const displays = screen.getAllDisplays();
    const bounds = companionBounds(displays.map(display => ({ id: display.id, workArea: display.workArea })), primary.id);
    note("companion-window", { bounds, target, displays: displays.map(display => ({ id: display.id, workArea: display.workArea, primary: display.id === primary.id })) });
    const local = target === cardUrl;
    window = new Window({
      ...bounds, title: "Panther Companion", minWidth: 420, minHeight: 550, show: true, alwaysOnTop: false, resizable: true,
      backgroundColor: "#11171c",
      // The preload bridge only exists when this process owns the store. A client
      // window talks to the owner's server over HTTP, so the surface's fetch path
      // is used and no IPC handler can be missing underneath it.
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, ...(local ? { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs") } : {}) },
    });
    window.webContents.on("did-finish-load", () => note("companion-loaded", { target }));
    window.webContents.on("did-fail-load", (_event, code, description) => note("companion-load-failed", { code, description, target }));
    window.webContents.on("render-process-gone", (_event, details) => note("companion-renderer-gone", { reason: details.reason, exitCode: details.exitCode }));
    void window.loadURL(target);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== target) event.preventDefault(); });
    window.on("closed", () => { window = null; });
  } catch (error) {
    note("companion-window-failed", { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  }
}

note("panel-starting", { version: app.getVersion(), electron: process.versions.electron, cardUrl });

if (!app.requestSingleInstanceLock()) {
  note("panel-already-running", { reason: "another Panther Companion instance holds the single-instance lock; it has been asked to show itself" });
  app.exit(0);
} else {
  app.setName("Panther Companion");
  app.on("second-instance", show);
  app.whenReady().then(async () => {
    note("panel-ready");
    // Registered after ready on purpose: handlers installed before Electron has
    // finished starting do not survive, and the process then ignores SIGTERM and
    // lingers as a writer nobody can see.
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
    const dbPath = process.env.PANTHER_DB ?? `${pantherHome()}/state.sqlite`;
    const port = Number(process.env.PANTHER_PORT || 8765);
    // One process writes the store. If this panel gets it, it also serves the
    // browser surface from this same process — one controller, so the panel and
    // the browser cannot disagree about the goal, the card or the follow session.
    const claim = claimWriter(dbPath, "Panther Companion panel");
    note("companion-claim", { owned: claim.owned, holder: claim.holder ? describeHolder(claim.holder) : null, dbPath });

    if (!claim.owned) {
      // Another surface, normally `panther serve`, is already the writer. Open as
      // a client of it rather than opening the store a second time.
      target = `http://127.0.0.1:${port}/`;
      note("companion-attached", { holder: claim.holder ? describeHolder(claim.holder) : null, target });
      // Say plainly whether the owner is actually answering, instead of leaving a
      // blank window that looks like a hang.
      try {
        const probe = await fetch(`${target}api/status`, { signal: AbortSignal.timeout(2000) });
        note("companion-owner-reachable", { status: probe.status, target });
      } catch (error) {
        note("companion-owner-unreachable", { target, message: error instanceof Error ? error.message : String(error) });
      }
      createWindow();
    } else {
      try {
        const config = loadConfig(null);
        const store = Store.open(dbPath);
        const reasoner = config.reasoning.provider === "ollama" ? new OllamaReasoner(config.reasoning.ollamaUrl, config.reasoning.model, { fallbackToLocal: config.reasoning.fallbackToLocal }) : new LocalReasoner();
        controller = new CompanionController(new Panther({ store, adapters: [new TerminalAdapter(), new BrowserAdapter(), new AgentEventAdapter()], reasoner, threshold: config.threshold, followMinutes: config.followMinutes, insightTtlMinutes: config.insightTtlMinutes }));
        controller.start();
        const server = createCompanionServer(controller);
        server.on("error", error => note("companion-server-error", { message: error.message }));
        server.listen(port, "127.0.0.1", () => note("companion-serving", { url: `http://127.0.0.1:${port}` }));
        ipcMain.handle("panther:action", async (event, action: string, data: unknown) => {
          if (event.senderFrame?.url !== cardUrl || event.sender !== window?.webContents) throw new Error("Unknown Companion surface.");
          try { return await controller!.action(action, data); }
          catch (error) { throw new Error(error instanceof InputError ? error.message : "Companion could not finish this action. Saved evidence is retained."); }
        });
        teardown = () => { claim.release(); controller?.stop(); store.close(); server.close(); };
        createWindow();
      } catch (error) {
        note("companion-owner-failed", { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
        claim.release();
        throw error;
      }
    }

    globalShortcut.register("CommandOrControl+Shift+E", () => { show(); });
    app.on("activate", show);
    note("panel-ready-finished", { target });
  }).catch(error => note("panel-startup-failed", { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
  app.on("will-quit", () => { globalShortcut.unregisterAll(); teardown(); teardown = () => {}; });
  // Closing the panel is how the operator hands the store back to `serve`, so it
  // must actually end the process rather than hide it in the Dock.
  app.on("window-all-closed", () => shutdown("window closed"));
}
