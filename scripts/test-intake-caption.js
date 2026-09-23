// اختبارات فهم تعليقات المعاملات العربية + قراءة الإيصالات (staging فقط). نصوص الإيصالات هنا مصطنعة بأرقام وهمية.
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;
const { parseFinancialCaption, ruleClassify, extractReceiptFields } = app.__p17;

const TP = "test-caption";
const TRUSTED = "+966500000823";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };

// قالب «بين حساباتي» كما ظهر هيكله في الإيصال الحقيقي (أرقام وهمية، IBAN بمسافات، بلا خانة مرجع)
const OWN_TEXT = "Transfer ReceiptDate 2026/09/11 - 3:15 PM Between my accounts Details 300 SARAmount Al Rajhi BankFrom SA12 3456 7890 1234 5678 9012 To Alrajhibank.com.sa800 124 0000";
// قالب «تحويل محلي» بمرجع صريح (أرقام وهمية)
const LOCAL_TEXT = (ref) => `Transfer ReceiptDate 2026/09/12 - 06:03 PMLocal Transfers Transaction Details 450.00Total Amount 21000010006080145472From SA9900000000000000009999To ${ref}Payment Reference NumberAlrajhibank.com.sa800 122 8888`;
const fakeProc = (sha, text) => async () => ({ status: "extracted", sha256: sha, bytes: 1000, contentType: "application/pdf",
  text_len: text.length, text, fields: extractReceiptFields(text) });

async function main() {
  console.log("— صيغ الشراء واللهجات —");
  const cases = [
    ["شرا فريون", "purchase", "شراء فريون"], ["شراء فريون", "purchase", "شراء فريون"], ["اشتريت ديزل للمولد", "purchase", "شراء ديزل للمولد"],
    ["اشتري كيابل كهرب", "purchase", "شراء كيابل كهرب"], ["مشتريات الموقع", "purchase", "مشتريات الموقع"], ["تم شراء غاز", "purchase", "شراء غاز"],
    ["شريت فريون", "purchase", "شراء فريون"], ["اشترينا مواد تركيب", "purchase", "شراء مواد تركيب"], ["أشتريت زيت", "purchase", "شراء زيت"],
    ["شرا", "purchase", "شراء"], ["فريون", null, "فريون"], ["شراكة مع مؤسسة", null, "شراكة مع مؤسسة"], ["شراع للخيمة", null, "شراع للخيمة"],
  ];
  for (const [txt, intent, desc] of cases) {
    const r = parseFinancialCaption(txt);
    ok(`«${txt}» ⇒ ${intent || "بلا نية"} / «${desc}»`, r.intent === intent && r.description === desc, JSON.stringify(r));
  }
  ok("«شرا فريون» ⇒ expense بالقواعد", ruleClassify("شرا فريون").classification === "expense");
  ok("«فريون» وحدها ليست تصنيفاً", ruleClassify("فريون").classification === "unknown");
  ok("«شراكة» ليست مصروفاً", ruleClassify("شراكة مع مؤسسة").classification !== "expense");

  console.log("\n— قراءة الإيصالات —");
  const own = extractReceiptFields(OWN_TEXT);
  ok("بين حساباتي: المبلغ 300", own.amount === 300, String(own.amount));
  ok("بين حساباتي: transfer_kind=own_accounts", own.transfer_kind === "own_accounts");
  ok("IBAN بمسافات يُلتقط ويُوحَّد", own.iban === "SA1234567890123456789012", String(own.iban));
  ok("لا خانة مرجع ⇒ null بلا تخمين (لا أرقام IBAN/هاتف)", own.reference === null, String(own.reference));
  ok("التاريخ والبنك", own.transaction_date === "2026-09-11" && /rajhi/i.test(own.bank || ""));
  const loc = extractReceiptFields(LOCAL_TEXT("9112092600655951"));
  ok("تحويل محلي: المرجع يُلتقط", loc.reference === "9112092600655951" && loc.transfer_kind === "local", JSON.stringify(loc));
  ok("المرجع بصيغة Reference No", extractReceiptFields("Transfer Receipt Reference No: 123456789012 Amount 50 SAR").reference === "123456789012");

  console.log("\n— مسار كامل (Internal Intake) —");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const fin0 = (await client.query("select count(*)::int n from finance_entries")).rows[0].n;
  const prevAl = await client.query("select value from app_settings where key='intake_allowlist'");
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb) on conflict (key) do update set value=excluded.value`,
    [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر caption", active: true }] })]);
  try {
    const r1 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "C1", sender_phone: TRUSTED, original_message: "شرا فريون",
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/c1/Transaction-Receipt.pdf", attachment_mime: "application/pdf",
      message_timestamp: new Date().toISOString() }, { processAttachment: fakeProc("CAP_SHA_1", OWN_TEXT) });
    const row1 = await getIntake(client, r1.id);
    ok("الوصف: شراء فريون", row1.parsed_data?.description === "شراء فريون", JSON.stringify(row1.parsed_data?.description));
    ok("بين حساباتي + شراء ⇒ internal_transfer مع ملاحظة تعارض", row1.classification === "internal_transfer" && /بين حساباتك/.test(row1.parsed_data?.review_note || ""));
    ok("التعارض ⇒ needs_review", row1.status === "needs_review");
    ok("المبلغ 300 من المستند", Number(row1.amount) === 300);
    const meta1 = (await client.query("select attachment_meta from whatsapp_intake where id=$1", [r1.id])).rows[0].attachment_meta;
    ok("النص الخام حُذف بعد التحليل، والحقول باقية", !("text" in (meta1.extraction || {})) && meta1.extraction.fields?.transfer_kind === "own_accounts");
    const aa = await client.query("select count(*)::int n from agent_actions where target_id=$1 and (summary ilike '%Alrajhibank%' or coalesce(after_state::text,'') ilike '%Alrajhibank%')", [r1.id]);
    ok("لا نص مستند في agent_actions", aa.rows[0].n === 0);

    const ref = "7" + String(Date.now()).slice(-13) + "3";
    const r2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "C2", sender_phone: TRUSTED, original_message: "اشتريت ديزل",
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/c2/Transaction-Receipt.pdf", attachment_mime: "application/pdf",
      message_timestamp: new Date().toISOString() }, { processAttachment: fakeProc("CAP_SHA_2", LOCAL_TEXT(ref)) });
    const row2 = await getIntake(client, r2.id);
    ok("تحويل محلي + «اشتريت ديزل» ⇒ expense + وصف + مرجع", row2.classification === "expense" && row2.parsed_data?.description === "شراء ديزل" && row2.transaction_reference === ref,
      JSON.stringify({ c: row2.classification, d: row2.parsed_data?.description, r: row2.transaction_reference }));
    ok("لا ملاحظة تعارض للتحويل المحلي", !row2.parsed_data?.review_note);

    const r3 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "C3", sender_phone: TRUSTED, original_message: "فريون",
      message_timestamp: new Date().toISOString() });
    const row3 = await getIntake(client, r3.id);
    ok("«فريون» بلا قرائن مالية ⇒ unknown + needs_review + الوصف محفوظ", row3.classification === "unknown" && row3.status === "needs_review" && row3.parsed_data?.description === "فريون");
    ok("لا finance_entry", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === fin0);
  } finally {
    await client.query("update whatsapp_intake set duplicate_of=null, sibling_of=null where provider=$1", [TP]);
    const ids = (await client.query("select id from whatsapp_intake where provider=$1", [TP])).rows.map((r) => r.id);
    await client.query("delete from agent_actions where target_id = any($1)", [ids]);
    await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    if (prevAl.rows.length) await client.query("update app_settings set value=$1::jsonb where key='intake_allowlist'", [JSON.stringify(prevAl.rows[0].value)]);
    else await client.query("delete from app_settings where key='intake_allowlist'");
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
