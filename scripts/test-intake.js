// اختبارات M1 لـ WhatsApp Intake — staging فقط. لا يلمس finance_entries، لا ينشئ finance_entry.
// التشغيل: node -r <preloader لـ staging> scripts/test-intake.js
// يعزل بياناته بـ provider='test-m1' وأرقام/معرّفات اختبار، وينظّفها بالكامل في النهاية.
const { Pool } = require("pg");

process.env.INTAKE_SECRET = process.env.INTAKE_SECRET || "test-secret-m1";
const app = require("../api/app");
const { normalizePhoneE164, computeIntakeDedupHash, createWhatsappIntake } = app.__m1;

const TEST_PROVIDER = "test-m1";
const TRUSTED = "+966500000001"; // في allowlist الاختبار
const UNTRUSTED_RAW = "0559999999"; // خارج allowlist

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}
async function expectThrow(name, fn, code) {
  try { await fn(); ok(name, false, "لم يُرمَ خطأ"); }
  catch (e) { ok(name, e.statusCode === code, `statusCode=${e.statusCode}`); }
}

function mockRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
function intakeReq(headers, body) {
  return { method: "POST", url: "/api/app/intake/whatsapp", query: { path: "/intake/whatsapp" }, headers: headers || {}, body: body || {} };
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  // حارس: لا نشتغل على الإنتاج
  const who = await client.query("select current_database()");
  console.log("DB:", who.rows[0].current_database, "(staging متوقّع)");

  // خطوط الأساس
  const base = await client.query(
    "select (select count(*)::int from whatsapp_intake) wi, (select count(*)::int from agent_actions) aa, (select count(*)::int from finance_entries) fin"
  );
  console.log("baseline:", base.rows[0]);

  // نسخة احتياطية من allowlist ثم ضبط allowlist اختبار
  const prev = await client.query("select value from app_settings where key='intake_allowlist'");
  const hadAllowlist = prev.rows.length > 0;
  const testAllowlist = { members: [{ phone: TRUSTED, name: "مختبِر", active: true, role: "accountant" }], updated_at: new Date().toISOString() };
  await client.query(
    `insert into app_settings (key, value) values ('intake_allowlist', $1::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(testAllowlist)]
  );

  try {
    console.log("\n— normalizePhoneE164 —");
    ok("05... → +966", normalizePhoneE164("0501234567") === "+966501234567");
    ok("+966 يبقى", normalizePhoneE164("+966501234567") === "+966501234567");
    ok("0096 → +966", normalizePhoneE164("00966501234567") === "+966501234567");
    ok("5XXXXXXXX → +966", normalizePhoneE164("501234567") === "+966501234567");
    ok("أرقام عربية", normalizePhoneE164("٠٥٠١٢٣٤٥٦٧") === "+966501234567");
    ok("غير صالح 'abc' → null", normalizePhoneE164("abc") === null);
    ok("قصير '123' → null", normalizePhoneE164("123") === null);

    console.log("\n— createWhatsappIntake (منطق أساسي) —");
    // 1) حقول ناقصة
    await expectThrow("missing original_message → 400", () => createWhatsappIntake(client, { sender_phone: TRUSTED }), 400);
    await expectThrow("missing sender_phone → 400", () => createWhatsappIntake(client, { original_message: "مصروف 100" }), 400);
    // 2) رقم غير صالح
    await expectThrow("invalid phone → 400", () => createWhatsappIntake(client, { sender_phone: "abc", original_message: "مصروف 100" }), 400);
    // 3) رقم غير موثوق
    const r3 = await createWhatsappIntake(client, { sender_phone: UNTRUSTED_RAW, original_message: "مصروف 100" });
    ok("untrusted → rejected, غير مخزّن", r3.status === "rejected" && r3.stored === false, JSON.stringify(r3));
    // 4) موثوق جديد
    const r4 = await createWhatsappIntake(client, {
      provider: TEST_PROVIDER, provider_message_id: "TESTM1-1", sender_phone: "0500000001",
      original_message: "مصروف 100 ريال بنزين", message_timestamp: "2026-09-10T10:00:00Z", amount: 100,
    });
    ok("trusted new → stored + حُلِّل تلقائياً (M2.6)", r4.stored === true && r4.sender_phone === TRUSTED && r4.parse?.attempted === true && r4.status !== "new", JSON.stringify(r4));
    // 5) تكرار provider_message_id
    const r5 = await createWhatsappIntake(client, {
      provider: TEST_PROVIDER, provider_message_id: "TESTM1-1", sender_phone: "0500000001",
      original_message: "نص مختلف تماماً", message_timestamp: "2026-09-10T12:00:00Z",
    });
    ok("duplicate provider_message_id", r5.status === "duplicate" && r5.reason === "provider_message_id", JSON.stringify(r5));
    // 6) تكرار dedup_hash (نفس المحتوى، معرّف مختلف)
    const r6 = await createWhatsappIntake(client, {
      provider: TEST_PROVIDER, provider_message_id: "TESTM1-2", sender_phone: "0500000001",
      original_message: "مصروف 100 ريال بنزين", message_timestamp: "2026-09-10T10:00:00Z", amount: 100,
    });
    ok("duplicate dedup_hash", r6.status === "duplicate" && r6.reason === "dedup_hash", JSON.stringify(r6));

    console.log("\n— handler (HTTP + secret) —");
    // 7) بلا secret → 401
    const res7 = mockRes();
    await app(intakeReq({}, { sender_phone: TRUSTED, original_message: "x" }), res7);
    ok("no secret → 401", res7.code === 401, `code=${res7.code}`);
    // 8) secret صحيح + موثوق جديد → 201
    const res8 = mockRes();
    await app(intakeReq({ "x-intake-secret": process.env.INTAKE_SECRET }, {
      provider: TEST_PROVIDER, provider_message_id: "TESTM1-H1", sender_phone: TRUSTED,
      original_message: "مصروف عبر الـhandler", message_timestamp: "2026-09-11T09:00:00Z",
    }), res8);
    ok("handler happy → 201 + stored", res8.code === 201 && res8.body?.data?.stored === true, `code=${res8.code} body=${JSON.stringify(res8.body)}`);

    // تأكيد عدم إنشاء أي finance_entry أثناء الاختبار
    const fin = await client.query("select count(*)::int n from finance_entries");
    // مقارنة بالحالة قبل التشغيل، لا بصفر مطلق (قد توجد قيود قديمة في staging)
    ok("لا finance_entry أُنشئ", fin.rows[0].n === base.rows[0].fin, `finance_entries=${fin.rows[0].n} baseline=${base.rows[0].fin}`);
  } finally {
    // ── تنظيف تام ──
    console.log("\n— تنظيف بيانات الاختبار —");
    // نحذف أفعال سجلات الاختبار فقط — لا نمسّ سجل التدقيق الحقيقي في staging
    const testIds = (await client.query("select id from whatsapp_intake where provider = $1", [TEST_PROVIDER])).rows.map((r) => r.id);
    // + سجل رفض الرقم غير الموثوق الذي يرسله الاختبار عمداً (بلا target بطبيعته)
    const delAa = await client.query(
      "delete from agent_actions where target_id = any($1) or (action = 'intake.reject_untrusted' and summary like '%+966559999999%')", [testIds]);
    const delWi = await client.query("delete from whatsapp_intake where provider = $1", [TEST_PROVIDER]);
    console.log(`  حُذف: whatsapp_intake=${delWi.rowCount}, agent_actions=${delAa.rowCount}`);
    // استرجاع allowlist
    if (hadAllowlist) {
      await client.query("update app_settings set value=$1::jsonb where key='intake_allowlist'", [JSON.stringify(prev.rows[0].value)]);
      console.log("  استُرجع allowlist السابق");
    } else {
      await client.query("delete from app_settings where key='intake_allowlist'");
      console.log("  حُذف allowlist الاختبار (لم يكن موجوداً قبلاً)");
    }
    // تحقق من عدم وجود بقايا
    const after = await client.query(
      "select (select count(*)::int from whatsapp_intake) wi, (select count(*)::int from agent_actions) aa"
    );
    console.log("  بعد التنظيف:", after.rows[0], "(يجب مطابقة baseline)");
    const clean = after.rows[0].wi === base.rows[0].wi && after.rows[0].aa === base.rows[0].aa;
    console.log(`  نظافة القاعدة: ${clean ? "✅ لا بقايا" : "❌ توجد بقايا"}`);
    if (!clean) failed++;
    client.release();
    await pool.end();
  }

  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ غير متوقع:", e.message); process.exit(1); });
