# CCFD1 assistant proxy (Cloudflare Worker)

This Worker connects the dashboard's "Ask the data" panel to the Anthropic Messages API without putting the API key in the browser.

- The browser sends only `{ "messages": [...] }`: the user's text, the assistant turns it received, and `tool_result` blocks.
- The Worker adds the fixed settings, forwards the request, and returns Anthropic's response JSON unchanged. The fixed settings are the model (`claude-haiku-5-5`), `max_tokens: 1024`, the system prompt, and the tool list.
- Tools run in the browser (`assistant/tools.js`). The Worker never executes them.
- The API key is read only from the Cloudflare secret `ANTHROPIC_API_KEY`. It is never stored in this repo, logged or returned.

## What the Worker rejects

| Check | Response |
|---|---|
| Origin other than `https://ashutosh13.github.io` or `http://localhost:8000` | 403 |
| A body containing `system`, `tools`, `model`, `max_tokens` (or any field other than `messages`) | 400 |
| A `system` message, an image or document block, an unknown tool name, or a conversation that ends on an assistant turn | 400 |
| A body over 20 KB | 413 |
| More than 8 tool round trips since the user's latest question | 429 |
| More than 20 requests per IP in 10 minutes | 429 |
| Any upstream or internal error | A short fixed message, with no details |

## Deploy (Windows, PowerShell)

You need Node.js 20 or later (`node -v`) and a free Cloudflare account. Run every command from the `worker` folder:

```powershell
cd C:\Users\amsus\OneDrive\Desktop\GITHUB\CCFD1-Decision-Intelligence\worker
```

**1. Install the dependencies.**

```powershell
npm install
```

This installs the Anthropic SDK and wrangler. `package.json` already approves the two install scripts wrangler needs (`esbuild`, `workerd`).

**2. Log in to Cloudflare.** A browser window opens to authorize wrangler.

```powershell
npx wrangler login
npx wrangler whoami   # confirms which account you are logged in to
```

**3. Create the KV namespace for the rate limit.**

```powershell
npx wrangler kv namespace create RATE_LIMIT
```

The command prints a block that contains `"id": "..."`. Open `wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with that id. The id is not a secret, so it is fine to commit.

**4. Store the API key as a secret.**

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Paste the key when wrangler prompts for it. It goes straight to Cloudflare and is not written to any file. If wrangler says the Worker doesn't exist yet and offers to create it, answer yes. Never put the key in `wrangler.toml`, in any file in this repo, or in a command line.

**5. Deploy.**

```powershell
npm run deploy
```

This first checks that `src/tool-schemas.js` matches `assistant/tools.js` and runs the tests. Only if both pass does it run `npx wrangler deploy`. Running `npx wrangler deploy` directly skips those checks.

**6. Find the deployed URL.** The URL has the form `https://ccfd1-assistant.<your-subdomain>.workers.dev`. To find it:

- look at the end of the `wrangler deploy` output, or
- in the Cloudflare dashboard, open **Workers & Pages**, then **ccfd1-assistant**, then the **Settings > Domains & Routes** section.

The dashboard's assistant code will POST to this URL.

**7. Smoke test** (spends a few tokens):

```powershell
$url = "https://ccfd1-assistant.<your-subdomain>.workers.dev"
$body = '{"messages":[{"role":"user","content":"What is the 2027 structural gap?"}]}'
Invoke-RestMethod -Method Post -Uri $url -Body $body -ContentType "application/json" -Headers @{ Origin = "https://ashutosh13.github.io" }
```

The reply should be a message with `stop_reason: "tool_use"`, asking to call a tool such as `search_facts` or `get_fact`. The browser runs that tool and sends the result back.

## Updating

- **After changing `TOOL_SCHEMAS` in `assistant/tools.js`:** run `npm run sync-tools`, then `npm run deploy`. `npm run deploy` refuses to deploy a stale copy.
- **To rotate the key:** run `npx wrangler secret put ANTHROPIC_API_KEY` again. This deploys a new version right away.
- **To remove the key:** run `npx wrangler secret delete ANTHROPIC_API_KEY`. The Worker then answers "The assistant is unavailable right now."

## Local testing

```powershell
npm test   # checks the tool-schema copy, then runs test/*.test.mjs with fetch mocked; no key, no network
```

To run the Worker locally against the real API:

1. Create `worker\.dev.vars` containing one line: `ANTHROPIC_API_KEY=<your key>`. The file is git-ignored, and so are `.env*` files. Never commit it.
2. Run `npm run dev`. The Worker listens on `http://localhost:8787`.
3. In the repo root, serve the dashboard with `python -m http.server 8000`, so it runs on the allowed origin `http://localhost:8000`.
4. Delete `.dev.vars` when you are done.

## How the browser should call it

1. POST `{ "messages": [...] }` with `Content-Type: application/json`.
2. Keep the conversation **append-only**. Send every assistant turn back exactly as received, including any `thinking` blocks. Their text may be empty; keep them anyway. Editing or removing earlier turns breaks the request.
3. If `stop_reason` is `"tool_use"`:
   1. Run each `tool_use` block with `CCFD1Tools.runTool(tools, block.name, block.input)`.
   2. Append one user message holding all the `tool_result` blocks, each with its `tool_use_id`, and with the content as `JSON.stringify(result)`.
   3. POST again.
4. The 8-round-trip cap counts from the user's latest question.
5. Handle the other stop reasons:
   - `"end_turn"`: show the text blocks.
   - `"max_tokens"`: the answer was cut off at 1024 tokens. Show what arrived and suggest a narrower question.
   - `"refusal"`: show a short "can't help with that" message. Claude Haiku 5.5 has no server-side fallback model.

## Limits and notes

- **Rate limit.** The limit is approximate: KV is eventually consistent and allows 1 write per second per key. If the KV binding is missing or fails, the Worker falls back to a per-instance in-memory counter, which is best effort only. Raw IPs are never stored; KV keys use a hash.
- **KV Free plan.** The Free plan allows 1,000 KV writes per day, which is roughly 1,000 assistant requests per day across all users. Upgrade the plan or drop the KV binding if that is too low.
- **API version.** `@anthropic-ai/sdk` 1.x sends API version `2026-10-21`. The Worker sets `output_config.effort: "low"` because Claude Haiku 5.5 thinks by default, and thinking counts toward the 1024-token cap. The Worker does not send `temperature`, which this API version rejects.
