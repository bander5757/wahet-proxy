// اختبارات المزامنة السحابية: مؤشر عبر الخادم + منطق الفلترة بلا قاعدة بيانات. staging فقط.
const { Pool } = require("pg");
const app = require("../api/app");
const { getPeachCursor, updatePeachCursor } = app.__cloudsync;
const cloud = require("./sync-peach-cloud");

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
const msg = (o) => Object.assign({
  id: 950, direction: "inbound", business_phone_number: "+966 55 203 9917",
  contact: { id: 1, name: "بندر العوفي", phone_number: "+966541449943" },
  text: "ديزل", content_type: "document", created_at: "2026-09-17T08:00:00.000Z",
}, o);
const ctx = () => ({ recent: new Set(["111"]), lastCreatedAt: "2026-09-16T00:00:00.000Z" });

async function main() {
  console.log("— الفلترة في النسخة السحابية —");
  ok("رسالة فريق جديدة ⇒ تُرسل", cloud.classify(msg(), ctx()).name === "بندر");
  ok("الصادر يُتجاوز", cloud.classify(msg({ direction: "outbound" }), ctx()).skip === "outbound");
  ok("رقم مؤسسة آخر يُتجاوز", cloud.classify(msg({ business_phone_number: "+966 55 111 2222" }), ctx()).skip === "other_number");
  ok("عميل ليس من الفريق يُتجاوز", cloud.classify(msg({ contact: { id: 2, phone_number: "+966554007002" } }), ctx()).skip === "non_team");
  ok("مُزامَنة سابقاً تُتجاوز", cloud.classify(msg({ id: 111 }), ctx()).skip === "already_synced");
  ok("أقدم من المؤشر تُتجاوز", cloud.classify(msg({ created_at: "2026-09-15T00:00:00.000Z" }), ctx()).skip === "before_cursor");
  ok("أبو فايز وعمر ضمن الفريق",
    cloud.classify(msg({ contact: { id: 3, phone_number: "0504165148" } }), ctx()).name === "أبو فايز" &&
    cloud.classify(msg({ contact: { id: 4, phone_number: "+966506834579" } }), ctx()).name === "عمر");
  const p = cloud.payloadFor(msg({ media_url: "https://app.trypeach.ai/x/Transaction-Receipt.pdf" }), "بندر");
  ok("الحمولة: PDF + تعليق + معرّف نصي", p.attachment_mime === "application/pdf" && p.original_message === "ديزل" && p.provider_message_id === "950");
  ok("إعادة المحاولة لأخطاء الخادم فقط", cloud.isRetryable(500) && cloud.isRetryable(0) && !cloud.isRetryable(201) && !cloud.isRetryable(409));

  console.log("\n— مؤشر المزامنة عبر الخادم —");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const before = (await client.query("select value from app_settings where key='peach_team_sync'")).rows[0]?.value || null;
  const aa0 = (await client.query("select count(*)::int n from agent_actions")).rows[0].n;
  try {
    const cur = await getPeachCursor(client);
    ok("يعيد next_from بتداخل 10 دقائق", !!cur.next_from && (!cur.last_created_at || new Date(cur.last_created_at) - new Date(cur.next_from) === 600000));
    const up = await updatePeachCursor(client, { last_created_at: "2026-09-17T09:00:00.000Z", last_id: 999999, recent_ids: ["999999"],
      actor: "test-cloud", processed: 1, counts: { needs_review: 1 }, skipped: { non_team: 2 } });
    ok("يحفظ المؤشر ويزيد العداد", up.last_id === 999999 && up.runs === (cur.runs + 1));
    const cur2 = await getPeachCursor(client);
    ok("القراءة التالية ترى المؤشر الجديد", cur2.last_created_at === "2026-09-17T09:00:00.000Z" && cur2.recent_ids.includes("999999"));
    const audit = (await client.query("select actor_name, summary, status from agent_actions where action='intake.peach_sync' order by created_at desc limit 1")).rows[0];
    ok("الخادم يكتب سجل التدقيق باسم المُشغّل", audit.actor_name === "test-cloud" && /1 مُمرَّرة/.test(audit.summary) && audit.status === "done");
    const up2 = await updatePeachCursor(client, { last_created_at: "2026-09-17T09:05:00.000Z", last_id: 1000000, actor: "test-cloud", processed: 0, counts: {}, stopped_at: 5 });
    const audit2 = (await client.query("select status from agent_actions where action='intake.peach_sync' order by created_at desc limit 1")).rows[0];
    ok("توقف بسبب فشل ⇒ الحالة failed", audit2.status === "failed" && up2.runs === up.runs + 1);
    ok("لا finance_entry", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === 0);
  } finally {
    if (before) await client.query("update app_settings set value=$1::jsonb where key='peach_team_sync'", [JSON.stringify(before)]);
    else await client.query("delete from app_settings where key='peach_team_sync'");
    await client.query("delete from agent_actions where action='intake.peach_sync' and actor_name='test-cloud'");
    const aa1 = (await client.query("select count(*)::int n from agent_actions")).rows[0].n;
    ok("عودة للـbaseline (المؤشر وسجل التدقيق)", aa1 === aa0);
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
