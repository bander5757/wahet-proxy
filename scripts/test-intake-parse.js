// اختبارات M2.5 — تحليل AI + التعديل الأمني لصلاحية GET. staging فقط. لا finance_entry.
const { Pool } = require("pg");
const crypto = require("crypto");
process.env.INTAKE_PARSER = "rule"; // تحليل حتمي بلا مزوّد خارجي/مفتاح
const app = require("../api/app");
const { parseIntake, ruleIntakeParser, finalizeIntakeParse, resolveAccountsFromText } = app.__m25;
const { updateIntake } = app.__m2;

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const TP = "test-m25";
let passed = 0, failed = 0;
function ok(n, c, e) { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } }
async function expectThrow(n, fn, code) { try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode}`); } }

function mockRes() { const r = { code: 0, body: null }; r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; }
const getReq = (token, p = "/intake") => ({ method: "GET", url: "/api/app" + p, query: { path: p }, headers: token ? { "x-wahet-token": token } : {}, body: {} });

async function newIntake(client, pmid, msg) {
  const r = await client.query(
    `insert into whatsapp_intake (provider, provider_message_id, sender_phone, original_message, message_timestamp, source, status)
     values ($1,$2,'+966500000007',$3, now(),'whatsapp','new') returning id`,
    [TP, pmid, msg]
  );
  return r.rows[0].id;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  console.log("DB:", (await client.query("select current_database()")).rows[0].current_database);
  const base = await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from agent_actions) aa,(select count(*)::int from app_users) au,(select count(*)::int from bank_accounts) ba,(select count(*)::int from app_sessions) se,(select count(*)::int from finance_entries) fin");
  console.log("baseline:", base.rows[0]);

  // حسابات مؤقتة
  const mk = async (name, type) => (await client.query("insert into bank_accounts (name, account_type) values ($1,$2) returning id", [name, type])).rows[0].id;
  const accFaisal = await mk("حساب فيصل", "secondary");
  const accAbu = await mk("حساب ابو فايز للعملاء", "secondary");
  const accOrg = await mk("حساب المؤسسة الرسمي", "official");
  const bankIds = [accFaisal, accAbu, accOrg];
  // مستخدمون + جلسات
  const accU = (await client.query("insert into app_users (name,email,role) values ('م25 محاسب','t25-acc@wkaimah.local','accountant') returning id,name,role")).rows[0];
  const viewU = (await client.query("insert into app_users (name,email,role) values ('م25 مشاهد','t25-view@wkaimah.local','viewer') returning id,name,role")).rows[0];
  const userIds = [accU.id, viewU.id];
  const accTok = "t25acc-" + Date.now(), viewTok = "t25view-" + Date.now();
  await client.query("insert into app_sessions (user_id, token_hash, expires_at) values ($1,$2, now()+interval '1 day'),($3,$4, now()+interval '1 day')", [accU.id, sha256(accTok), viewU.id, sha256(viewTok)]);
  const parser = ruleIntakeParser();

  try {
    console.log("\n— parsing (قاعدي حتمي) —");
    const P = async (msg, pmid) => parseIntake(client, await newIntake(client, pmid, msg), { parser });

    const r1 = await P("دفعت 250 ريال بنزين من حساب فيصل", "P1");
    ok("expense واضح → parsed + source", r1.classification === "expense" && r1.status === "parsed" && Number(r1.amount) === 250 && r1.source_account_id === accFaisal, JSON.stringify([r1.classification, r1.status, r1.amount, r1.source_account_id]));

    const r2 = await P("تحصيل 500 ريال من العميل إلى حساب ابو فايز", "P2");
    ok("receipt واضح → parsed + destination", r2.classification === "receipt" && r2.status === "parsed" && r2.destination_account_id === accAbu, JSON.stringify([r2.classification, r2.status, r2.destination_account_id]));

    const r3 = await P("تحويل داخلي 1000 من حساب فيصل إلى حساب المؤسسة الرسمي", "P3");
    ok("internal_transfer → parsed + الطرفان", r3.classification === "internal_transfer" && r3.status === "parsed" && r3.source_account_id === accFaisal && r3.destination_account_id === accOrg, JSON.stringify([r3.classification, r3.status, r3.source_account_id, r3.destination_account_id]));
    ok("التحويل الداخلي ليس expense/receipt", r3.classification === "internal_transfer");

    const r4 = await P("عهدة 300 ريال للموظف عمر", "P4");
    ok("custody → custody", r4.classification === "custody" && Number(r4.amount) === 300);

    const r5 = await P("دفعت 100 ريال صيانة", "P5");
    ok("missing source → needs_review", r5.classification === "expense" && r5.status === "needs_review" && r5.missing_fields.includes("source_account_id"), JSON.stringify([r5.status, r5.missing_fields]));

    const r6 = await P("تحصيل 400 من العميل", "P6");
    ok("missing destination → needs_review", r6.classification === "receipt" && r6.status === "needs_review" && r6.missing_fields.includes("destination_account_id"), JSON.stringify([r6.status, r6.missing_fields]));

    const r7 = await P("السلام عليكم كيف الحال", "P7");
    ok("unknown → needs_review", r7.classification === "unknown" && r7.status === "needs_review");

    // low confidence عبر finalize (تصنيف مجهول ⇒ ثقة 0.2 < 0.6)
    const lo = finalizeIntakeParse({ classification: "unknown", amount: null, currency: "SAR" }, {}, "rule");
    ok("low confidence → needs_review", lo.confidence < 0.6 && lo.status === "needs_review", String(lo.confidence));

    console.log("\n— parsed_data / final_data —");
    const r1full = await app.__m2.getIntake(client, r1.id);
    ok("parsed_data محفوظ", r1full.parsed_data && r1full.parsed_data.classification === "expense" && r1full.parsed_data.parser === "rule");
    ok("final_data غير متأثر (null)", r1full.final_data == null);
    // immutability عند مراجعة لاحقة
    const origParsed = JSON.stringify(r1full.parsed_data);
    await updateIntake(client, { id: r1.id, final_data: { classification: "fuel", amount: 250 } }, accU);
    const r1after = await app.__m2.getIntake(client, r1.id);
    ok("parsed_data لا يتغيّر بعد المراجعة", JSON.stringify(r1after.parsed_data) === origParsed);
    ok("final_data يُملأ بالمراجعة", r1after.final_data && r1after.final_data.classification === "fuel");

    console.log("\n— re-parse ممنوع لغير new —");
    await expectThrow("parse لسجل parsed → 409", () => parseIntake(client, r2.id, { parser }), 409);

    console.log("\n— الأمان: GET intake owner/accountant فقط —");
    const resAcc = mockRes(); await app(getReq(accTok), resAcc);
    ok("accountant GET → 200", resAcc.code === 200 && Array.isArray(resAcc.body.data));
    const resView = mockRes(); await app(getReq(viewTok), resView);
    ok("viewer GET → 403", resView.code === 403, `code=${resView.code}`);
    const resNo = mockRes(); await app(getReq(null), resNo);
    ok("بلا توكن GET → 403", resNo.code === 403, `code=${resNo.code}`);
    const resView2 = mockRes(); await app(getReq(viewTok, "/intake/" + r1.id), resView2);
    ok("viewer GET :id → 403", resView2.code === 403, `code=${resView2.code}`);

    console.log("\n— agent_actions —");
    const aa = await client.query("select action, actor_type, agent_role, confidence from agent_actions where action='intake.parse' and target_id = any($1)", [[r1.id, r2.id, r3.id]]);
    ok("intake.parse مسجّل actor=agent", aa.rows.length >= 3 && aa.rows.every((x) => x.actor_type === "agent" && x.agent_role === "accounting"));
    ok("confidence مسجّل", aa.rows.every((x) => x.confidence != null));

    console.log("\n— لا finance_entry —");
    ok("finance_entries لم يتغيّر", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === base.rows[0].fin);
  } finally {
    console.log("\n— تنظيف —");
    const d1 = await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    const d2 = await client.query("delete from agent_actions where action in ('intake.parse','intake.edit','intake.approve','intake.reject') or actor_ref = any($1)", [userIds]);
    const d3 = await client.query("delete from app_sessions where user_id = any($1)", [userIds]);
    const d4 = await client.query("delete from app_users where id = any($1)", [userIds]);
    const d5 = await client.query("delete from bank_accounts where id = any($1)", [bankIds]);
    console.log(`  حُذف: intake=${d1.rowCount}, agent_actions=${d2.rowCount}, sessions=${d3.rowCount}, users=${d4.rowCount}, banks=${d5.rowCount}`);
    const after = await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from agent_actions) aa,(select count(*)::int from app_users) au,(select count(*)::int from bank_accounts) ba,(select count(*)::int from app_sessions) se,(select count(*)::int from finance_entries) fin");
    console.log("  بعد التنظيف:", after.rows[0]);
    const clean = JSON.stringify(after.rows[0]) === JSON.stringify(base.rows[0]);
    console.log(`  نظافة القاعدة: ${clean ? "✅ لا بقايا" : "❌ بقايا"}`);
    if (!clean) failed++;
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
