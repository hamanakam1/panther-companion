import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { cardPath, packagedConfigPath, promptPath, projectRoot } from "../src/paths.js";

const root = resolve(new URL("../../", import.meta.url).pathname);
const builder = readFileSync(resolve(root, "electron-builder.yml"), "utf8");

/** Read the list entries under a top-level `key:` in electron-builder.yml. */
function section(key: string): string[] {
  const lines = builder.split(/\r?\n/);
  const start = lines.findIndex(line => new RegExp(`^${key}:\\s*$`).test(line));
  assert.ok(start >= 0, `electron-builder.yml still has a ${key}: section`);
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) break;
    entries.push(line.trim());
  }
  return entries;
}
const patterns = section("files").map(entry => entry.replace(/^-\s*/, "").replace(/^"|"$/g, ""));

/** True when `relative` (a repo-relative path) is inside what the builder ships. */
function shipped(relativePath: string): boolean {
  return patterns.some(pattern => {
    if (pattern.startsWith("!")) return false;
    const trimmed = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed.endsWith("/**/*")) return relativePath.startsWith(trimmed.slice(0, -5) + "/");
    if (trimmed.endsWith("/**")) return relativePath.startsWith(trimmed.slice(0, -3) + "/");
    return trimmed === relativePath;
  });
}

describe("packaged app", () => {
  it("ships every asset the running app resolves from its own root", () => {
    const assets = [cardPath(), promptPath(), packagedConfigPath(), resolve(root, "package.json")]
      .map(path => relative(projectRoot(), path).split("\\").join("/"));
    for (const asset of assets) {
      assert.ok(statSync(resolve(root, asset)).isFile(), `${asset} exists in the checkout`);
      assert.ok(shipped(asset), `${asset} is read at runtime but electron-builder.yml files: does not ship it`);
    }
  });
  it("ships the capture producer the surface tells the user to run, and keeps it executable", () => {
    const resources = section("extraResources").join(" ");
    assert.match(resources, /from:\s*scripts\/capture-command\.sh/);
    assert.match(resources, /to:\s*capture-command\.sh/);
    const mode = statSync(resolve(root, "scripts/capture-command.sh")).mode;
    assert.ok(mode & 0o100, "scripts/capture-command.sh must be executable or the instruction cannot be followed");
  });
  it("stays an unsigned local build and keeps its output out of git", () => {
    assert.match(builder, /identity:\s*null/, "a null identity keeps the local build off any certificate");
    assert.match(builder, /output:\s*release/);
    assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^release\/$/m, "the build output must not be committed");
    assert.match(builder, /productName:\s*Panther Companion/);
  });
});
