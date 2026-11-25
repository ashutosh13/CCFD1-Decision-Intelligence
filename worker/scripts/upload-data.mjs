// Uploads the sanitized record-level dataset(s) in ../datasets.private/ to the Worker's KV (key data:<id>).
//   node scripts/upload-data.mjs [--local]      uses CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment
// The rows never go in the repo or on the static site; only the Worker reads them, as aggregates.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "..", "datasets.private");
if (!existsSync(dir)) { console.log("No datasets.private/ folder: nothing to upload."); process.exit(0); }
const files = readdirSync(dir).filter(f => f.endsWith(".json"));
if (!files.length) { console.log("datasets.private/ is empty: nothing to upload."); process.exit(0); }
for (const f of files) {
  const ds = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  if (!ds.record_level || !/^[a-z][a-z0-9_]*$/.test(ds.id)) { console.error(`${f}: not a record-level dataset, skipped`); continue; }
  const args = ["wrangler", "kv", "key", "put", "--binding", "RATE_LIMIT", `data:${ds.id}`, "--path", path.join(dir, f),
    process.argv.includes("--local") ? "--local" : "--remote"];
  const r = spawnSync("npx", args, { cwd: path.join(here, ".."), stdio: "inherit" });
  if (r.status) { console.error(`upload of ${ds.id} failed`); process.exit(r.status); }
  console.log(`uploaded ${ds.id}: ${ds.rows.length} rows`);
}
