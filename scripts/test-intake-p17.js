// اختبارات P1.7 — استخراج المستند، sha256، مرجع العملية، dedup متدرّج، ربط الشقيقة. staging فقط.
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;
const { extractReceiptFields } = app.__p17;

const TP = "test-p17";
const TRUSTED = "+966500000822";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };

// نص إيصال حقيقي (كما استُخرج فعلاً من Transaction-Receipt.pdf عبر Vercel)
const REAL_TEXT = `Transfer ReceiptDate 2026/09/12 - 06:03 PMLocal Transfers Transaction Details 1,000.58Total Amount 21000010006080145472From SA6220EC0208992000020938To 9112092600655951Payment Reference NumberAlrajhibank.com.sa800 122 8888`;

// مرجع فريد لكل تشغيل للحالات التي تكتب في القاعدة — حتى لا تصطدم بسجل بندر الحقيقي المُبقى في staging
const TEST_REF = "7" + String(Date.now()).slice(-12) + "01";
const DB_TEXT = REAL_TEXT.replace("9112092600655951", TEST_REF);
// مرفق وهمي محكوم: لا شبكة، نحقن نتيجة المعالجة لاختبار المنطق حتمياً
const fakeProc = (sha, fields, text) => async () => ({ status: "extracted", sha256: sha, bytes: 1234,
  contentType: "application/pdf", text_len: (text || DB_TEXT).length, text: text || DB_TEXT,
  fields: fields || extractReceiptFields(text || DB_TEXT) });

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const snap = async () => (await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from finance_entries) fin")).rows[0];
  const base = await snap();
  console.log("baseline:", JSON.stringify(base));
  const prevAl = await client.query("select value from app_settings where key='intake_allowlist'");
  const hadAl = prevAl.rows.length > 0;
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb)
    on conflict (key) do update set value=excluded.value`, [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر P17", active: true }] })]);

  try {
    console.log("\n— (C) استخراج حقول الإيصال من نص حقيقي —");
    const f = extractReceiptFields(REAL_TEXT);
    ok("المبلغ 1000.58", f.amount === 1000.58, String(f.amount));
    ok("مرجع العملية 9112092600655951", f.reference === "9112092600655951", String(f.reference));
    ok("IBAN مُلتقط", f.iban === "SA6220EC0208992000020938", String(f.iban));
    ok("التاريخ 2026-09-12", f.transaction_date === "2026-09-12", String(f.transaction_date));
    ok("البنك الراجحي", /rajhi/i.test(f.bank || ""), String(f.bank));
    ok("نوع المستند transfer_receipt", f.doc_kind === "transfer_receipt", String(f.doc_kind));
    const empty = extractReceiptFields("مرحبا كيف الحال");
    ok("نص بلا بيانات ⇒ لا تخمين", empty.amount === null && empty.reference === null && empty.iban === null);

    console.log("\n— (A/B) الاستخراج موصول بالاستقبال —");
    const r1 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "R1", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/x1/Transaction-Receipt.pdf",
      attachment_name: "Transaction-Receipt.pdf", attachment_mime: "application/pdf",
      message_timestamp: "2026-09-12T13:00:00Z" }, { processAttachment: fakeProc("HASH_AAA") });
    ok("مرفق فقط مقبول", r1.stored === true, JSON.stringify(r1));
    const row1 = await getIntake(client, r1.id);
    ok("attachment_sha256 مخزّن", row1.attachment_sha256 === "HASH_AAA");
    ok("transaction_reference مخزّن", row1.transaction_reference === TEST_REF, String(row1.transaction_reference));
    ok("المبلغ من المستند 1000.58", Number(row1.amount) === 1000.58, String(row1.amount));
    const meta = (await client.query("select attachment_meta from whatsapp_intake where id=$1", [r1.id])).rows[0].attachment_meta;
    ok("تفاصيل الاستخراج في attachment_meta", meta?.extraction?.status === "extracted" && meta.extraction.fields.reference === TEST_REF);
    ok("parsed_data لا يحوي النص الخام", !JSON.stringify(row1.parsed_data).includes("Alrajhibank"));

    console.log("\n— (E) ترتيب dedup —");
    // نفس الملف (نفس hash) ⇒ duplicate
    const dupHash = await createWhatsappIntake(client, { provider: TP, provider_message_id: "R2", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/x2/copy.pdf",
      attachment_mime: "application/pdf", message_timestamp: "2026-09-12T13:10:00Z" }, { processAttachment: fakeProc("HASH_AAA") });
    ok("نفس sha256 ⇒ duplicate", dupHash.status === "duplicate" && dupHash.reason === "attachment_sha256", JSON.stringify(dupHash));
    // ملف مختلف + مرجع مختلف + نفس المبلغ/النص ⇒ معاملة جديدة
    const other = extractReceiptFields(DB_TEXT.replace(TEST_REF, TEST_REF.slice(0, -2) + "77"));
    const newTxn = await createWhatsappIntake(client, { provider: TP, provider_message_id: "R3", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/x3/other.pdf",
      attachment_mime: "application/pdf", message_timestamp: "2026-09-12T13:20:00Z" },
      { processAttachment: fakeProc("HASH_BBB", other) });
    ok("ملف ومرجع مختلفان ⇒ معاملة جديدة", newTxn.stored === true && newTxn.status !== "duplicate", JSON.stringify(newTxn));
    // نفس المرجع لكن ملف مختلف ⇒ اشتباه لا رفض
    const sameRef = await createWhatsappIntake(client, { provider: TP, provider_message_id: "R4", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/x4/reissued.pdf",
      attachment_mime: "application/pdf", message_timestamp: "2026-09-12T13:30:00Z" },
      { processAttachment: fakeProc("HASH_CCC") });
    ok("نفس المرجع وملف مختلف ⇒ مخزّن لا مرفوض", sameRef.stored === true, JSON.stringify(sameRef));
    const sameRefRow = await getIntake(client, sameRef.id);
    ok("مُعلَّم اشتباه بسبب المرجع", sameRefRow.duplicate_of === r1.id && /مرجع/.test(sameRefRow.duplicate_reason), JSON.stringify({ d: sameRefRow.duplicate_of, r: sameRefRow.duplicate_reason?.slice(0, 25) }));
    ok("الاشتباه ⇒ needs_review", sameRefRow.status === "needs_review", sameRefRow.status);
    // نفس معرّف الرسالة ⇒ أعلى أولوية
    const dupId = await createWhatsappIntake(client, { provider: TP, provider_message_id: "R1", sender_phone: TRUSTED, original_message: "أي شيء" });
    ok("provider_message_id له الأولوية", dupId.status === "duplicate" && dupId.reason === "provider_message_id");

    console.log("\n— (D) ربط الرسالة الشقيقة —");
    const doc = await createWhatsappIntake(client, { provider: TP, provider_message_id: "S1", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/s1/sib.pdf",
      attachment_mime: "application/pdf", message_timestamp: "2026-09-12T14:00:00Z" },
      { processAttachment: fakeProc("HASH_SIB", extractReceiptFields(DB_TEXT.replace(TEST_REF, TEST_REF.slice(0, -2) + "88"))) });
    const cap = await createWhatsappIntake(client, { provider: TP, provider_message_id: "S2", sender_phone: TRUSTED,
      original_message: "ديزل", message_timestamp: "2026-09-12T14:00:20Z" });
    const capRow = await getIntake(client, cap.id);
    ok("النص رُبط بالمستند الشقيق", capRow.sibling_of === doc.id, JSON.stringify({ s: capRow.sibling_of, doc: doc.id }));
    const links = await client.query("select action from agent_actions where target_id=$1 and action='intake.sibling_linked'", [cap.id]);
    ok("حدث intake.sibling_linked مسجّل", links.rows.length === 1);
    // تعدّد المرشحين ⇒ لا ربط
    const c2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "S3", sender_phone: TRUSTED,
      original_message: "بنزين", message_timestamp: "2026-09-12T15:00:00Z" });
    const c3 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "S4", sender_phone: TRUSTED,
      original_message: "زيت", message_timestamp: "2026-09-12T15:00:10Z" });
    const amb = await createWhatsappIntake(client, { provider: TP, provider_message_id: "S5", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/s5/amb.pdf",
      attachment_mime: "application/pdf", message_timestamp: "2026-09-12T15:00:20Z" },
      { processAttachment: fakeProc("HASH_AMB", extractReceiptFields("no fields here")) });
    const ambRow = await getIntake(client, amb.id);
    ok("تعدّد المرشحين ⇒ لا ربط تلقائي", ambRow.sibling_of === null, String(ambRow.sibling_of));
    const ambLog = await client.query("select action from agent_actions where target_id=$1 and action='intake.sibling_ambiguous'", [amb.id]);
    ok("حدث intake.sibling_ambiguous مسجّل", ambLog.rows.length === 1);

    console.log("\n— السلامة —");
    const fail = await createWhatsappIntake(client, { provider: TP, provider_message_id: "F1", sender_phone: TRUSTED,
      attachment_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/f1/x.pdf", attachment_mime: "application/pdf",
      message_timestamp: "2026-09-12T16:00:00Z" }, { processAttachment: async () => { throw new Error("fetch exploded"); } });
    ok("انفجار المعالجة لا يفقد الرسالة", fail.stored === true || fail.status === "failed", JSON.stringify(fail));
    ok("لا finance_entry", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === base.fin);
  } finally {
    console.log("\n— تنظيف —");
    await client.query("update whatsapp_intake set duplicate_of=null, sibling_of=null where provider=$1", [TP]);
    const testIds = (await client.query("select id from whatsapp_intake where provider=$1", [TP])).rows.map((r) => r.id);
    await client.query("delete from agent_actions where target_id = any($1)", [testIds]);
    const d1 = await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    if (hadAl) await client.query("update app_settings set value=$1::jsonb where key='intake_allowlist'", [JSON.stringify(prevAl.rows[0].value)]);
    else await client.query("delete from app_settings where key='intake_allowlist'");
    const after = await snap();
    console.log(`  حُذف intake=${d1.rowCount} | بعد: ${JSON.stringify(after)}`);
    ok("عودة للـbaseline", after.wi === base.wi && after.fin === base.fin);
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
