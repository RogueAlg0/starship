// Minimal static server for the viewer: node viewer/serve.ts [port]
// Serves the viewer/ directory on port 5176 by default.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 5176);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel =
    normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "") ||
    "index.html";
  const file = join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log(`Starship viewer on http://localhost:${port}`);
});
