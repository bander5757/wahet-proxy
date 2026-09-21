// اختبارات قراءة الإيصالات (v2): المبلغ الكامل، المرجع، الآيبان الملتصق، المرسِل/المستفيد، وإعادة المعالجة.
// كل النصوص هنا مصطنعة بأرقام وهمية تحاكي بنية إيصالات الراجحي الحقيقية.
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { extractReceiptFields, matchAccountByIban, attachmentHostAllowed } = app.__p17;
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;
const { reprocessIntake } = app.__reprocess;

const TP = "test-receipt";
const TRUSTED = "+966500000824";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };

// بنية إيصال الراجحي: التسمية تأتي بعد القيمة، والنص ملتصق بالعربية المشوّهة
const RAJHI = (amount, ref, toIban, last4) =>
  `!!"#$ Transfer ReceiptDate 2026/09/18 %&' Ref. ${ref} "/& (Transfer Details)*+&,'(${amount} SARAmount-.)*' ABC ,#DSA** **** **** **** **** ${last4}Al Rajhi BankFrom/'#OMAR ALDAQARI${toIban}To####'(E-&F`;

async function main() {
  console.log("— المبلغ لا يُجزَّأ —");
  ok("2000 تُقرأ كاملة لا 200 ولا 0", extractReceiptFields(RAJHI("2000", "9118092600280344345", "SA1478000000001272069804", "4266")).amount === 2000);
  ok("1500 تُقرأ كاملة", extractReceiptFields(RAJHI("1500", "9117092600936691345", "SA1478000000001272069804", "4266")).amount === 1500);
  ok("مبلغ بفواصل وكسور", extractReceiptFields(RAJHI("12,345.67", "911809260028034", "SA1478000000001272069804", "4266")).amount === 12345.67);
  ok("صفر لا يُعتبر مبلغاً", extractReceiptFields(RAJHI("0", "911809260028034", "SA1478000000001272069804", "4266")).amount === null);

  console.log("\n— المرجع والآيبان والأطراف —");
  const f = extractReceiptFields(RAJHI("2000", "9118092600280344345", "SA1478000000001272069804", "4266"));
  ok("مرجع بصيغة .Ref", f.reference === "9118092600280344345", String(f.reference));
  ok("آيبان المستفيد رغم التصاقه بالاسم", f.to_iban === "SA1478000000001272069804", String(f.to_iban));
  ok("آخر 4 من حساب المرسِل المقنّع", f.from_iban_last4 === "4266", String(f.from_iban_last4));
  ok("اسم المستفيد", f.beneficiary_name === "OMAR ALDAQARI", String(f.beneficiary_name));
  ok("البنك والتاريخ", /rajhi/i.test(f.bank || "") && f.transaction_date === "2026-09-18");
  ok("أرقام الآيبان لا تُقرأ كمرجع", f.reference !== f.to_iban && !String(f.reference).includes("1478000000"));
  const own = extractReceiptFields("Transfer Receipt Date 2026/09/11 Between my accounts 300 SARAmount Al Rajhi Bank");
  ok("تحويل بين الحسابات يُميَّز", own.transfer_kind === "own_accounts" && own.amount === 300);

  console.log("\n— مطابقة الحسابات بالآيبان —");
  const accs = [{ id: "A", name: "حساب المؤسسة الرسمي", iban: "SA1234567890123456784266", iban_last4: null },
                { id: "B", name: "حساب فيصل", iban: null, iban_last4: "9458" },
                { id: "C", name: "حساب ثالث", iban: null, iban_last4: "4266" }];
  ok("مطابقة بالآيبان الكامل", matchAccountByIban(accs, "SA1234567890123456784266", null) === "A");
  ok("مطابقة بآخر 4 عند وجود حساب واحد", matchAccountByIban(accs, null, "9458") === "B");
  ok("آخر 4 مكرّرة بين حسابين ⇒ لا تخمين", matchAccountByIban(accs, null, "4266") === null);
  ok("بلا تطابق ⇒ null", matchAccountByIban(accs, null, "0000") === null);

  console.log("\n— مصادر المرفقات —");
  ok("مضيف Peach الجديد مسموح", attachmentHostAllowed(new URL("https://storage.googleapis.com/peach_user_uploads/x?y=1")));
  ok("دلو آخر مرفوض", !attachmentHostAllowed(new URL("https://storage.googleapis.com/other/x")));
  ok("مضيف غريب مرفوض", !attachmentHostAllowed(new URL("https://evil.example/peach_user_uploads/x")));

  console.log("\n— إعادة المعالجة —");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const fin0 = (await client.query("select count(*)::int n from finance_entries")).rows[0].n;
  const prevAl = await client.query("select value from app_settings where key='intake_allowlist'");
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb) on conflict (key) do update set value=excluded.value`,
    [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر الإيصالات", active: true }] })]);
  try {
    // وصلت بلا استخراج (كما حدث فعلاً عندما مُنع المضيف الجديد)
    const r1 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "RC1", sender_phone: TRUSTED, original_message: "عهده عمر",
      attachment_url: "https://storage.googleapis.com/peach_user_uploads/x1", attachment_mime: "application/pdf",
      message_timestamp: new Date().toISOString() }, { processAttachment: async () => ({ status: "skipped", reason: "host_not_allowed" }) });
    const before = await getIntake(client, r1.id);
    ok("قبل: بلا مبلغ", before.amount === null && before.classification === "custody");
    const ref = "93" + String(Date.now()).slice(-12);
    const after = await reprocessIntake(client, { id: r1.id }, { processAttachment: async () => {
      const text = RAJHI("2000", ref, "SA1478000000001272069804", "4266");
      return { status: "extracted", sha256: "RC_SHA", bytes: 1000, text_len: text.length, text, fields: extractReceiptFields(text) };
    } });
    ok("بعد: المبلغ 2000 والتصنيف عهدة", Number(after.amount) === 2000 && after.classification === "custody", `${after.amount} ${after.classification}`);
    const row = await getIntake(client, r1.id);
    ok("المرجع والبصمة محفوظان", row.transaction_reference === ref && row.attachment_sha256 === "RC_SHA");
    ok("المستفيد وآخر 4 في parsed_data", row.parsed_data?.counterparty === "OMAR ALDAQARI" && row.parsed_data?.from_iban_last4 === "4266", JSON.stringify(row.parsed_data?.counterparty));
    ok("النص الخام حُذف بعد التحليل", !("text" in ((await client.query("select attachment_meta from whatsapp_intake where id=$1", [r1.id])).rows[0].attachment_meta.extraction || {})));
    ok("حدث intake.reprocess مسجّل", (await client.query("select count(*)::int n from agent_actions where target_id=$1 and action='intake.reprocess'", [r1.id])).rows[0].n === 1);
    await client.query("update whatsapp_intake set status='approved' where id=$1", [r1.id]);
    let refused = false;
    try { await reprocessIntake(client, { id: r1.id }); } catch (e) { refused = e.statusCode === 409; }
    ok("سجل معتمد لا يُعاد معالجته", refused);
    ok("لا finance_entry", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === fin0);
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
