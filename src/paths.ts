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
