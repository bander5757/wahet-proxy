// اختبارات القراءة البصرية للمستندات الممسوحة (staging فقط): التحقق من الحقول، بقاء التصنيف بقواعدنا، والمراجعة البشرية.
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;
const { applyVisionFields, listPendingVision, sanitizeVisionFields } = app.__reprocess;

const TP = "test-vision";
const TRUSTED = "+966500000825";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };

async function main() {
  console.log("— تنقية الحقول القادمة من القراءة البصرية —");
  const good = sanitizeVisionFields({ amount: "1,250.50", transaction_date: "2026-09-20", reference: "9120092600123456",
    from_iban_last4: "4266", to_iban: "SA1478000000001272069804", beneficiary_name: "OMAR ALDAQARI", doc_kind: "transfer_receipt", bank: "Al Rajhi" });
  ok("مبلغ بفواصل يُقبل كرقم", good.amount === 1250.5);
  ok("تاريخ وصيغة مرجع صحيحة تُقبل", good.transaction_date === "2026-09-20" && good.reference === "9120092600123456");
  ok("آيبان واسم مستفيد يُقبلان", good.to_iban === "SA1478000000001272069804" && good.beneficiary_name === "OMAR ALDAQARI");
  const bad = sanitizeVisionFields({ amount: -5, transaction_date: "أمس", reference: "abc", from_iban_last4: "12", to_iban: "SA1", doc_kind: "خطاب", transfer_kind: "hack" });
  ok("قيم غير صالحة تُرفض كلها", Object.keys(bad).length === 0, JSON.stringify(bad));
  ok("مبلغ ضخم غير منطقي يُرفض", !("amount" in sanitizeVisionFields({ amount: 999999999999 })));
  ok("التصنيف لا يُقبل من القراءة البصرية", !("classification" in sanitizeVisionFields({ classification: "expense" })));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const fin0 = (await client.query("select count(*)::int n from finance_entries")).rows[0].n;
  const prevAl = await client.query("select value from app_settings where key='intake_allowlist'");
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb) on conflict (key) do update set value=excluded.value`,
    [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر البصري", active: true }] })]);
  try {
    console.log("\n— مستند ممسوح بلا نص —");
    const scan = await createWhatsappIntake(client, { provider: TP, provider_message_id: "V1", sender_phone: TRUSTED, original_message: "عهده عمر",
      attachment_url: "https://storage.googleapis.com/peach_user_uploads/scan1", attachment_mime: "application/pdf",
      message_timestamp: new Date().toISOString() }, { processAttachment: async () => ({ status: "no_text", sha256: "V_SHA1", bytes: 90000, text_len: 0, text: "", fields: {} }) });
    const before = await getIntake(client, scan.id);
    ok("قبل: بلا مبلغ", before.amount === null);
    const pending = await listPendingVision(client, 50);
    ok("يظهر في قائمة المنتظرة للقراءة البصرية", pending.some((x) => x.id === scan.id));

    const ref = "92" + String(Date.now()).slice(-12);
    const res = await applyVisionFields(client, { id: scan.id, source: "claude-vision",
      fields: { amount: 3500, transaction_date: "2026-09-20", reference: ref, from_iban_last4: "4266", beneficiary_name: "OMAR ALDAQARI", doc_kind: "transfer_receipt" } });
    ok("طُبِّقت الحقول والمبلغ 3500", res.amount === 3500 && res.applied.includes("amount"));
    ok("التصنيف من قواعدنا لا من النموذج (عهدة من التعليق)", res.classification === "custody", res.classification);
    const after = await getIntake(client, scan.id);
    ok("يبقى needs_review دائماً بعد القراءة البصرية", after.status === "needs_review", after.status);
    ok("المرجع محفوظ", after.transaction_reference === ref);
    ok("حدث intake.vision مسجّل", (await client.query("select count(*)::int n from agent_actions where target_id=$1 and action='intake.vision'", [scan.id])).rows[0].n === 1);
    ok("لم يعد في قائمة الانتظار", !(await listPendingVision(client, 50)).some((x) => x.id === scan.id));

    console.log("\n— مستند غير مقروء —");
    const scan2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "V2", sender_phone: TRUSTED, original_message: "",
      attachment_url: "https://storage.googleapis.com/peach_user_uploads/scan2", attachment_mime: "image/jpeg",
      message_timestamp: new Date().toISOString() }, { processAttachment: async () => ({ status: "not_extractable", sha256: "V_SHA2", bytes: 50000, text_len: 0, text: "", fields: {} }) });
    const res2 = await applyVisionFields(client, { id: scan2.id, unreadable: true, fields: {} });
    ok("غير مقروء ⇒ يُعلَّم ولا يُخترع مبلغ", res2.unreadable === true && res2.amount === null);
    ok("لا يعود للانتظار (لا تكرار بلا فائدة)", !(await listPendingVision(client, 50)).some((x) => x.id === scan2.id));

    console.log("\n— الحدود —");
    await client.query("update whatsapp_intake set status='approved' where id=$1", [scan.id]);
    let refused = false;
    try { await applyVisionFields(client, { id: scan.id, fields: { amount: 999 } }); } catch (e) { refused = e.statusCode === 409; }
    ok("سجل معتمد لا يُعدَّل بالقراءة البصرية", refused);
    ok("لا finance_entry جديد", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === fin0);
  } finally {
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
