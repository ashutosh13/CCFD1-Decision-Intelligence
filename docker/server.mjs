// One process for the image: serves site/ and runs the unchanged Worker (worker/src/index.js) under /ask.
// PUBLIC_ORIGIN is the address the browser uses (http://localhost:<port>); it is the only origin the Worker allows.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import worker from "../worker/src/index.js";

const PORT = 8000;
const SITE = path.resolve("site");
const PRIVATE = process.env.PRIVATE_DIR || "/private"; // mounted datasets.private/ (record-level rows, never in the image)
const ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:8000";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" };

// The Worker reads private rows from a KV binding at key data:<id>. Every other key throws, which makes
// its rate limiter fall back to its in-memory counter.
const RATE_LIMIT = {
  async get(key) {
    const m = /^data:([a-z][a-z0-9_]*)$/.exec(key);
    if (!m) throw new Error("not a data key");
    return readFile(path.join(PRIVATE, m[1] + ".json"), "utf8").catch(() => null);
  }
};
const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "", ALLOWED_ORIGINS: ORIGIN, RATE_LIMIT };

async function ask(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request("http://worker" + req.url.slice("/ask".length), {
    method: req.method,
    headers: { ...req.headers, origin: ORIGIN }, // same-origin GETs carry no Origin header
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks)
  }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function serve(req, res) {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === "/config.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ township: "CCFD1", assistant_url: "/ask" }));
  }
  const file = path.join(SITE, url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname);
  if (!file.startsWith(SITE + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("Not found"); }
}

http.createServer((req, res) => (req.url.startsWith("/ask") ? ask : serve)(req, res).catch(() => { res.writeHead(500); res.end(); }))
  .listen(PORT, "0.0.0.0", () => console.log(`CCFD1 dashboard at ${ORIGIN}`));
