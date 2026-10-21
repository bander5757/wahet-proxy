// دورة حفظ وقراءة فعلية عبر HTTP لحقول المؤسسة، وتحقّق المعرّف (400/404). staging فقط.
// لا تعتمد، ولا تنشئ finance_entry، وتنظّف كل ما تُنشئه.
const crypto = require("crypto");
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;

const TP = "test-analysis-http";
const TRUSTED = "+966500000827";
const V = "http-test-1";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };

function mockRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
async function call(method, path, token, body) {
  const res = mockRes();
  await app({ method, url: "/api/app" + path, query: { path }, headers: token ? { "x-analyst-token": token } : {}, body: body || {} }, res);
  return res;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const fin0 = (await client.query("select count(*)::int n from finance_entries")).rows[0].n;
  const an0 = (await client.query("select count(*)::int n from intake_analysis")).rows[0].n;
  const prevTok = (await client.query("select value from app_settings where key='sync_tokens'")).rows[0]?.value || null;
  const prevAl = (await client.query("select value from app_settings where key='intake_allowlist'")).rows[0]?.value || null;
  const tok = "tst_http_" + crypto.randomBytes(8).toString("hex");
  const h = (t) => crypto.createHash("sha256").update(t).digest("hex");
  await client.query(`insert into app_settings (key,value) values ('sync_tokens',$1::jsonb)
    on conflict (key) do update set value=excluded.value`, [JSON.stringify({ tokens: [
      ...(prevTok?.tokens || []), { hash: h(tok), scope: "intake_analyze", label: "test-http", active: true }] })]);
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb)
    on conflict (key) do update set value=excluded.value`, [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر HTTP", active: true }] })]);

  const ids = [];
  try {
    const mk = async (n, msg) => {
      const r = await createWhatsappIntake(client, { provider: TP, provider_message_id: `HTTP-${n}-${Date.now()}`,
        sender_phone: TRUSTED, original_message: msg, message_timestamp: new Date().toISOString() });
      ids.push(r.id); return r.id;
    };
    const idDefault = await mk("A", "مصروف بلا ذكر مؤسسة");
    const idSecond = await mk("B", "مصروف على المؤسسة الثانية");
    const idConflict = await mk("C", "تعليق يخالف المستند في المؤسسة");

    console.log("— تحقّق المعرّف قبل الاستعلام —");
    const bad = await call("GET", "/intake/analysis/source/not-a-uuid", tok);
    ok("source بمعرّف غير صالح ⇒ 400 لا 500", bad.code === 400, `code=${bad.code} body=${JSON.stringify(bad.body)}`);
    const missing = await call("GET", "/intake/analysis/source/11111111-1111-4111-8111-111111111111", tok);
    ok("source بمعرّف صالح غير موجود ⇒ 404", missing.code === 404, `code=${missing.code}`);
    const badList = await call("GET", "/intake/analysis/not-a-uuid", tok);
    ok("قراءة التحليلات بمعرّف غير صالح ⇒ 400", badList.code === 400, `code=${badList.code}`);
    const badSave = await call("POST", "/intake/analysis", tok, { intake_id: "not-a-uuid", analyzer: "eve", analyzer_version: V });
    ok("حفظ بمعرّف غير صالح ⇒ 400", badSave.code === 400, `code=${badSave.code}`);
    const goodSource = await call("GET", `/intake/analysis/source/${idDefault}`, tok);
    ok("source بمعرّف موجود ⇒ 200", goodSource.code === 200 && goodSource.body?.data?.intake_id === idDefault, `code=${goodSource.code}`);
    ok("بلا رمز ⇒ 401", (await call("GET", `/intake/analysis/source/${idDefault}`, null)).code === 401);

    console.log("\n— المؤسسة: دورة حفظ وقراءة عبر HTTP —");
    const save = async (id, fields) => call("POST", "/intake/analysis", tok,
      { intake_id: id, analyzer: "eve", analyzer_version: V, status: "completed", fields });
    const read = async (id) => {
      const r = await call("GET", `/intake/analysis/${id}`, tok);
      const row = (r.body?.data || []).find((x) => x.analyzer_version === V);
      return { code: r.code, org: row?.fields?.organization, src: row?.fields?.organization_source, fields: row?.fields };
    };

    const s1 = await save(idDefault, { amount: 100, description: "بلا ذكر مؤسسة" });
    ok("حفظ بلا مؤسسة ⇒ 201", s1.code === 201, `code=${s1.code} ${JSON.stringify(s1.body)}`);
    const r1 = await read(idDefault);
    ok("القراءة: الرئيسية افتراضياً main/default", r1.org === "main" && r1.src === "default", JSON.stringify(r1));

    const s2 = await save(idSecond, { amount: 200, organization: "secondary", organization_source: "explicit" });
    ok("حفظ الثانية صريحة ⇒ 201", s2.code === 201, `code=${s2.code}`);
    const r2 = await read(idSecond);
    ok("القراءة: secondary/explicit كما أُرسلت", r2.org === "secondary" && r2.src === "explicit", JSON.stringify(r2));

    const s3 = await save(idConflict, { amount: 300, organization: "secondary", organization_source: "conflict" });
    ok("حفظ تعارض ⇒ 201", s3.code === 201, `code=${s3.code}`);
    const r3 = await read(idConflict);
    ok("القراءة: التعارض لا يُحسم ⇒ unresolved/conflict", r3.org === "unresolved" && r3.src === "conflict", JSON.stringify(r3));

    const s4 = await save(idDefault, { amount: 100, organization: "main", organization_source: "default" });
    ok("إعادة الحفظ بنفس الإصدار ⇒ 409", s4.code === 409, `code=${s4.code}`);

    console.log("\n— السجل الأصلي والمال دون تغيير —");
    const orig = await getIntake(client, idDefault);
    ok("حالة السجل الأصلي لم تتغير", orig.status === "needs_review" || orig.status === "parsed", orig.status);
    ok("لا final_data", !orig.final_data);
    ok("لا finance_entry جديد", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === fin0);
  } finally {
    console.log("\n— تنظيف —");
    await client.query("delete from intake_analysis where intake_id = any($1)", [ids]);
    await client.query("update whatsapp_intake set duplicate_of=null, sibling_of=null where provider=$1", [TP]);
    await client.query("delete from agent_actions where target_id = any($1)", [ids]);
    await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    if (prevTok) await client.query("update app_settings set value=$1::jsonb where key='sync_tokens'", [JSON.stringify(prevTok)]);
    else await client.query("delete from app_settings where key='sync_tokens'");
    if (prevAl) await client.query("update app_settings set value=$1::jsonb where key='intake_allowlist'", [JSON.stringify(prevAl)]);
    else await client.query("delete from app_settings where key='intake_allowlist'");
    const an1 = (await client.query("select count(*)::int n from intake_analysis")).rows[0].n;
    const fin1 = (await client.query("select count(*)::int n from finance_entries")).rows[0].n;
    ok(`لا بقايا: intake_analysis=${an1} (كان ${an0})، finance_entries=${fin1} (كان ${fin0})`, an1 === an0 && fin1 === fin0);
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e); process.exit(1); });
