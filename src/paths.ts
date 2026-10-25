import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function pantherHome(): string {
  return process.env.PANTHER_HOME ?? join(homedir(), ".panther-companion");
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
