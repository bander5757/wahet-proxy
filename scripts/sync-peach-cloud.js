// مزامنة Peach → Internal Intake من بيئة سحابية (بلا قاعدة بيانات وبلا ملفات محلية).
// يحتاج متغير بيئة واحداً فقط: WAHET_INTAKE_SECRET (مفتاح وارد staging). لا يرسل واتساب، ولا ينشئ قيوداً مالية.
//   node scripts/sync-peach-cloud.js --cursor   ⇒ يطبع {next_from} لاستعلام Peach
//   node scripts/sync-peach-cloud.js            ⇒ يزامن ما في .peach-sync/inbound.json
const fs = require("fs");
const path = require("path");

const BASE = process.env.WAHET_BASE || "https://wahet-proxy-staging.vercel.app/api/app";
const SECRET = process.env.WAHET_INTAKE_SECRET || "";
const SYNC_TOKEN = process.env.WAHET_SYNC_TOKEN || "";   // رمز مزامنة مستقل (بديل المفتاح الرئيسي)
const INBOX_FILE = path.join(__dirname, "..", ".peach-sync", "inbound.json");
const BUSINESS = "552039917";
// أرقام الفريق الموثوقة (نسخة سحابية: لا وصول لقاعدة البيانات)
const TEAM = { "966541449943": "بندر", "966504165148": "أبو فايز", "966506834579": "عمر" };

function digits(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "966" + d.slice(1);
  else if (d.length === 9 && d.startsWith("5")) d = "966" + d;
  return d;
}
const isRetryable = (http) => http === 0 || http >= 500;
const headers = () => (SECRET
  ? { "Content-Type": "application/json", "x-intake-secret": SECRET }
  : { "Content-Type": "application/json", "x-sync-token": SYNC_TOKEN });

async function api(p, init) {
  const r = await fetch(BASE + p, { ...init, headers: headers() });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, data: j.data || null, error: j.error || null };
}
function classify(m, ctx) {
  if (m.direction !== "inbound") return { skip: "outbound" };
  if (!digits(m.business_phone_number).endsWith(BUSINESS)) return { skip: "other_number" };
  const name = TEAM[digits(m.contact && m.contact.phone_number)];
  if (!name) return { skip: "non_team" };
  if (ctx.recent.has(String(m.id))) return { skip: "already_synced" };
  if (ctx.lastCreatedAt && m.created_at < ctx.lastCreatedAt) return { skip: "before_cursor" };
  return { name };
}
function payloadFor(m, name) {
  const body = {
    provider: "peach", provider_message_id: String(m.id), sender_phone: m.contact.phone_number,
    sender_name: (m.contact && m.contact.name) || name, original_message: m.text || "",
    message_timestamp: m.created_at, source: "whatsapp",
    attachment_meta: { peach_content_type: m.content_type, conversation_id: m.conversation_id, contact_id: m.contact.id },
  };
  if (m.media_url) {
    const fname = decodeURIComponent(String(m.media_url).split("/").pop() || "attachment").slice(0, 120);
    body.attachment_url = m.media_url;
    body.attachment_name = fname;
    body.attachment_mime = /\.pdf$/i.test(fname) ? "application/pdf"
      : /\.(jpe?g|png|webp|heic)$/i.test(fname) ? "image/*" : m.content_type === "image" ? "image/*" : null;
  }
  return body;
}

async function main() {
  if (!SECRET && !SYNC_TOKEN) { console.log(JSON.stringify({ error: "لا يوجد WAHET_INTAKE_SECRET ولا WAHET_SYNC_TOKEN" })); process.exit(2); }
  const cur = await api("/intake/peach-cursor", { method: "GET" });
  if (cur.http !== 200) { console.log(JSON.stringify({ error: "cursor_failed", http: cur.http })); process.exit(1); }
  if (process.argv.includes("--cursor")) { console.log(JSON.stringify({ next_from: cur.data.next_from, last_id: cur.data.last_id, runs: cur.data.runs })); return; }
  if (!fs.existsSync(INBOX_FILE)) { console.log(JSON.stringify({ error: "no_inbox_file", path: ".peach-sync/inbound.json" })); process.exit(2); }

  const raw = JSON.parse(fs.readFileSync(INBOX_FILE, "utf8"));
  const msgs = (Array.isArray(raw) ? raw : raw.messages || []).slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const ctx = { recent: new Set((cur.data.recent_ids || []).map(String)), lastCreatedAt: cur.data.last_created_at };
  const processed = [], skipped = { outbound: 0, other_number: 0, non_team: 0, already_synced: 0, before_cursor: 0 };
  let stoppedAt = null, lastCreated = cur.data.last_created_at, lastId = cur.data.last_id;

  for (const m of msgs) {
    const v = classify(m, ctx);
    if (v.skip) { skipped[v.skip]++; continue; }
    let r = await api("/intake/whatsapp", { method: "POST", body: JSON.stringify(payloadFor(m, v.name)) });
    if (isRetryable(r.http)) r = await api("/intake/whatsapp", { method: "POST", body: JSON.stringify(payloadFor(m, v.name)) });
    const d = r.data || {};
    processed.push({ peach_id: m.id, from: v.name, type: m.content_type, has_media: !!m.media_url,
      http: r.http, result: d.status || (d.stored ? "stored" : null) || r.error, intake_id: d.id || null });
    // فشل الخادم ⇒ نتوقف بلا تقديم المؤشر، فتُعاد المحاولة في التشغيل التالي
    if (isRetryable(r.http)) { stoppedAt = m.id; break; }
    ctx.recent.add(String(m.id)); lastCreated = m.created_at; lastId = m.id;
  }
  const counts = processed.reduce((a, x) => { a[x.result] = (a[x.result] || 0) + 1; return a; }, {});
  const up = await api("/intake/peach-cursor", { method: "POST", body: JSON.stringify({
    last_created_at: lastCreated, last_id: lastId, recent_ids: [...ctx.recent].slice(-300),
    actor: process.env.SYNC_ACTOR || "claude-cloud-routine", processed: processed.length, counts, skipped, stopped_at: stoppedAt }) });
  console.log(JSON.stringify({ processed, skipped, stopped_at: stoppedAt, cursor_saved: up.http === 200, cursor: up.data }));
}

module.exports = { classify, payloadFor, digits, isRetryable, TEAM };
if (require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
