import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function pantherHome(): string {
  return process.env.PANTHER_HOME ?? join(homedir(), ".panther-companion");
}

/**
 * Where the terminal capture producer appends JSONL, and where Companion reads
 * it. Both sides share this one default so a wrapped command is visible without
 * any extra configuration.
 */
export function terminalLogPath(): string {
  return process.env.PANTHER_TERMINAL_LOG?.trim() || join(pantherHome(), "terminal.jsonl");
}

export function promptPath(): string {
  return join(projectRoot(), "prompts", "reasoner.md");
}

export function packagedConfigPath(): string {
  return join(projectRoot(), "config", "gating.json");
}

export function cardPath(): string {
  return join(projectRoot(), "surface", "card.html");
}

/**
 * The capture producer the surface tells the user to run. A packaged app has no
 * checkout to point at, so it carries its own copy in Contents/Resources — the
 * instruction has to name a path that exists on the machine that reads it.
 */
export function captureScriptPath(): string {
  const override = process.env.PANTHER_CAPTURE_SCRIPT?.trim();
  if (override) return override;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const bundled = join(resources, "capture-command.sh");
    if (existsSync(bundled)) return bundled;
  }
  return join(projectRoot(), "scripts", "capture-command.sh");
}
