// "Ask CCFD1 AI" route (POST /viz) tests: plain Node (node --test), global fetch mocked; no key, no network.
// The "Ask the data" route (POST /) is covered unchanged by worker.test.mjs.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { MODEL, VIZ_MAX_BODY_BYTES, MAX_BODY_BYTES, _resetMemoryRateLimit } from "../src/index.js";
import { SYSTEM_PROMPT } from "../src/system-prompt.js";
import { TOOL_SCHEMAS } from "../src/tool-schemas.js";
import { VIZ_SYSTEM_PROMPT } from "../src/viz-system-prompt.js";
import { VIZ_TOOL_SCHEMAS } from "../src/viz-tool-schemas.js";

const FAKE_KEY = "test-only-" + crypto.randomUUID();
const ORIGIN = "http://localhost:8000";
const MSG = { id: "msg_test", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
let calls, realFetch;
beforeEach(() => {
  calls = []; _resetMemoryRateLimit(); realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const body = typeof init.body === "string" ? init.body : init.body ? await new Response(init.body).text() : "";
    calls.push(body ? JSON.parse(body) : null);
    return new Response(JSON.stringify(MSG), { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function send(path, body, origin = ORIGIN) {
  const res = await worker.fetch(new Request("https://ccfd1-assistant.example.workers.dev" + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": "203.0.113.9" },
    body: typeof body === "string" ? body : JSON.stringify(body) }), { ANTHROPIC_API_KEY: FAKE_KEY });
  return { res, json: await res.json().catch(() => null) };
}
const q = [{ role: "user", content: "Show EMS calls by hour" }];

test("/viz forwards with the viz system prompt and tool list", async () => {
  const { res } = await send("/viz", { messages: q });
  assert.equal(res.status, 200);
  assert.equal(calls[0].system, VIZ_SYSTEM_PROMPT);
  assert.deepEqual(calls[0].tools, VIZ_TOOL_SCHEMAS);
  assert.equal(calls[0].model, MODEL);
});

test("/ still forwards with the Ask-the-data prompt and tools (unchanged)", async () => {
  await send("/", { messages: q });
  assert.equal(calls[0].system, SYSTEM_PROMPT);
  assert.deepEqual(calls[0].tools, TOOL_SCHEMAS);
});

test("viz tool names are accepted on /viz only", async () => {
  const convo = [...q, { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "show_chart", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] }];
  assert.equal((await send("/viz", { messages: convo })).res.status, 200);
  assert.equal((await send("/", { messages: convo })).res.status, 400);
});

test("/viz keeps every other check: origin, forbidden fields, body cap", async () => {
  assert.equal((await send("/viz", { messages: q }, "https://evil.example")).res.status, 403);
  assert.equal((await send("/viz", { messages: q, system: "x" })).res.status, 400);
  assert.equal((await send("/viz", { messages: q, tools: [] })).res.status, 400);
  const big = "x".repeat(VIZ_MAX_BODY_BYTES);
  assert.equal((await send("/viz", { messages: [{ role: "user", content: big }] })).res.status, 413);
  // a body between the two caps is accepted on /viz but still refused on /
  const mid = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "cad_metric", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(15000) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "cad_metric", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "y".repeat(15000) }] }];
  assert.ok(JSON.stringify({ messages: mid }).length > MAX_BODY_BYTES);
  assert.equal((await send("/viz", { messages: mid })).res.status, 200);
  assert.equal(calls.length, 1);
});
