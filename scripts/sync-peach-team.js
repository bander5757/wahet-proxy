// مزامنة رسائل فريق واحة الخيمة: Peach (يقرأها Claude عبر MCP) ⇒ Internal Intake على staging.
// أمر ثابت بلا وسائط ديناميكية:
//   node scripts/sync-peach-team.js --cursor   ⇒ يطبع {next_from} لبدء استعلام Peach
//   node scripts/sync-peach-team.js            ⇒ يزامن ما في ~/.wahet-sync/inbound.json
// القواعد: inbound فقط، أرقام الفريق النشطة فقط، لا Sales، لا إرسال واتساب، لا finance_entry، staging فقط.
const fs = require("fs");
const os = require("os");
const path = require("path");

const INBOX_FILE = path.join(os.homedir(), ".wahet-sync", "inbound.json");
const ENV_FILE = path.join(os.homedir(), ".wahet-staging.env");
const BASE = "https://wahet-proxy-staging.vercel.app/api/app";
const BUSINESS = "552039917";
const STAGING_REF = "asfytsqmiladtcfhtbqb";
const PRODUCTION_REF = "obbhsmmnnqeyspvcurhi";
const OVERLAP_MS = 10 * 60 * 1000;   // تداخل بسيط يمنع ضياع رسالة على حدود المؤشر
const CURSOR_KEY = "peach_team_sync";

// يقرأ إعدادات staging من ملف المستخدم بلا طباعة أي سرّ
function loadEnv() {
  const txt = fs.readFileSync(ENV_FILE, "utf8");
  const env = {};
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.DATABASE_URL || env.DATABASE_URL.includes(PRODUCTION_REF) || !env.DATABASE_URL.includes(STAGING_REF)) {
    throw new Error("رفض: قاعدة البيانات ليست staging");
  }
  if (!env.INTAKE_SECRET) throw new Error("INTAKE_SECRET غير متوفر");
  return env;
}
// تطبيع لأرقام السعودية: 05xxxxxxxx و00966 و5xxxxxxxx ⇒ 9665xxxxxxxx
function digits(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "966" + d.slice(1);
  else if (d.length === 9 && d.startsWith("5")) d = "966" + d;
  return d;
}

// منطق نقي قابل للاختبار: أي رسالة تُمرَّر ولماذا تُتجاوز
function classifyMessage(m, ctx) {
  if (m.direction !== "inbound") return { action: "skip", reason: "outbound" };
  if (!digits(m.business_phone_number).endsWith(BUSINESS)) return { action: "skip", reason: "other_number" };
  const name = ctx.teamBy.get(digits(m.contact && m.contact.phone_number));
  if (!name) return { action: "skip", reason: "non_team" };           // العملاء ليسوا من مهمة هذه المزامنة
  if (ctx.recent.has(String(m.id))) return { action: "skip", reason: "already_synced" };
  if (ctx.lastCreatedAt && m.created_at < ctx.lastCreatedAt) return { action: "skip", reason: "before_cursor" };
  return { action: "send", name };
}
function intakePayload(m, name) {
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
      : /\.(jpe?g|png|webp|heic)$/i.test(fname) ? "image/*"
      : m.content_type === "image" ? "image/*" : null;
  }
  return body;
}
// فشل الخادم/الشبكة ⇒ نتوقف ولا نحرّك المؤشر، فتُعاد المحاولة في التشغيل التالي
const isRetryable = (http) => http === 0 || http >= 500;

async function post(env, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(BASE + "/intake/whatsapp", {
        method: "POST", headers: { "Content-Type": "application/json", "x-intake-secret": env.INTAKE_SECRET },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!isRetryable(r.status)) return { http: r.status, data: j.data || null, error: j.error || null };
      if (attempt === 2) return { http: r.status, error: j.error || "server_error" };
    } catch (e) { if (attempt === 2) return { http: 0, error: e.message }; }
  }
  return { http: 0, error: "unreachable" };
}

async function main() {
  const wantCursor = process.argv.includes("--cursor");
  const dryRun = process.argv.includes("--dry-run");
  const env = loadEnv();
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    const cur = (await client.query("select value from app_settings where key=$1", [CURSOR_KEY])).rows[0]?.value
      || { last_created_at: null, last_id: null, recent_ids: [], runs: 0 };
    if (wantCursor) {
      const nextFrom = cur.last_created_at
        ? new Date(new Date(cur.last_created_at).getTime() - OVERLAP_MS).toISOString()
        : new Date(Date.now() - 7 * 864e5).toISOString();
      console.log(JSON.stringify({ next_from: nextFrom, last_id: cur.last_id || null, runs: cur.runs || 0 }));
      return;
    }
    if (!fs.existsSync(INBOX_FILE)) { console.log(JSON.stringify({ error: "no_inbox_file", path: INBOX_FILE })); process.exitCode = 2; return; }
    const raw = JSON.parse(fs.readFileSync(INBOX_FILE, "utf8"));
    const msgs = (Array.isArray(raw) ? raw : raw.messages || []).slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
    const team = ((await client.query("select value from app_settings where key='intake_allowlist'")).rows[0]?.value?.members || [])
      .filter((x) => x.active !== false);
    const ctx = { teamBy: new Map(team.map((x) => [digits(x.phone), x.name])), recent: new Set((cur.recent_ids || []).map(String)), lastCreatedAt: cur.last_created_at };

    const processed = [], skipped = { outbound: 0, other_number: 0, non_team: 0, already_synced: 0, before_cursor: 0 };
    let stoppedAt = null;
    for (const m of msgs) {
      const verdict = classifyMessage(m, ctx);
      if (verdict.action === "skip") { skipped[verdict.reason]++; continue; }
      if (dryRun) { processed.push({ peach_id: m.id, from: verdict.name, result: "dry_run" }); continue; }
      const r = await post(env, intakePayload(m, verdict.name));
      const d = r.data || {};
      processed.push({ peach_id: m.id, at: m.created_at, from: verdict.name, type: m.content_type, has_media: !!m.media_url,
        http: r.http, result: d.status || (d.stored ? "stored" : null) || r.error, reason: d.reason || null, intake_id: d.id || null });
      if (isRetryable(r.http)) { stoppedAt = m.id; break; }
      // الرسالة محفوظة على الخادم (حتى لو فشل المرفق أو التحليل تبقى للمراجعة) ⇒ نتقدّم بالمؤشر
      ctx.recent.add(String(m.id));
      cur.last_created_at = m.created_at; cur.last_id = m.id; cur.recent_ids = [...ctx.recent].slice(-300);
      await client.query(`insert into app_settings (key,value) values ($1,$2::jsonb) on conflict (key) do update set value=excluded.value`, [CURSOR_KEY, JSON.stringify(cur)]);
    }
    if (!dryRun) {
      cur.last_run_at = new Date().toISOString(); cur.runs = (cur.runs || 0) + 1;
      await client.query(`insert into app_settings (key,value) values ($1,$2::jsonb) on conflict (key) do update set value=excluded.value`, [CURSOR_KEY, JSON.stringify(cur)]);
      // سجل التدقيق: تشغيل بلا جديد يُسجَّل أيضاً (خفيف) ليبقى أثر لكل تشغيل
      const counts = processed.reduce((a, x) => { a[x.result] = (a[x.result] || 0) + 1; return a; }, {});
      await client.query(
        `insert into agent_actions (actor_type, actor_name, agent_role, action, target_type, summary, after_state, status)
         values ('agent','claude-scheduled-sync','accounting','intake.peach_sync','app_settings',$1,$2::jsonb,$3)`,
        [`مزامنة Peach: ${processed.length} مُمرَّرة ${JSON.stringify(counts)}`,
         JSON.stringify({ counts, skipped, cursor: { last_created_at: cur.last_created_at, last_id: cur.last_id } }),
         stoppedAt ? "failed" : "done"]);
    }
    console.log(JSON.stringify({ processed, skipped, stopped_at: stoppedAt,
      cursor: { last_created_at: cur.last_created_at, last_id: cur.last_id, runs: cur.runs } }));
  } finally { client.release(); await pool.end(); }
}

module.exports = { classifyMessage, intakePayload, isRetryable, digits, INBOX_FILE };
if (require.main === module) main().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
