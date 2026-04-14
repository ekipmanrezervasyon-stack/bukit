import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = Number(process.env.FRONTEND_PORT || 3000);
const HOST = process.env.FRONTEND_HOST || "127.0.0.1";
const ROOT = process.cwd();

const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

const htmlResponse = async (res, fileName) => {
  const filePath = join(ROOT, fileName);
  const html = await readFile(filePath, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = u.pathname;

    if (path === "/" || path === "/index" || path === "/index.html") {
      await htmlResponse(res, "index.txt");
      return;
    }

    if (path === "/admin" || path === "/admin.html") {
      await htmlResponse(res, "admin.txt");
      return;
    }

    // Optional static passthrough for local assets if needed later.
    const localPath = join(ROOT, path.replace(/^\/+/, ""));
    const data = await readFile(localPath);
    const contentType = MIME[extname(localPath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`bookdeck-frontend running at http://${HOST}:${PORT}`);
  console.log(`User:  http://${HOST}:${PORT}/?api_base=http://127.0.0.1:4000`);
  console.log(`Admin: http://${HOST}:${PORT}/admin?api_base=http://127.0.0.1:4000`);
});
