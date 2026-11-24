// Runs the unchanged Cloudflare Worker (worker/src/index.js) as a plain Node server.
import http from "node:http";
import worker from "../worker/src/index.js";

const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "", ALLOWED_ORIGINS: "http://localhost:8000" };

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request("http://assistant" + req.url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body
  }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, "0.0.0.0");
