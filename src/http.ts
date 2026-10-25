import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { cardPath } from "./paths.js";
import { CompanionController } from "./controller.js";
import { InputError } from "./bundle.js";

async function body(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new InputError("Use application/json.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk); size += data.length;
    if (size > 1024 * 1024) throw new InputError("Request exceeds the 1 MiB limit.");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new InputError("Request must contain valid JSON."); }
}
export function createCompanionServer(controller: CompanionController) {
  return createServer((req, res) => {
    const finish = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const handle = async () => {
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { finish(403, { error: "Localhost access only." }); return; }
      const url = new URL(req.url ?? "/", `http://${host}`);
      const documentNavigation = req.method === "GET" && (url.pathname === "/" || url.pathname === "/card") && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}` && !documentNavigation) { finish(403, { error: "Open Companion locally to use this action." }); return; }
      if (req.headers["sec-fetch-site"] === "cross-site" && !documentNavigation) { finish(403, { error: "Cross-site access is not allowed." }); return; }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/card")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(readFileSync(cardPath(), "utf8")); return;
      }
      if (req.method === "GET" && url.pathname === "/api/status") { finish(200, controller.status()); return; }
      if (req.method === "GET" && url.pathname === "/api/export") {
        res.setHeader("Content-Disposition", 'attachment; filename="panther-companion.json"'); finish(200, await controller.action("export")); return;
      }
      if (req.method === "POST" && /^\/api\/[a-z-]+$/.test(url.pathname)) {
        const data = await body(req); const result = await controller.action(url.pathname.slice(5), data); finish(200, result); return;
      }
      finish(404, { error: "Not found." });
    };
    void handle().catch(error => finish(error instanceof InputError ? 400 : 500, { error: error instanceof InputError ? error.message : "Companion could not finish this action. Your saved evidence is retained." }));
  });
}
