// اختبارات P1.5 — استخراج المبلغ الآمن، المرفقات، dedup متدرّج، operational_update. staging فقط.
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake } = app.__m2;
const { extractIntakeAmount, ruleClassify, ruleIntakeParser } = app.__m25;

const TP = "test-p15";
const TRUSTED = "+966500000811";
let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectThrow(n, fn, code) { try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode}`); } }
const boom = { name: "boom", async classify() { throw new Error("parser down"); } };

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const snap = async () => (await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from agent_actions) aa,(select count(*)::int from finance_entries) fin")).rows[0];
  const base = await snap();
  console.log("baseline:", JSON.stringify(base));
  const prevAl = await client.query("select value from app_settings where key='intake_allowlist'");
  const hadAl = prevAl.rows.length > 0;
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb)
    on conflict (key) do update set value=excluded.value`,
    [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر P15", active: true }] })]);

  try {
    console.log("\n— (1) استخراج المبلغ: سياق مالي فقط —");
    ok("جوّال 0555189147 ليس مبلغاً", extractIntakeAmount("وسيلة تواصل: 0555189147") === null, String(extractIntakeAmount("وسيلة تواصل: 0555189147")));
    ok("جوّال بصيغة 05 داخل نص", extractIntakeAmount("كلمني على 0506834579 اليوم") === null);
    ok("IBAN ليس مبلغاً", extractIntakeAmount("الآيبان SA0380000000608010167519") === null);
    ok("رقم مرجع طويل ليس مبلغاً", extractIntakeAmount("رقم العملية 987654321012") === null);
    ok("رقم هوية ليس مبلغاً", extractIntakeAmount("الهوية 1012345678") === null);
    ok("رقم فاتورة بلا سياق مالي ليس مبلغاً", extractIntakeAmount("رقم الفاتورة 12345") === null);
    ok("450 ريال ⇒ 450", extractIntakeAmount("دفعت 450 ريال ديزل") === 450);
    ok("1,200.50 ر.س ⇒ 1200.5", extractIntakeAmount("تحويل 1,200.50 ر.س") === 1200.5);
    ok("SAR 300 ⇒ 300", extractIntakeAmount("SAR 300 fuel") === 300);
    ok("مبلغ 3000 ⇒ 3000", extractIntakeAmount("حولت مبلغ 3000 لعمر") === 3000);
    ok("استلمنا 3000 ريال ⇒ 3000", extractIntakeAmount("استلمنا 3000 ريال من العميل") === 3000);
    ok("قيمة الإجمالي 750 ⇒ 750", extractIntakeAmount("قيمة الإجمالي 750") === 750);

    console.log("\n— (2) operational_update —");
    ok("«انتهى التركيب» ⇒ operational_update", ruleClassify("انتهى التركيب في الموقع").classification === "operational_update");
    ok("«نحتاج عمال» ⇒ operational_update", ruleClassify("نحتاج عمال بكرة الصبح").classification === "operational_update");
    ok("تقرير فرص ⇒ operational_update", ruleClassify("تقرير فرص واحة الخيمة اليوم").classification === "operational_update");
    ok("المالي أولوية على التشغيلي", ruleClassify("دفعت 450 ريال ديزل بعد ما انتهى التركيب").classification === "expense");
    const opRes = await createWhatsappIntake(client, { provider: TP, provider_message_id: "OP1", sender_phone: TRUSTED,
      original_message: "انتهى التركيب في موقع المهرجان", message_timestamp: "2026-09-12T08:00:00Z" });
    const opRow = await getIntake(client, opRes.id);
    ok("تشغيلي ⇒ parsed بلا مطالبة بمبلغ", opRow.status === "parsed" && !opRow.missing_fields.includes("amount"), `${opRow.status} ${JSON.stringify(opRow.missing_fields)}`);

    console.log("\n— (3) رسالة بمرفق فقط (بلا نص) —");
    const att = await createWhatsappIntake(client, { provider: TP, provider_message_id: "ATT1", sender_phone: TRUSTED,
      attachment_url: "https://example.invalid/blob/aaa/Transaction-Receipt.pdf", attachment_name: "Transaction-Receipt.pdf",
      attachment_mime: "application/pdf", attachment_meta: { provider_media: "peach-blob-aaa" }, message_timestamp: "2026-09-12T09:00:00Z" });
    ok("مرفق فقط ⇒ مقبول ومخزّن", att.stored === true, JSON.stringify(att));
    const attRow = (await client.query("select attachment_url, attachment_name, attachment_mime, attachment_meta, original_message from whatsapp_intake where id=$1", [att.id])).rows[0];
    ok("أعمدة المرفق محفوظة", attRow.attachment_name === "Transaction-Receipt.pdf" && attRow.attachment_mime === "application/pdf" && attRow.attachment_meta?.provider_media === "peach-blob-aaa");
    await expectThrow("بلا نص وبلا مرفق ⇒ 400", () => createWhatsappIntake(client, { provider: TP, provider_message_id: "X0", sender_phone: TRUSTED }), 400);

    console.log("\n— (4) dedup متدرّج —");
    // (أ) نفس المبلغ/النص لكن إيصالان مختلفان ⇒ صفّان + اشتباه
    const a1 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "A1", sender_phone: TRUSTED,
      original_message: "ديزل", attachment_url: "https://example.invalid/blob/r1/receipt1.pdf", message_timestamp: "2026-09-12T10:00:00Z" });
    const a2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "A2", sender_phone: TRUSTED,
      original_message: "ديزل", attachment_url: "https://example.invalid/blob/r2/receipt2.pdf", message_timestamp: "2026-09-12T10:30:00Z" });
    ok("(أ) الإيصال الثاني مُخزَّن (لا رفض)", a2.stored === true && a2.id !== a1.id, JSON.stringify(a2));
    const a2row = await getIntake(client, a2.id);
    ok("(أ) مُعلَّم possible duplicate مع سبب", a2row.duplicate_of === a1.id && /مشابه/.test(a2row.duplicate_reason), JSON.stringify({ d: a2row.duplicate_of, r: a2row.duplicate_reason?.slice(0, 30) }));
    ok("(أ) الاشتباه يفرض needs_review", a2row.status === "needs_review", a2row.status);
    ok("(أ) صفّان موجودان فعلاً", (await client.query("select count(*)::int n from whatsapp_intake where provider=$1 and original_message='ديزل'", [TP])).rows[0].n === 2);
    // (ب) نفس الإيصال نفسه يُعاد ⇒ duplicate
    const b = await createWhatsappIntake(client, { provider: TP, provider_message_id: "B1", sender_phone: TRUSTED,
      original_message: "ديزل", attachment_url: "https://example.invalid/blob/r1/receipt1.pdf", message_timestamp: "2026-09-12T11:00:00Z" });
    ok("(ب) نفس المرفق ⇒ duplicate بلا صف", b.status === "duplicate" && b.reason === "attachment" && b.stored === false, JSON.stringify(b));
    // (ج) نفس النص بلا مرفق ولا مرجع ⇒ اشتباه فقط
    const c1 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "C1", sender_phone: TRUSTED, original_message: "عهدة 1000 ريال لعمر", message_timestamp: "2026-09-12T12:00:00Z" });
    const c2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "C2", sender_phone: TRUSTED, original_message: "عهدة 1000 ريال لعمر", message_timestamp: "2026-09-12T12:05:00Z" });
    ok("(ج) الثانية مُخزَّنة ومُعلَّمة لا مرفوضة", c2.stored === true && (await getIntake(client, c2.id)).duplicate_of === c1.id, JSON.stringify(c2));
    // نفس معرّف الرسالة ⇒ duplicate مؤكد
    const dupId = await createWhatsappIntake(client, { provider: TP, provider_message_id: "C1", sender_phone: TRUSTED, original_message: "أي نص" });
    ok("نفس provider_message_id ⇒ duplicate مؤكد", dupId.status === "duplicate" && dupId.reason === "provider_message_id");

    console.log("\n— (5) فشل parser مع مرفق لا يفقد الرسالة —");
    const f = await createWhatsappIntake(client, { provider: TP, provider_message_id: "F1", sender_phone: TRUSTED,
      attachment_url: "https://example.invalid/blob/f1/x.pdf", attachment_name: "x.pdf" }, { parser: boom });
    ok("محفوظة + failed + خطأ", f.stored === true && f.status === "failed" && /parser down/.test(f.parse?.error || ""), JSON.stringify(f));

    console.log("\n— (6) لا finance_entry —");
    ok("finance_entries لم يتغيّر", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === base.fin);
  } finally {
    console.log("\n— تنظيف —");
    await client.query("update whatsapp_intake set duplicate_of=null where provider=$1", [TP]);
    const testIds = (await client.query("select id from whatsapp_intake where provider=$1", [TP])).rows.map((r) => r.id);
    const d2 = await client.query("delete from agent_actions where target_id = any($1)", [testIds]);
    const d1 = await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    if (hadAl) await client.query("update app_settings set value=$1::jsonb where key='intake_allowlist'", [JSON.stringify(prevAl.rows[0].value)]);
    else await client.query("delete from app_settings where key='intake_allowlist'");
    console.log(`  حُذف: intake=${d1.rowCount} actions=${d2.rowCount}`);
    const after = await snap();
    console.log("  بعد التنظيف:", JSON.stringify(after));
    ok("عودة للـbaseline", after.wi === base.wi && after.fin === base.fin);
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
