// اختبارات المحلل المراقب (staging فقط).
// الاختبارات التي تحتاج جدول intake_analysis تُتخطّى بوضوح ما لم تُطبَّق الهجرة بعد.
const crypto = require("crypto");
const { Pool } = require("pg");
process.env.INTAKE_PARSER = "rule";
const app = require("../api/app");
const { createWhatsappIntake } = app.__m1;
const { getIntake, approveIntake } = app.__m2;
const A = app.__analysis;
const { checkIntakeAuth } = app.__cloudsync;

const TP = "test-analysis";
const TRUSTED = "+966500000826";
let passed = 0, failed = 0, skipped = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
const skip = (n) => { skipped++; console.log(`  ⏭️  ${n} (الهجرة غير مطبّقة)`); };
async function expectErr(n, fn, code) {
  try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode} ${e.message}`); }
}

async function main() {
  console.log("— تنقية ما يرسله المحلل —");
  const clean = A.sanitizeAnalysis({
    analyzer: "eve", analyzer_version: "1.0.0", status: "completed",
    fields: { amount: "1,250.50", transaction_date: "2026-10-20", reference: "9120092600123456", counterparty: "OMAR", nonsense: "x" },
    suggested_classification: "custody", missing_fields: ["site", "payee"],
    questions: ["هل هذه عهدة عمر؟", { key: "site", text: "أي موقع؟" }],
    alerts: ["المجموع لا يطابق"], attachment_kind: "pdf_scan", needs_vision: true,
    items: [{ date: "2026-10-20", description: "ديزل", amount: 580, direction: "out", kind: "expense" },
            { description: "عهدة من أبو فايز", amount: 1000, direction: "in", kind: "funding" }],
    reported_total: 580,
  });
  ok("المبلغ يُقرأ مع الفواصل", clean.fields.amount === 1250.5);
  ok("حقل غير معروف يُهمل", !("nonsense" in clean.fields));
  ok("التصنيف المقترح ضمن القائمة", clean.suggested_classification === "custody");
  ok("تصنيف مخترع يُرفض", A.sanitizeAnalysis({ suggested_classification: "hack" }).suggested_classification === null);
  ok("الأسئلة نصاً أو كائناً", clean.questions.length === 2 && clean.questions[1].key === "site");
  ok("البنود تُحفظ باتجاهها ونوعها", clean.items.length === 2 && clean.items[0].direction === "out" && clean.items[1].kind === "funding");
  ok("الداخل والخارج منفصلان", clean.items_in_total === 1000 && clean.items_spent_total === 580);
  ok("المطابقة تُحتسب في الخادم لا يعلنها المحلل", clean.expenses_match === true && clean.expenses_diff === 0);

  console.log("\n— المطابقة بالهللات بلا تسامح —");
  const half = A.sanitizeAnalysis({ items: [{ description: "x", amount: 580, direction: "out" }], reported_total: 580.5 });
  ok("فرق 0.50 ريال ⇒ لا مطابقة والفرق يُعرض", half.expenses_match === false && half.expenses_diff === -0.5, JSON.stringify(half.expenses_diff));
  const cent = A.sanitizeAnalysis({ items: [{ description: "x", amount: 100.01, direction: "out" }], reported_total: 100 });
  ok("فرق هللة واحدة يُلتقط", cent.expenses_match === false && cent.expenses_diff === 0.01, JSON.stringify(cent.expenses_diff));
  const floaty = A.sanitizeAnalysis({ items: [{ description: "a", amount: 0.1, direction: "out" }, { description: "b", amount: 0.2, direction: "out" }], reported_total: 0.3 });
  ok("0.1+0.2 تساوي 0.3 بالهللات (لا خطأ عوائم)", floaty.expenses_match === true && floaty.expenses_diff === 0);
  ok("بلا إجمالي معلن ⇒ المطابقة غير محسوبة (null لا true)",
    A.sanitizeAnalysis({ items: [{ description: "x", amount: 5, direction: "out" }] }).expenses_match === null);

  console.log("\n— تسوية العهدة —");
  const settled = A.sanitizeAnalysis({ opening_balance: 100, closing_balance: 500,
    items: [{ description: "عهدة", amount: 1000, direction: "in", kind: "funding" },
            { description: "ديزل", amount: 580, direction: "out" },
            { description: "مرتجع", amount: 20, direction: "out", kind: "return" }] });
  ok("افتتاحي + مستلم − مصروف − مُعاد = متبقٍ", settled.settlement_status === "balanced" && settled.expected_closing === 500 && settled.settlement_diff === 0);
  ok("المُعاد منفصل عن المصروف", settled.items_returned_total === 20 && settled.items_spent_total === 580);
  const unbalanced = A.sanitizeAnalysis({ opening_balance: 100, closing_balance: 450,
    items: [{ description: "عهدة", amount: 1000, direction: "in", kind: "funding" }, { description: "ديزل", amount: 580, direction: "out" }] });
  ok("تسوية غير متزنة تُعلَّم بفرقها", unbalanced.settlement_status === "mismatch" && unbalanced.settlement_diff === -70, JSON.stringify(unbalanced.settlement_diff));
  ok("بلا رصيد ختامي ⇒ غير محسوبة",
    A.sanitizeAnalysis({ opening_balance: 100, items: [{ description: "x", amount: 5, direction: "out" }] }).settlement_status === "not_computed");
  ok("بلا بنود ⇒ غير محسوبة",
    A.sanitizeAnalysis({ opening_balance: 100, closing_balance: 100 }).settlement_status === "not_computed");
  ok("الرصيد الافتتاحي صفر مقبول (ليس فارغاً)",
    A.sanitizeAnalysis({ opening_balance: 0, closing_balance: 0, items: [{ description: "x", amount: 5, direction: "in" }, { description: "y", amount: 5, direction: "out" }] }).settlement_status === "balanced");
  ok("بند بلا مبلغ يُسقط", A.sanitizeAnalysis({ items: [{ description: "بلا مبلغ" }] }).items.length === 0);
  ok("سقف البنود 500", A.sanitizeAnalysis({ items: Array.from({ length: 600 }, () => ({ description: "x", amount: 1 })) }).items.length === 500);
  ok("النص الطويل يُقصّ", A.sanitizeAnalysis({ alerts: ["ب".repeat(500)] }).alerts[0].length === 300);
  ok("لا حقل اعتماد/ترحيل يمر", !("status_override" in clean) && !("approved" in clean) && !("finance_entry_id" in clean));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const fin0 = (await client.query("select count(*)::int n from finance_entries")).rows[0].n;
  const prevTok = (await client.query("select value from app_settings where key='sync_tokens'")).rows[0]?.value || null;
  const prevAl = await client.query("select value from app_settings where key='intake_allowlist'");
  const analystTok = "tst_an_" + crypto.randomBytes(8).toString("hex");
  const syncTok = "tst_sy_" + crypto.randomBytes(8).toString("hex");
  const h = (t) => crypto.createHash("sha256").update(t).digest("hex");
  await client.query(`insert into app_settings (key,value) values ('sync_tokens',$1::jsonb)
    on conflict (key) do update set value=excluded.value`, [JSON.stringify({ tokens: [
      ...(prevTok?.tokens || []),
      { hash: h(analystTok), scope: "intake_analyze", label: "test-analyst", active: true },
      { hash: h(syncTok), scope: "intake_sync", label: "test-sync", active: true }] })]);
  await client.query(`insert into app_settings (key,value) values ('intake_allowlist',$1::jsonb)
    on conflict (key) do update set value=excluded.value`, [JSON.stringify({ members: [{ phone: TRUSTED, name: "مختبِر التحليل", active: true }] })]);
  const req = (hdrs) => ({ headers: hdrs });

  try {
    console.log("\n— عزل الصلاحيات —");
    ok("رمز المحلل يُقبل للتحليل", (await A.checkAnalystAuth(client, req({ "x-analyst-token": analystTok }))).ok === true);
    ok("رمز المزامنة لا يصلح للتحليل", (await A.checkAnalystAuth(client, req({ "x-sync-token": syncTok }))).ok === false);
    ok("رمز المحلل لا يصلح لإدخال الرسائل", (await checkIntakeAuth(client, req({ "x-sync-token": analystTok }))).ok === false);
    ok("رمز المحلل لا يُقبل كمفتاح وارد", (await checkIntakeAuth(client, req({ "x-intake-secret": analystTok }))).ok === false);
    ok("رمز المزامنة في ترويسة المحلل مرفوض", (await A.checkAnalystAuth(client, req({ "x-analyst-token": syncTok }))).ok === false);
    ok("رمز المحلل في ترويسة المزامنة مرفوض", (await checkIntakeAuth(client, req({ "x-sync-token": analystTok }))).ok === false);
    ok("رمز مُبطَل لا يعمل للتحليل", await (async () => {
      const dead = "tst_dead_" + crypto.randomBytes(6).toString("hex");
      const cur = (await client.query("select value from app_settings where key='sync_tokens'")).rows[0].value;
      await client.query("update app_settings set value=$1::jsonb where key='sync_tokens'",
        [JSON.stringify({ tokens: [...cur.tokens, { hash: h(dead), scope: "intake_analyze", label: "dead", active: false }] })]);
      return (await A.checkAnalystAuth(client, req({ "x-analyst-token": dead }))).ok === false;
    })());
    await expectErr("قراءة بلا رمز ولا جلسة ⇒ 401", () => A.requireAnalystRead(client, req({}), null), 401);
    await expectErr("مستخدم عادي لا يقرأ قائمة التحليل ⇒ 401", () => A.requireAnalystRead(client, req({}), { role: "viewer" }), 401);
    let readerOk = true; try { await A.requireAnalystRead(client, req({}), { role: "accountant" }); } catch (_) { readerOk = false; }
    ok("المحاسب يقرأ نتائج التحليل", readerOk);
    await expectErr("المحلل لا يملك مسار اعتماد (بلا جلسة) ⇒ 403", () => approveIntake(client, { id: "00000000-0000-0000-0000-000000000000" }, null), 403);

    const ready = await A.analysisTableReady(client);
    console.log(`\n— التخزين (${ready ? "الجدول مطبّق" : "الجدول غير مطبّق"}) —`);
    const rec = await createWhatsappIntake(client, { provider: TP, provider_message_id: "AN1", sender_phone: TRUSTED,
      original_message: "عهده عمر", message_timestamp: new Date().toISOString() });
    const before = await getIntake(client, rec.id);

    if (!ready) {
      await expectErr("القائمة ترفض بوضوح قبل الهجرة ⇒ 503", () => A.analysisQueue(client, { analyzer: "eve", version: "1.0.0" }), 503);
      await expectErr("الحفظ يرفض بوضوح قبل الهجرة ⇒ 503", () => A.saveAnalysis(client, { intake_id: rec.id, analyzer: "eve", analyzer_version: "1.0.0" }), 503);
      ok("القراءة تُرجع فارغاً بلا كسر", (await A.listAnalysis(client, rec.id)).length === 0);
      ok("قائمة الوارد لا تنكسر قبل الهجرة", (await A.latestAnalysisFor(client, [rec.id])) && true);
      ["الطابور يستبعد المحلَّل سابقاً", "الحفظ ينشئ صفاً", "تكرار نفس الإصدار ⇒ 409", "إعادة المحاولة بعد الفشل تُحدّث الصف",
       "parsed_data الأصلي لم يتغير", "حالة السجل لم تتغير"].forEach(skip);
    } else {
      const q1 = await A.analysisQueue(client, { analyzer: "eve", version: "1.0.0", limit: 100 });
      ok("السجل يظهر في الطابور قبل تحليله", q1.some((r) => r.id === rec.id));
      const saved = await A.saveAnalysis(client, { intake_id: rec.id, analyzer: "eve", analyzer_version: "1.0.0",
        suggested_classification: "custody", questions: ["لمن العهدة؟"], items: [{ description: "ديزل", amount: 100, direction: "out" }] }, "analyst:test");
      ok("الحفظ ينشئ صفاً", !!saved.id && saved.attempts === 1 && saved.items_count === 1);
      ok("الطابور يستبعد المحلَّل سابقاً", !(await A.analysisQueue(client, { analyzer: "eve", version: "1.0.0", limit: 100 })).some((r) => r.id === rec.id));
      await expectErr("تكرار نفس الإصدار ⇒ 409", () => A.saveAnalysis(client, { intake_id: rec.id, analyzer: "eve", analyzer_version: "1.0.0" }), 409);
      let otherOk = true; try { await A.saveAnalysis(client, { intake_id: rec.id, analyzer: "eve", analyzer_version: "2.0.0" }); } catch (_) { otherOk = false; }
      ok("إصدار آخر مسموح (تجربة محلل جديد)", otherOk);
      await client.query("update intake_analysis set status='failed', error='x' where intake_id=$1 and analyzer_version='1.0.0'", [rec.id]);
      const retry = await A.saveAnalysis(client, { intake_id: rec.id, analyzer: "eve", analyzer_version: "1.0.0", status: "completed" });
      ok("إعادة المحاولة بعد الفشل تُحدّث الصف نفسه", retry.retried === true && retry.attempts === 2);
      ok("عدد الصفوف لهذا السجل اثنان لا أكثر", (await client.query("select count(*)::int n from intake_analysis where intake_id=$1", [rec.id])).rows[0].n === 2);
      ok("حدث intake.analysis مسجّل", (await client.query("select count(*)::int n from agent_actions where target_id=$1 and action='intake.analysis'", [rec.id])).rows[0].n >= 1);
      ok("أحدث تحليل يظهر لقائمة الوارد", !!(await A.latestAnalysisFor(client, [rec.id]))[rec.id]);

      console.log("\n— الطابور: حقائق لا تخمين، وبلا حقول زائدة —");
      const rec4 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "AN4", sender_phone: TRUSTED,
        original_message: "كشف", attachment_url: "https://storage.googleapis.com/peach_user_uploads/scanX",
        attachment_mime: "application/pdf", message_timestamp: new Date().toISOString() },
        { processAttachment: async () => ({ status: "no_text", sha256: "Q_SHA", bytes: 900, text_len: 0, text: "", fields: {} }) });
      const qrow = (await A.analysisQueue(client, { analyzer: "eve", version: "1.0.0", limit: 100 })).find((r) => r.id === rec4.id);
      ok("حالة الاستخراج تُعرض (لا يُخمَّن المسح من الطول)", qrow && qrow.extraction_status === "no_text" && qrow.extraction_ran === true);
      ok("text_available=false مع has_attachment=true", qrow.text_available === false && qrow.has_attachment === true);
      ok("الطابور لا يكشف رقم الجوال ولا رابط المرفق ولا الحمولة الخام",
        !("sender_phone" in qrow) && !("attachment_url" in qrow) && !("raw_payload" in qrow) && !("attachment_meta" in qrow),
        Object.keys(qrow).join(","));
      const recPlain = await createWhatsappIntake(client, { provider: TP, provider_message_id: "AN4b", sender_phone: TRUSTED,
        original_message: "رسالة نصية بلا مرفق", message_timestamp: new Date().toISOString() });
      const noExtract = (await A.analysisQueue(client, { analyzer: "eve", version: "1.0.0", limit: 100 })).find((r) => r.id === recPlain.id);
      ok("سجل بلا مرفق ⇒ extraction_status=absent و extraction_ran=false",
        noExtract && noExtract.extraction_status === "absent" && noExtract.extraction_ran === false,
        JSON.stringify(noExtract && { s: noExtract.extraction_status, r: noExtract.extraction_ran }));

      console.log("\n— نص المستند عبر واجهة محدودة —");
      const src = await A.analysisSource(client, rec4.id, { processAttachment: async () => ({
        status: "extracted", sha256: "S1", bytes: 1200, contentType: "application/pdf", text_len: 11, text: "نص الإيصال", fields: {} }) });
      ok("النص يصل للمحلل كاملاً لا طوله فقط",
        src.text === "نص الإيصال" && src.text_len === "نص الإيصال".length && src.extraction_status === "extracted",
        JSON.stringify({ len: src.text_len }));
      ok("لا يكشف رابط المرفق الموقّع", !("attachment_url" in src) && !JSON.stringify(src).includes("storage.googleapis.com"));
      ok("يعيد التعليق واسم المرفق للسياق", src.caption === "كشف" && src.has_attachment === true);
      const srcNone = await A.analysisSource(client, recPlain.id);
      ok("سجل بلا مرفق ⇒ no_attachment بلا كسر", srcNone.extraction_status === "no_attachment" && srcNone.text === "");
      ok("النص لا يُخزَّن في قاعدة البيانات بعد القراءة",
        !JSON.stringify((await client.query("select attachment_meta from whatsapp_intake where id=$1", [rec4.id])).rows[0].attachment_meta || {}).includes("نص الإيصال"));

      console.log("\n— سلوك skipped —");
      const rec5 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "AN5", sender_phone: TRUSTED,
        original_message: "يحتاج قارئ", message_timestamp: new Date().toISOString() });
      await A.saveAnalysis(client, { intake_id: rec5.id, analyzer: "eve", analyzer_version: "1.0.0", status: "skipped",
        needs_vision: true, attachment_kind: "pdf_scan" });
      const qDefault = await A.analysisQueue(client, { analyzer: "eve", version: "1.0.0", limit: 100 });
      ok("المتخطّى يخرج من الطابور افتراضياً", !qDefault.some((r) => r.id === rec5.id));
      const qIncl = await A.analysisQueue(client, { analyzer: "eve", version: "1.0.0", limit: 100, includeSkipped: true });
      ok("include_skipped=true يُعيده للطابور", qIncl.some((r) => r.id === rec5.id));
      await expectErr("إعادة تحليله بنفس الإصدار ⇒ 409 (الإصدار الجديد هو الطريق)",
        () => A.saveAnalysis(client, { intake_id: rec5.id, analyzer: "eve", analyzer_version: "1.0.0", status: "completed" }), 409);
      let bumped = true; try { await A.saveAnalysis(client, { intake_id: rec5.id, analyzer: "eve", analyzer_version: "1.1.0", status: "completed" }); } catch (_) { bumped = false; }
      ok("إصدار أعلى (بعد توفير قارئ المرفقات) يُحلّله من جديد", bumped);

      console.log("\n— الاسترجاع الفعلي من القاعدة —");
      const rec2 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "AN2", sender_phone: TRUSTED,
        original_message: "تفريغ عهدة", message_timestamp: new Date().toISOString() });
      await A.saveAnalysis(client, { intake_id: rec2.id, analyzer: "eve", analyzer_version: "1.0.0",
        suggested_classification: "custody", opening_balance: 100, closing_balance: 450, reported_total: 580.5,
        fields: { custody_holder: "عمر" },
        items: [{ description: "عهدة", amount: 1000, direction: "in", kind: "funding" },
                { description: "ديزل", amount: 580, direction: "out", kind: "expense", site: "ساجر" }] });
      const back = (await A.listAnalysis(client, rec2.id))[0];
      ok("الأرقام تعود من القاعدة كما حُسبت", Number(back.items_spent_total) === 580 && Number(back.items_in_total) === 1000);
      ok("فرق المصروفات محفوظ (−0.50)", Number(back.expenses_diff) === -0.5 && back.expenses_match === false);
      ok("التسوية محفوظة بفرقها", back.settlement_status === "mismatch" && Number(back.settlement_diff) === -70);
      ok("البنود وحقولها محفوظة", Array.isArray(back.items) && back.items.length === 2 && back.items[1].site === "ساجر");
      ok("حقل المحلل محفوظ", back.fields?.custody_holder === "عمر");

      console.log("\n— تحليلان متزامنان لنفس الرسالة —");
      const rec3 = await createWhatsappIntake(client, { provider: TP, provider_message_id: "AN3", sender_phone: TRUSTED,
        original_message: "سباق", message_timestamp: new Date().toISOString() });
      const payload = { intake_id: rec3.id, analyzer: "eve", analyzer_version: "9.9.9", suggested_classification: "expense" };
      // اتصالان مستقلان ليكون السباق حقيقياً (اتصال واحد يُسلسل الاستعلامات)
      const [cA, cB] = [await pool.connect(), await pool.connect()];
      const both = await Promise.allSettled([A.saveAnalysis(cA, { ...payload }), A.saveAnalysis(cB, { ...payload })]);
      cA.release(); cB.release();
      const okCount = both.filter((r) => r.status === "fulfilled").length;
      const conflictCount = both.filter((r) => r.status === "rejected" && r.reason?.statusCode === 409).length;
      ok("واحد ينجح والآخر 409 (لا 500 ولا صف مكرر)", okCount === 1 && conflictCount === 1,
        JSON.stringify(both.map((r) => r.status === "fulfilled" ? "ok" : r.reason?.statusCode)));
      ok("صف واحد فقط في القاعدة", (await client.query(
        "select count(*)::int n from intake_analysis where intake_id=$1 and analyzer_version='9.9.9'", [rec3.id])).rows[0].n === 1);
    }

    console.log("\n— لا مساس بالتحليل الأصلي ولا بالمال —");
    const after = await getIntake(client, rec.id);
    ok("parsed_data الأصلي كما هو", JSON.stringify(after.parsed_data) === JSON.stringify(before.parsed_data));
    ok("final_data لم يُكتب", after.final_data === before.final_data);
    ok("حالة السجل لم تتغير", after.status === before.status);
    ok("التصنيف الرسمي لم يتغير", after.classification === before.classification);
    ok("لا finance_entry جديد", (await client.query("select count(*)::int n from finance_entries")).rows[0].n === fin0);
  } finally {
    const ids = (await client.query("select id from whatsapp_intake where provider=$1", [TP])).rows.map((r) => r.id);
    if (await A.analysisTableReady(client)) await client.query("delete from intake_analysis where intake_id = any($1)", [ids]);
    await client.query("delete from agent_actions where target_id = any($1)", [ids]);
    await client.query("delete from whatsapp_intake where provider=$1", [TP]);
    if (prevTok) await client.query("update app_settings set value=$1::jsonb where key='sync_tokens'", [JSON.stringify(prevTok)]);
    else await client.query("delete from app_settings where key='sync_tokens'");
    if (prevAl.rows.length) await client.query("update app_settings set value=$1::jsonb where key='intake_allowlist'", [JSON.stringify(prevAl.rows[0].value)]);
    else await client.query("delete from app_settings where key='intake_allowlist'");
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل${skipped ? `، ${skipped} متخطّى` : ""}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
