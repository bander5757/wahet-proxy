// اختبارات M2.6 — إدارة allowlist + التحليل التلقائي. staging فقط. لا finance_entry.
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;
const { parseIntake, ruleIntakeParser } = app.__m25;
const { listIntakeAllowlist, upsertIntakeAllowlistMember } = app.__m26;

const TP = "test-m26";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectThrow(n, fn, code) { try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode}`); } }
const boomParser = { name: "boom", async classify() { throw new Error("parser down"); } };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const snap = async () => (await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from agent_actions) aa,(select count(*)::int from app_users) au,(select count(*)::int from finance_entries) fin,(select count(*)::int from app_settings where key='intake_allowlist') al")).rows[0];
  const base = await snap();
  console.log("baseline:", JSON.stringify(base));

  const owner = (await client.query("insert into app_users (name,email,role) values ('م26 مالك','t26-own@wkaimah.local','owner') returning id,name,role")).rows[0];
  const acct = (await client.query("insert into app_users (name,email,role) values ('م26 محاسب','t26-acc@wkaimah.local','accountant') returning id,name,role")).rows[0];
  const viewer = (await client.query("insert into app_users (name,email,role) values ('م26 مشاهد','t26-view@wkaimah.local','viewer') returning id,name,role")).rows[0];
  const userIds = [owner.id, acct.id, viewer.id];

  try {
    console.log("\n— (أ) إدارة allowlist: owner فقط —");
    await expectThrow("accountant لا يدير → 403", () => upsertIntakeAllowlistMember(client, { phone: "0500000001" }, acct), 403);
    await expectThrow("viewer لا يدير → 403", () => upsertIntakeAllowlistMember(client, { phone: "0500000001" }, viewer), 403);
    await expectThrow("بلا مستخدم → 403", () => upsertIntakeAllowlistMember(client, { phone: "0500000001" }, null), 403);
    await expectThrow("رقم غير صالح → 400", () => upsertIntakeAllowlistMember(client, { phone: "abc" }, owner), 400);

    let list = await upsertIntakeAllowlistMember(client, { phone: "0500000777", name: "عمر" }, owner);
    ok("إضافة عضو + تطبيع E.164", list.some((m) => m.phone === "+966500000777" && m.name === "عمر" && m.active === true), JSON.stringify(list));
    list = await upsertIntakeAllowlistMember(client, { phone: "+966500000777", name: "عمر المشرف" }, owner);
    ok("تعديل لا يكرّر (مطابقة بالرقم)", list.filter((m) => m.phone === "+966500000777").length === 1 && list[0].name === "عمر المشرف");
    list = await upsertIntakeAllowlistMember(client, { phone: "966500000777", active: false }, owner);
    ok("تعطيل عضو", list.find((m) => m.phone === "+966500000777").active === false);
    ok("GET list يعمل", (await listIntakeAllowlist(client)).length === 1);

    console.log("\n— (ب) الرقم المعطّل يُرفض —");
    const rDis = await createWhatsappIntake(client, { provider: TP, provider_message_id: "A0", sender_phone: "0500000777", original_message: "مصروف 50" });
    ok("عضو معطّل ⇒ untrusted", rDis.status === "rejected" && rDis.stored === false, JSON.stringify(rDis));

    // نُعيد تفعيله للاختبارات التالية
    await upsertIntakeAllowlistMember(client, { phone: "0500000777", active: true }, owner);

    console.log("\n— (ج) auto-parse بعد الاستقبال —");
    const r1 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "A1", sender_phone: "0500000777", original_message: "دفعت 250 ريال بنزين من حساب فيصل", message_timestamp: "2026-09-12T10:00:00Z" });
    ok("محفوظ + حُلِّل تلقائياً (ليس new)", r1.stored === true && r1.parse?.attempted === true && r1.parse?.ok === true && r1.status !== "new", JSON.stringify({ s: r1.status, p: r1.parse }));
    const row1 = await getIntake(client, r1.id);
    ok("status=parsed (الحساب المصدر تحقّق من النص)", row1.status === "parsed", row1.status);
    ok("parsed_data مكتوب", !!row1.parsed_data && row1.parsed_data.classification === "expense");
    ok("final_data ما زال null", row1.final_data == null);

    console.log("\n— (د) فشل parser لا يفقد الرسالة —");
    const r2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "A2", sender_phone: "0500000777", original_message: "مصروف 90 ريال" }, { parser: boomParser });
    ok("الرسالة محفوظة رغم فشل التحليل", r2.stored === true && !!r2.id);
    ok("status=failed + خطأ واضح", r2.status === "failed" && r2.parse?.ok === false && /parser down/.test(r2.parse?.error || ""), JSON.stringify(r2.parse));
    const row2 = await getIntake(client, r2.id);
    ok("error_message محفوظ في السجل", row2.status === "failed");
    const failLog = await client.query("select status, error_message from agent_actions where target_id=$1 and action='intake.parse'", [r2.id]);
    ok("agent_actions يسجّل فشل التحليل", failLog.rows.some((x) => x.status === "failed" && /parser down/.test(x.error_message || "")));

    console.log("\n— (هـ) إعادة المحاولة من failed —");
    const retried = await parseIntake(client, r2.id, { parser: ruleIntakeParser() });
    ok("retry ينجح ويحوّل الحالة", retried.status === "needs_review" && retried.classification === "expense", JSON.stringify({ s: retried.status }));
    const row2b = await client.query("select error_message, parsed_data from whatsapp_intake where id=$1", [r2.id]);
    ok("error_message مُسح بعد النجاح", row2b.rows[0].error_message === null && !!row2b.rows[0].parsed_data);

    console.log("\n— (و) dedup ما زال يعمل مع auto-parse —");
    const dup = await createWhatsappIntake(client, { provider: TP, provider_message_id: "A1", sender_phone: "0500000777", original_message: "نص آخر" });
    ok("تكرار provider_message_id ⇒ duplicate بلا صف جديد", dup.status === "duplicate" && dup.stored === false);

    console.log("\n— (ز) لا finance_entry —");
    ok("finance_entries لم يتغيّر", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === base.fin);
  } finally {
    console.log("\n— تنظيف —");
    const d1 = await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    const d2 = await client.query("delete from agent_actions where action like 'intake.%' or actor_ref = any($1)", [userIds]);
    const d3 = await client.query("delete from app_users where id = any($1)", [userIds]);
    const d4 = await client.query("delete from app_settings where key='intake_allowlist'");
    console.log(`  حُذف: intake=${d1.rowCount} actions=${d2.rowCount} users=${d3.rowCount} allowlist=${d4.rowCount}`);
    const after = await snap();
    console.log("  بعد التنظيف:", JSON.stringify(after));
    const clean = JSON.stringify(after) === JSON.stringify(base);
    console.log(`  نظافة القاعدة: ${clean ? "✅ baseline" : "❌ بقايا"}`);
    if (!clean) failed++;
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
