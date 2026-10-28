// جالب Peach → .peach-sync/inbound.json
// حتمي بالكامل: نداء MCP مباشر عبر HTTP، بلا نموذج لغوي وبلا استهلاك حدود.
// يحتاج: PEACH_API_KEY، و WAHET_INTAKE_SECRET أو WAHET_SYNC_TOKEN، و WAHET_BASE.
//   node scripts/fetch-peach.js          ⇒ يقرأ المؤشر من اللوحة ويكتب الوارد
//   node scripts/fetch-peach.js --from 2026-10-01T00:00:00Z  ⇒ يتجاوز المؤشر
const fs = require("fs");
const path = require("path");

const BASE = process.env.WAHET_BASE || "https://wahet-proxy-staging.vercel.app/api/app";
const SECRET = process.env.WAHET_INTAKE_SECRET || "";
const SYNC_TOKEN = process.env.WAHET_SYNC_TOKEN || "";
const PEACH_KEY = process.env.PEACH_API_KEY || "";
const PEACH_MCP = process.env.PEACH_MCP_URL || "https://app.trypeach.ai/api/mcp";
const OUT_FILE = path.join(__dirname, "..", ".peach-sync", "inbound.json");
const PER_PAGE = Number(process.env.PEACH_PER_PAGE || 100);

const appHeaders = () => (SECRET
  ? { "Content-Type": "application/json", "x-intake-secret": SECRET }
  : { "Content-Type": "application/json", "x-sync-token": SYNC_TOKEN });

const fail = (o) => { console.log(JSON.stringify(o)); process.exit(1); };

async function cursorFrom() {
  const i = process.argv.indexOf("--from");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const r = await fetch(BASE + "/intake/peach-cursor", { headers: appHeaders() });
  if (r.status !== 200) fail({ error: "cursor_failed", http: r.status });
  const j = await r.json();
  if (!j?.data?.next_from) fail({ error: "cursor_empty" });
  return j.data.next_from;
}

async function peachCall(name, args) {
  const r = await fetch(PEACH_MCP, {
    method: "POST",
    headers: { Authorization: PEACH_KEY, "Content-Type": "application/json",
               Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
                           params: { name, arguments: args } }),
  });
  if (r.status !== 200) fail({ error: "peach_http", http: r.status });
  const j = await r.json();
  if (j.error) fail({ error: "peach_rpc", detail: j.error.message || String(j.error) });
  const text = j?.result?.content?.[0]?.text;
  if (!text) fail({ error: "peach_shape" });
  try { return JSON.parse(text); } catch { fail({ error: "peach_parse" }); }
}

async function main() {
  if (!PEACH_KEY) fail({ error: "no_peach_key" });
  if (!SECRET && !SYNC_TOKEN) fail({ error: "no_app_credential" });
  const from = await cursorFrom();
  const data = await peachCall("peach_list_messages", { from, direction: "inbound", per_page: PER_PAGE });
  const messages = Array.isArray(data.messages) ? data.messages : [];
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ count: messages.length, page: 1, messages }, null, 2));
  console.log(JSON.stringify({ fetched: messages.length, from, file: ".peach-sync/inbound.json" }));
}
main().catch((e) => fail({ error: "unhandled", detail: String(e && e.message || e) }));
