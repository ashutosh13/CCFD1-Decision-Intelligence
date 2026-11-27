// CCFD1 dashboard assistant proxy (Cloudflare Worker).
//
// The browser sends only { messages }. This Worker adds the fixed model, max_tokens, system prompt
// and tool list, forwards to the Anthropic Messages API, and returns Anthropic's response JSON
// unchanged. Tools run in the browser (assistant/tools.js); the Worker never executes them.
//
// The API key comes only from the secret env.ANTHROPIC_API_KEY. It is never logged, never returned
// and never written anywhere. Every error the browser sees is a short fixed message.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { TOOL_SCHEMAS } from "./tool-schemas.js";
import Dataset from "../../shared/dataset.js";

export const MODEL = "claude-haiku-5-5";
export const MAX_TOKENS = 1536;
export const ALLOWED_ORIGINS = ["https://ashutosh13.github.io"];
/* Production only. run.py writes the real list into wrangler.toml [vars] ALLOWED_ORIGINS (comma separated) from config.json.
   localhost is never listed here: ./start.sh runs this code in docker/server.mjs, which passes its own origin via env. */
const originsFor = env => (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(",").map(x => x.trim()).filter(Boolean) : ALLOWED_ORIGINS);
export const MAX_BODY_BYTES = 20 * 1024;
export const MAX_TOOL_ROUND_TRIPS = 8;
export const RATE_LIMIT = { requests: 20, windowSeconds: 600 };
const MAX_MESSAGES = 60;
/* Private record-level data: held in KV under data:<id>, answered only as aggregates with small groups suppressed. */
export const MAX_QUERY_BYTES = 4 * 1024;
export const MIN_GROUP_SIZE = 3;
export const QUERY_LIMIT = { requests: 60, windowSeconds: 600 };
const TOOL_NAMES = new Set(TOOL_SCHEMAS.map(t => t.name));

/* ---------- responses ---------- */
const SAFE = {
  origin: "Origin not allowed.",
  method: "Use POST.",
  tooLarge: "Request too large.",
  badRequest: "Invalid request.",
  forbiddenField: "The request may contain only messages.",
  roundTrips: "Too many tool steps for one question. Please ask again.",
  rateLimited: "Too many requests. Please wait a few minutes and try again.",
  upstreamBusy: "The assistant is busy. Please try again shortly.",
  unavailable: "The assistant is unavailable right now.",
  noData: "That dataset is not available.",
  badQuery: "That query is not allowed."
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(status, body, origin) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(origin ? corsHeaders(origin) : { "Vary": "Origin" })
    }
  });
}
const fail = (status, key, origin) => json(status, { error: SAFE[key] }, origin);

/* ---------- rate limit: Workers KV, with an in-memory fallback ---------- */
const memoryCounts = new Map(); // per-isolate, best effort: used only when the KV binding is missing or fails

async function clientKey(request) {
  // Hash the IP so raw addresses are never stored in KV.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ccfd1-rl:" + ip));
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function checkRateLimit(request, env, now = Date.now()) {
  const window = Math.floor(now / 1000 / RATE_LIMIT.windowSeconds);
  const key = `rl:${await clientKey(request)}:${window}`;
  if (env && env.RATE_LIMIT) {
    try {
      const count = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10) || 0;
      if (count >= RATE_LIMIT.requests) return false;
      // KV keys must live at least 60 s; keep each window's counter a little past the window.
      await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT.windowSeconds + 60 });
      return true;
    } catch {
      // KV unavailable or over its write limit: fall through to the in-memory counter.
    }
  }
  for (const k of memoryCounts.keys()) if (!k.endsWith(":" + window)) memoryCounts.delete(k);
  const count = memoryCounts.get(key) || 0;
  if (count >= RATE_LIMIT.requests) return false;
  memoryCounts.set(key, count + 1);
  return true;
}
export function _resetMemoryRateLimit() { memoryCounts.clear(); queryCounts.clear(); }

/* /query only uses an in-memory counter (best effort): KV writes are scarce on the Free plan. */
const queryCounts = new Map();
export async function checkQueryLimit(request, now = Date.now()) {
  const window = Math.floor(now / 1000 / QUERY_LIMIT.windowSeconds);
  const key = `${await clientKey(request)}:${window}`;
  for (const k of queryCounts.keys()) if (!k.endsWith(":" + window)) queryCounts.delete(k);
  const count = queryCounts.get(key) || 0;
  if (count >= QUERY_LIMIT.requests) return false;
  queryCounts.set(key, count + 1);
  return true;
}

/* ---------- request validation ---------- */
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o, allowed) => Object.keys(o).every(k => allowed.includes(k));
const str = (v, max) => typeof v === "string" && v.length <= max;

function validTextBlock(b) {
  return onlyKeys(b, ["type", "text"]) && str(b.text, 8000) && b.text.length > 0;
}
function validUserBlock(b) {
  if (!isObj(b)) return false;
  if (b.type === "text") return validTextBlock(b);
  if (b.type === "tool_result") {
    if (!onlyKeys(b, ["type", "tool_use_id", "content", "is_error"])) return false;
    if (!str(b.tool_use_id, 200) || !b.tool_use_id) return false;
    if (b.is_error !== undefined && typeof b.is_error !== "boolean") return false;
    if (typeof b.content === "string") return b.content.length <= 16000;
    return Array.isArray(b.content) && b.content.every(c => isObj(c) && c.type === "text" && validTextBlock(c));
  }
  return false; // no images, documents, cache_control or other block types from the browser
}
function validAssistantBlock(b, toolNames = TOOL_NAMES) {
  if (!isObj(b)) return false;
  switch (b.type) {
    case "text": return onlyKeys(b, ["type", "text", "citations"]) && typeof b.text === "string" && (b.citations == null);
    case "tool_use": return onlyKeys(b, ["type", "id", "name", "input", "caller"]) && str(b.id, 200) && toolNames.has(b.name) && isObj(b.input);
    case "thinking": return onlyKeys(b, ["type", "thinking", "signature"]) && typeof b.thinking === "string" && typeof b.signature === "string";
    case "redacted_thinking": return onlyKeys(b, ["type", "data"]) && typeof b.data === "string";
    default: return false;
  }
}
const isQuestion = m => m.role === "user" &&
  (typeof m.content === "string" || m.content.some(b => b.type === "text"));

/* Returns { messages } or { error, status } */
export function validateBody(body, toolNames = TOOL_NAMES) {
  if (!isObj(body)) return { status: 400, error: "badRequest" };
  for (const k of ["system", "tools", "model", "max_tokens", "tool_choice", "thinking", "output_config", "stream", "metadata"]) {
    if (k in body) return { status: 400, error: "forbiddenField" };
  }
  if (!onlyKeys(body, ["messages"])) return { status: 400, error: "forbiddenField" };
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_MESSAGES) return { status: 400, error: "badRequest" };
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!isObj(m) || !onlyKeys(m, ["role", "content"])) return { status: 400, error: "badRequest" };
    const expected = i % 2 === 0 ? "user" : "assistant"; // starts with user, alternates; no "system" messages
    if (m.role !== expected) return { status: 400, error: "badRequest" };
    if (typeof m.content === "string") {
      if (!m.content || m.content.length > 8000) return { status: 400, error: "badRequest" };
    } else if (Array.isArray(m.content) && m.content.length > 0) {
      const ok = m.role === "user" ? m.content.every(validUserBlock) : m.content.every(b => validAssistantBlock(b, toolNames));
      if (!ok) return { status: 400, error: "badRequest" };
    } else return { status: 400, error: "badRequest" };
  }
  if (msgs[msgs.length - 1].role !== "user") return { status: 400, error: "badRequest" }; // no prefill
  // Tool round trips since the user's latest question (assistant tool_use turns after it).
  let lastQuestion = -1;
  msgs.forEach((m, i) => { if (isQuestion(m)) lastQuestion = i; });
  if (lastQuestion < 0) return { status: 400, error: "badRequest" };
  const roundTrips = msgs.slice(lastQuestion + 1)
    .filter(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_use")).length;
  if (roundTrips > MAX_TOOL_ROUND_TRIPS) return { status: 429, error: "roundTrips" };
  return { messages: msgs };
}

async function readBody(request, limit = MAX_BODY_BYTES) {
  const declared = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (declared > limit) return { tooLarge: true };
  if (!request.body) return { text: "" };
  // Read with a hard cap, whatever Content-Length said.
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { await reader.cancel(); } catch {} return { tooLarge: true }; }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(all) };
}

/* ---------- private dataset queries ----------
   POST /query { dataset, query } -> the same shape as Dataset.query, over the record-level rows in KV.
   Aggregate-only: no select, groupBy needs aggregate, and any group with fewer than MIN_GROUP_SIZE incidents is dropped. */
const dataCache = new Map(); // id -> { ds, at }
export function _resetDataCache() { dataCache.clear(); }
async function loadPrivateDataset(env, id) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9_]*$/.test(id) || !env || !env.RATE_LIMIT) return null;
  const hit = dataCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.ds;
  let ds = null;
  try { ds = JSON.parse(await env.RATE_LIMIT.get("data:" + id)); } catch { ds = null; }
  if (!ds || ds.id !== id || !ds.record_level || Dataset.validateDataset(ds).length) return null;
  dataCache.set(id, { ds, at: Date.now() });
  return ds;
}
export function privateQuery(ds, q) {
  if (!isObj(q) || q.select !== undefined || !isObj(q.aggregate) || !Object.keys(q.aggregate).length) return { error: "aggregate is required; rows are not available" };
  if (!ds.measures.some(m => m.name === "incidents")) return { error: "dataset has no incidents measure" };
  const res = Dataset.query(ds, q);
  if (res.error) return res;
  const groupBy = q.groupBy || [];
  const counts = Dataset.query(ds, { filter: q.filter, groupBy, aggregate: { incidents: "sum" } });
  if (counts.error) return counts;
  const key = r => groupBy.map(g => r[g]).join("\u0000");
  const big = new Set(counts.rows.filter(r => r.incidents >= MIN_GROUP_SIZE).map(key));
  const kept = res.rows.filter(r => big.has(key(r)));
  const suppressed = res.rows.length - kept.length;
  return { ...res, rows: kept, suppressed, note: [res.note, suppressed ? `${suppressed} group(s) with fewer than ${MIN_GROUP_SIZE} incidents were hidden.` : null].filter(Boolean).join(" ") };
}
async function handleQuery(request, env, allowed) {
  if (!(await checkQueryLimit(request))) return fail(429, "rateLimited", allowed);
  const raw = await readBody(request, MAX_QUERY_BYTES);
  if (raw.tooLarge) return fail(413, "tooLarge", allowed);
  let body; try { body = JSON.parse(raw.text); } catch { return fail(400, "badRequest", allowed); }
  if (!isObj(body) || !onlyKeys(body, ["dataset", "query"])) return fail(400, "badRequest", allowed);
  const ds = await loadPrivateDataset(env, body.dataset);
  if (!ds) return fail(404, "noData", allowed);
  const res = privateQuery(ds, body.query);
  if (res.error) return json(400, { error: String(res.error).slice(0, 300) }, allowed);
  return json(200, res, allowed);
}

/* ---------- forwarding ---------- */
export function buildUpstreamParams(messages, route) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: TOOL_SCHEMAS,
    output_config: { effort: "low" }, // thinking counts toward max_tokens; low effort keeps answers within 1536
    messages
  };
}

/* ---------- key status: lets the dashboard render the assistant only when a working key is present ----------
   GET /status asks Anthropic's free model-list endpoint whether the configured key is accepted, and returns
   only { available: true|false }. The key is never returned. Results are cached per isolate. */
const STATUS_TTL_MS = { ok: 5 * 60_000, bad: 60_000 };
let statusCache = null; // { available, at, key }
export function _resetStatusCache() { statusCache = null; }

export async function keyIsValid(env) {
  const key = env && typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : "";
  if (!key) return false;
  const now = Date.now();
  if (statusCache && statusCache.key === key &&
      now - statusCache.at < (statusCache.available ? STATUS_TTL_MS.ok : STATUS_TTL_MS.bad)) return statusCache.available;
  let available = false;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(5000)
    });
    available = res.ok;
  } catch { console.error("assistant proxy: key check could not reach the API"); }
  statusCache = { available, at: now, key };
  return available;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = origin && originsFor(env).includes(origin) ? origin : null;
    if (!allowed) return fail(403, "origin", null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    if (request.method === "GET" && new URL(request.url).pathname === "/status")
      return json(200, { available: await keyIsValid(env) }, allowed);
    if (request.method !== "POST") return fail(405, "method", allowed);
    if (new URL(request.url).pathname === "/query") return handleQuery(request, env, allowed);

    if (!(await checkRateLimit(request, env))) return fail(429, "rateLimited", allowed);

    const route = null;
    const raw = await readBody(request, route ? route.maxBody : MAX_BODY_BYTES);
    if (raw.tooLarge) return fail(413, "tooLarge", allowed);
    let body;
    try { body = JSON.parse(raw.text); } catch { return fail(400, "badRequest", allowed); }
    const v = route ? validateBody(body, route.toolNames) : validateBody(body);
    if (v.error) return fail(v.status, v.error, allowed);

    if (!env || typeof env.ANTHROPIC_API_KEY !== "string" || !env.ANTHROPIC_API_KEY) {
      console.error("assistant proxy: ANTHROPIC_API_KEY secret is not set");
      return fail(503, "unavailable", allowed);
    }
    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 30_000 });
      const message = await client.messages.create(buildUpstreamParams(v.messages, route));
      return json(200, message, allowed);
    } catch (err) {
      // Log only the status and error class - never the message text, request or headers.
      const status = err && typeof err.status === "number" ? err.status : 0;
      console.error("assistant proxy: upstream error", status, err && err.constructor ? err.constructor.name : "Error");
      if (status === 429 || status === 529) return fail(503, "upstreamBusy", allowed);
      if (status === 400 || status === 413) return fail(400, "badRequest", allowed);
      return fail(502, "unavailable", allowed);
    }
  }
};
