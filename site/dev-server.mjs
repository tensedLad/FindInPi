// Local stand-in for Cloudflare: serves public/ and answers POST /api/find
// from tables on disk.
//
//   node dev-server.mjs --tables ../tables [--port 8787]

import { createServer } from "node:http";
import { open, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { handleFind } from "./lib/lookup.js";

const { values: args } = parseArgs({
  options: { tables: { type: "string" }, port: { type: "string", default: "8787" } },
});
if (!args.tables) {
  console.error("usage: node dev-server.mjs --tables DIR [--port 8787]");
  process.exit(2);
}

const tablesDir = resolve(args.tables);
const meta = JSON.parse(await readFile(join(tablesDir, "meta.json"), "utf8"));
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

async function readRange(key, offset, length) {
  const file = await open(join(tablesDir, key));
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await file.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new Error(`short read from ${key}`);
    return buf;
  } finally {
    await file.close();
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/find" && req.method === "POST") {
      let q;
      try {
        ({ q } = JSON.parse(await readBody(req)));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Expected a JSON body." }));
      }
      const { status, body } = await handleFind(q, { width: meta.width, digits: meta.digits, readRange });
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    const path = normalize(join(publicDir, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(publicDir)) {
      res.writeHead(403);
      return res.end();
    }
    const data = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 500);
    res.end(err.code === "ENOENT" ? "not found" : String(err));
  }
}).listen(Number(args.port), () => {
  console.log(`Find in Pi dev server: http://localhost:${args.port}  (${meta.width}-digit tables, ${meta.digits} digits)`);
});
