// اختبارات M2 لمراجعة صندوق واتساب — staging فقط. لا ينشئ finance_entry.
// يعزل بياناته بـ provider='test-m2' + مستخدمين مؤقتين، وينظّف كل شيء في النهاية.
const { Pool } = require("pg");
const app = require("../api/app");
const { listIntake, getIntake, updateIntake, approveIntake, rejectIntake } = app.__m2;

const TEST_PROVIDER = "test-m2";
const TEST_PARSED = { classification: "expense", amount: 100, note: "تحليل الوكيل الأصلي" };
// مقارنة مستقلة عن ترتيب مفاتيح jsonb (Postgres لا يحفظ ترتيب المفاتيح)
const canon = (o) => JSON.stringify(o, ["amount", "classification", "note"]);

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}
async function expectThrow(name, fn, code) {
  try { await fn(); ok(name, false, "لم يُرمَ خطأ"); }
  catch (e) { ok(name, e.statusCode === code, `statusCode=${e.statusCode} (${e.message})`); }
}

async function insertTestIntake(client, { providerMessageId, status = "parsed" }) {
  const r = await client.query(
    `insert into whatsapp_intake
       (provider, provider_message_id, sender_phone, sender_name, original_message, message_timestamp, source, parsed_data, classification, amount, confidence_score, missing_fields, status)
     values ($1,$2,'+966500000009','مرسل اختبار','مصروف ١٠٠ ريال بنزين', now(), 'whatsapp', $3::jsonb, 'expense', 100, 0.6, ARRAY['project_name'], $4)
     returning id`,
    [TEST_PROVIDER, providerMessageId, JSON.stringify(TEST_PARSED), status]
  );
  return r.rows[0].id;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  const who = await client.query("select current_database()");
  console.log("DB:", who.rows[0].current_database, "(staging متوقّع)");
  const base = await client.query(
    "select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from agent_actions) aa,(select count(*)::int from app_users) au,(select count(*)::int from finance_entries) fin"
  );
  console.log("baseline:", base.rows[0]);

  // مستخدمو اختبار مؤقتون (reviewed_by يشير لـ app_users)
  const acc = await client.query(
    "insert into app_users (name, email, role) values ('مختبِر محاسب','test-m2-acc@wkaimah.local','accountant') returning id, name, role"
  );
  const view = await client.query(
    "insert into app_users (name, email, role) values ('مختبِر مشاهد','test-m2-view@wkaimah.local','viewer') returning id, name, role"
  );
  const accountant = acc.rows[0];
  const viewer = view.rows[0];
  const testUserIds = [accountant.id, viewer.id];

  let id1, id2;
  try {
    id1 = await insertTestIntake(client, { providerMessageId: "M2-1", status: "parsed" });
    id2 = await insertTestIntake(client, { providerMessageId: "M2-2", status: "parsed" });

    console.log("\n— list / get —");
    const list = await listIntake(client, { status: "parsed" });
    ok("list يُرجع السجلات (فلترة parsed)", list.some((r) => r.id === id1) && list.some((r) => r.id === id2));
    const got = await getIntake(client, id1);
    ok("get يُرجع السجل + parsed_data", got.id === id1 && got.parsed_data && got.parsed_data.note === TEST_PARSED.note, JSON.stringify(got.parsed_data));

    console.log("\n— unauthorized (viewer مستبعد) —");
    await expectThrow("viewer لا يعتمد → 403", () => approveIntake(client, { id: id1 }, viewer), 403);
    await expectThrow("viewer لا يعدّل → 403", () => updateIntake(client, { id: id1, amount: 5 }, viewer), 403);
    await expectThrow("بلا مستخدم → 403", () => approveIntake(client, { id: id1 }, null), 403);

    console.log("\n— edit (final_data + حقول) —");
    const edited = await updateIntake(client, {
      id: id1, amount: 150, classification: "fuel",
      final_data: { classification: "fuel", amount: 150, note: "مصحّح بشرياً" },
    }, accountant);
    ok("amount عُدّل إلى 150", Number(edited.amount) === 150, String(edited.amount));
    ok("final_data مضبوط", edited.final_data && edited.final_data.note === "مصحّح بشرياً");
    ok("parsed_data لم يتغيّر بعد التعديل", canon(edited.parsed_data) === canon(TEST_PARSED), JSON.stringify(edited.parsed_data));

    console.log("\n— approve —");
    const approved = await approveIntake(client, { id: id1 }, accountant);
    ok("status=approved", approved.status === "approved");
    ok("reviewed_by=المحاسب", approved.reviewed_by === accountant.id);
    ok("reviewed_at مضبوط", !!approved.reviewed_at);
    ok("parsed_data لم يتغيّر بعد الاعتماد", canon(approved.parsed_data) === canon(TEST_PARSED));
    // double-approve
    await expectThrow("double-approve → 409", () => approveIntake(client, { id: id1 }, accountant), 409);

    console.log("\n— reject —");
    await expectThrow("reject بلا سبب → 400", () => rejectIntake(client, { id: id2 }, accountant), 400);
    const rejected = await rejectIntake(client, { id: id2, rejection_reason: "غير واضح" }, accountant);
    ok("status=rejected + سبب", rejected.status === "rejected" && rejected.rejection_reason === "غير واضح");
    ok("reviewed_by مضبوط عند الرفض", rejected.reviewed_by === accountant.id);
    await expectThrow("رفض سجل مرفوض → 409", () => rejectIntake(client, { id: id2, rejection_reason: "مكرر" }, accountant), 409);

    console.log("\n— agent_actions —");
    const aa = await client.query(
      "select action, actor_type, actor_ref from agent_actions where target_id = any($1) order by created_at",
      [[id1, id2]]
    );
    const actions = aa.rows.map((r) => r.action);
    ok("سُجّل intake.edit", actions.includes("intake.edit"));
    ok("سُجّل intake.approve", actions.includes("intake.approve"));
    ok("سُجّل intake.reject", actions.includes("intake.reject"));
    ok("كل الأفعال actor_type=human", aa.rows.every((r) => r.actor_type === "human"));

    console.log("\n— لا finance_entry —");
    const fin = await client.query("select count(*)::int n from finance_entries");
    ok("finance_entries لم يتغيّر", fin.rows[0].n === base.rows[0].fin, `fin=${fin.rows[0].n}`);
  } finally {
    console.log("\n— تنظيف —");
    const testIds = (await client.query("select id from whatsapp_intake where provider=$1", [TEST_PROVIDER])).rows.map((r) => r.id);
    const dAa = await client.query("delete from agent_actions where actor_ref = any($1) or target_id = any($2)", [testUserIds, testIds]);
    const dWi = await client.query("delete from whatsapp_intake where provider=$1", [TEST_PROVIDER]);
    const dUsers = await client.query("delete from app_users where id = any($1)", [testUserIds]);
    console.log(`  حُذف: intake=${dWi.rowCount}, agent_actions=${dAa.rowCount}, users=${dUsers.rowCount}`);
    const after = await client.query(
      "select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from agent_actions) aa,(select count(*)::int from app_users) au,(select count(*)::int from finance_entries) fin"
    );
    console.log("  بعد التنظيف:", after.rows[0]);
    const clean = JSON.stringify(after.rows[0]) === JSON.stringify(base.rows[0]);
    console.log(`  نظافة القاعدة: ${clean ? "✅ لا بقايا (مطابق baseline)" : "❌ توجد بقايا"}`);
    if (!clean) failed++;
    client.release();
    await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ غير متوقع:", e.message); process.exit(1); });
