// اختبارات P2.1 — وكيل المبيعات (Shadow Mode). staging فقط. لا finance، لا intake، لا إرسال.
const { Pool } = require("pg");
const app = require("../api/app");
const eng = require("../lib/sales-engine");
const { handleSalesInbound, getSalesLead, approveSalesReply, handoffSalesLead, markStaleSalesLeads } = app.__p21;

const NOW = new Date("2026-09-14T10:00:00Z");
const PH = { A: "+966500000901", B: "+966500000902", C: "+966500000903", D: "+966500000904",
  E: "+966500000905", F: "+966500000906", H: "+966500000907", DUP: "+966500000908", R: "+966500000909" };
const TEAM = "+966541449943"; // بندر — في allowlist الحقيقية (قراءة فقط)
let passed = 0, failed = 0, seq = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectThrow(n, fn, code) { try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode}`); } }
const say = (client, phone, text, extra = {}) => handleSalesInbound(client,
  { provider: "test-p21", provider_message_id: "P21-" + (++seq), sender_phone: phone, sender_name: "عميل تجريبي", text, ...extra },
  { now: NOW, fetchAttachment: extra.media_url ? undefined : false, processAttachment: extra.processAttachment });
const noPriceLeak = (r) => !/\d[\d,.]*\s*(ريال|ر\.?\s?س|sar)/i.test(r || "") && !/خصم|متوفر|نضمن|مضمون/.test(r || "");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const snap = async () => (await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from finance_entries) fin,(select count(*)::int from sales_leads) sl")).rows[0];
  const base = await snap();
  console.log("baseline:", JSON.stringify(base));
  const owner = (await client.query("insert into app_users (name,email,role) values ('p21 مالك','p21-own@wkaimah.local','owner') returning id,name,role")).rows[0];
  const viewer = (await client.query("insert into app_users (name,email,role) values ('p21 مشاهد','p21-view@wkaimah.local','viewer') returning id,name,role")).rows[0];

  try {
    console.log("\n— وحدات: المقاسات والحاجز —");
    ok("300 م² ⇒ 15×20 أولاً", eng.suggestFromArea(300)[0].width === 15 && eng.suggestFromArea(300)[0].length === 20, JSON.stringify(eng.suggestFromArea(300)));
    ok("300 م² ⇒ 10×30 ضمن الخيارات", eng.suggestFromArea(300).some((d) => d.width === 10 && d.length === 30));
    ok("12×25 ⇒ الأقرب 10×25 و15×25", JSON.stringify(eng.nearestStandardDims({ width: 12, length: 25 }).map((d) => d.width + "x" + d.length)) === '["10x25","15x25"]');
    ok("15×30 قياسي", eng.isStandardDims({ width: 15, length: 30 }) && !eng.isStandardDims({ width: 12, length: 25 }));
    ok("حاجز: مبلغ بعملة يُحجب", !eng.guardSalesReply("السعر 5000 ريال").ok);
    ok("حاجز: خصم يُحجب", !eng.guardSalesReply("عندنا خصم لك").ok);
    ok("حاجز: وعد بالتوفّر يُحجب", !eng.guardSalesReply("الخيمة متوفر في تاريخك").ok);
    ok("حاجز: جملة السعر المسموحة تمر", eng.guardSalesReply("بخصوص السعر: الفريق يجهّز لك عرض السعر بعد ما تكتمل التفاصيل.").ok);

    console.log("\n— التوجيه: الفريق ≠ عميل —");
    const team = await say(client, TEAM, "أبي خيمة في الرياض");
    ok("رقم الفريق ⇒ internal بلا طلب مبيعات", team.routed === "internal" && team.stored === false);
    ok("لا sales_lead لرقم الفريق", (await client.query("select count(*)::int n from sales_leads where customer_phone=$1", [TEAM])).rows[0].n === 0);

    console.log("\n— (A) «أبي خيمة في الرياض» ⇒ يسأل الناقص فقط —");
    const a = await say(client, PH.A, "أبي خيمة في الرياض");
    console.log("   رد مقترح:", JSON.stringify(a.suggested_reply));
    ok("المدينة ليست ضمن النواقص", !a.missing_fields.includes("city"), JSON.stringify(a.missing_fields));
    ok("النواقص: النوع + الحجم + التاريخ", ["tent_kind", "size", "start_date", "end_date"].every((f) => a.missing_fields.includes(f)));
    ok("سؤال واحد: نوع الخيمة", /أوروبية ولا بيت شعر/.test(a.suggested_reply) && !/مدينة/.test(a.suggested_reply));
    ok("Shadow: الرد pending لا مُرسل", a.reply_status === "pending");

    console.log("\n— (B) كل شيء في رسالة واحدة ⇒ لا يعيد السؤال —");
    const b = await say(client, PH.B, "أبي خيمة أوروبية 15×30 بالرياض من 20 إلى 22 أكتوبر");
    console.log("   رد مقترح:", JSON.stringify(b.suggested_reply));
    ok("مؤهَّل ⇒ ready_for_confirmation", b.status === "ready_for_confirmation", b.status + " " + JSON.stringify(b.missing_fields));
    ok("لا يسأل عن المقاس/المدينة/التاريخ", !/كم المساحة|أي مدينة|متى موعد/.test(b.suggested_reply));
    ok("ملخص تأكيد للعميل", /هل المعلومات صحيحة/.test(b.suggested_reply) && /15×30/.test(b.suggested_reply));
    const bLead = await getSalesLead(client, b.lead_id);
    ok("التواريخ 2026-10-20 → 2026-10-22", String(bLead.start_date).includes("2026-10") && bLead.requested_dimensions.raw === "15×30",
      `${bLead.start_date} ${bLead.end_date}`);
    const b2 = await say(client, PH.B, "نعم صحيح");
    ok("تأكيد ⇒ ready_for_team", b2.status === "ready_for_team");
    const bLead2 = await getSalesLead(client, b.lead_id);
    console.log("   ملخص الفريق:\n" + bLead2.team_summary.split("\n").map((l) => "     " + l).join("\n"));
    ok("ملخص الفريق يُحفظ ويُختم بدفترة", /طلب عميل جديد/.test(bLead2.team_summary) && /جاهز للتسعير عبر دفترة/.test(bLead2.team_summary));
    ok("ملخص الفريق بلا أي سعر", noPriceLeak(bLead2.team_summary));
    await expectThrow("viewer لا يعتمد الرد ⇒ 403", () => approveSalesReply(client, { id: b.lead_id }, viewer), 403);
    const ap = await approveSalesReply(client, { id: b.lead_id }, owner);
    ok("owner يعتمد الرد ⇒ approved ولم يُرسل", ap.suggested_reply_status === "approved" && ap.sent === false);
    const ho = await handoffSalesLead(client, { id: b.lead_id }, owner);
    ok("استلام الفريق ⇒ handed_off", ho.status === "handed_off");

    console.log("\n— (C) 300 شخص ولا يعرف المقاس ⇒ اقتراح مبدئي فقط —");
    await say(client, PH.C, "أبي خيمة أوروبية لزواج");
    const c2 = await say(client, PH.C, "عندي 300 شخص وما أعرف المقاس");
    console.log("   رد مقترح:", JSON.stringify(c2.suggested_reply));
    ok("يشرح المقاسات ويسأل عن الجلسات", /10 أو 15 أو 20/.test(c2.suggested_reply) && /طاولات وكراسي ولا مجالس/.test(c2.suggested_reply));
    const cL2 = await getSalesLead(client, c2.lead_id);
    ok("لا مقاس نهائي بعد", cL2.suggested_dimensions === null && cL2.requested_dimensions === null);
    const c3 = await say(client, PH.C, "طاولات وكراسي");
    console.log("   رد مقترح:", JSON.stringify(c3.suggested_reply));
    const cL3 = await getSalesLead(client, c3.lead_id);
    ok("اقتراح مبدئي من الضيوف", cL3.dimensions_confidence === "derived_from_guests" && (cL3.suggested_dimensions || []).length > 0, JSON.stringify(cL3.suggested_dimensions));
    ok("الرد يقول «مبدئياً» والاعتماد للفريق", /مبدئياً/.test(c3.suggested_reply) && /الاعتماد النهائي للفريق/.test(c3.suggested_reply));
    ok("requested_dimensions لم يُملأ من الاقتراح", cL3.requested_dimensions === null);

    console.log("\n— (D) 12×25 غير قياسي ⇒ يشرح ويقترح بلا رفض —");
    const d = await say(client, PH.D, "أبي خيمة أوروبية 12×25");
    console.log("   رد مقترح:", JSON.stringify(d.suggested_reply));
    const dL = await getSalesLead(client, d.lead_id);
    ok("يحفظ طلب العميل حرفياً 12×25", dL.requested_dimensions.raw === "12×25" && dL.requested_dimensions.width === 12);
    ok("المقترح منفصل: 10×25 أو 15×25", dL.dimensions_confidence === "nonstandard" && dL.suggested_dimensions.map((x) => x.width).join(",") === "10,15");
    ok("يشرح العروض ولا يرفض", /10 أو 15 أو 20/.test(d.suggested_reply) && /10×25/.test(d.suggested_reply) && !/غير ممكن|ما نقدر/.test(d.suggested_reply));

    console.log("\n— (E) مرفق ⇒ يُحفظ ويرتبط بالطلب —");
    await say(client, PH.E, "أبي خيمة أوروبية");
    const e = await say(client, PH.E, "", { content_type: "document", media_url: "https://app.trypeach.ai/rails/active_storage/blobs/redirect/p21/kurrasa.pdf",
      attachment_name: "كراسة-الطلب.pdf", attachment_mime: "application/pdf",
      processAttachment: async () => ({ status: "extracted", sha256: "P21SHA", bytes: 5000, text_len: 120 }) });
    const eMsgs = await client.query("select media_url, media_meta, content_type from sales_messages where lead_id=$1 and media_url is not null", [e.lead_id]);
    ok("المرفق محفوظ ومرتبط بالطلب", eMsgs.rows.length === 1 && eMsgs.rows[0].media_meta.sha256 === "P21SHA" && eMsgs.rows[0].content_type === "document");
    ok("لم يلمس whatsapp_intake", (await snap()).wi === base.wi);
    const loc = await say(client, PH.E, "", { content_type: "location", location: { lat: 24.7136, lng: 46.6753, name: "حي الملقا" } });
    const eL = await getSalesLead(client, loc.lead_id);
    ok("Location ⇒ إحداثيات + الموقع", Number(eL.location_lat) === 24.7136 && eL.location_details === "حي الملقا");

    console.log("\n— (F) «كم السعر؟» ⇒ لا سعر ويكمل —");
    const f = await say(client, PH.F, "السلام عليكم كم السعر؟ أبي بيت شعر في جدة");
    console.log("   رد مقترح:", JSON.stringify(f.suggested_reply));
    ok("يرد بسياسة السعر ويكمل السؤال", /الفريق يجهّز لك عرض السعر/.test(f.suggested_reply) && /عدد الضيوف|المساحة/.test(f.suggested_reply));
    ok("لا رقم سعر ولا خصم ولا وعد", noPriceLeak(f.suggested_reply));
    ok("فهم النوع والمدينة", !f.missing_fields.includes("request_type") && !f.missing_fields.includes("city"));

    console.log("\n— تكرار، تحويل لإنسان، ركود —");
    const dupMsg = { provider: "test-p21", provider_message_id: "P21-DUP-1", sender_phone: PH.DUP, text: "أبي خيمة" };
    await handleSalesInbound(client, dupMsg, { now: NOW, fetchAttachment: false });
    const dup2 = await handleSalesInbound(client, dupMsg, { now: NOW, fetchAttachment: false });
    ok("نفس provider_message_id ⇒ duplicate", dup2.duplicate === true && dup2.stored === false);
    const h = await say(client, PH.H, "أبي أكلم موظف من الفريق");
    ok("طلب إنسان ⇒ human_handoff بلا رد آلي", h.status === "human_handoff" && h.suggested_reply === null);
    const stale = await markStaleSalesLeads(client, new Date(NOW.getTime() + 8 * 864e5));
    const aAfter = await getSalesLead(client, a.lead_id);
    ok("لا رد 7 أيام ⇒ stale", stale >= 1 && aAfter.status === "stale", `stale=${stale} A=${aAfter.status}`);

    console.log("\n— (R) انحدارات من محادثة عميل حقيقية —");
    ok("«مخيم» ليس خيمة", eng.extractSalesFields("ابي ل مخيم صغير").request_type === undefined);
    await say(client, PH.R, "بيوت شعر كامل مفروش ومجهز");
    const r2 = await say(client, PH.R, "المكان في الرياض حي لبن بدون كراسي ارضي ابي ل مخيم صغير");
    const rL = await getSalesLead(client, r2.lead_id);
    ok("النوع المحدد لا يُستبدل بعام (يبقى بيت شعر)", rL.request_type === "bait_shaar", rL.request_type);
    ok("لا يعيد سؤال نوع الخيمة", !r2.missing_fields.includes("tent_kind") && !/أوروبية ولا بيت شعر/.test(r2.suggested_reply || ""));
    ok("«بدون كراسي ارضي» ⇒ مجالس", rL.seating_style === "majlis");
    const r3 = await say(client, PH.R, "العدد مو كثير تقريبا ٢٠ الي ٢٥");
    const rL3 = await getSalesLead(client, r3.lead_id);
    ok("لا مقاسات أوروبية لبيوت الشعر", rL3.suggested_dimensions === null && !/10×5/.test(r3.suggested_reply || ""), JSON.stringify(rL3.suggested_dimensions));
    ok("العدد التقريبي بلا «شخص» يُلتقط", rL3.guest_count === 25);
    const r4 = await say(client, PH.R, "ابيها نهاية شهر ١٠ بالشهر");
    const r5 = await say(client, PH.R, "تمام");
    ok("الاقتراح لا يتكرر في كل رد", !/مبدئياً يناسبك/.test(r5.suggested_reply || ""), JSON.stringify(r5.suggested_reply));
    ok("موعد تقريبي ⇒ يسأل عن التاريخ بالضبط", /بالضبط/.test(r4.suggested_reply || ""), JSON.stringify(r4.suggested_reply));
    // P2.2: سؤال عن طريقة التواصل ليس طلب موظف — يُرد عليه طبيعياً
    const r6 = await say(client, PH.R, "اكلم ولا ارسل");
    ok("«اكلم ولا ارسل» ⇒ رد طبيعي لا human_handoff", r6.status !== "human_handoff" && /تكمل معي هنا/.test(r6.suggested_reply || ""), JSON.stringify(r6.suggested_reply));

    console.log("\n— السلامة —");
    ok("لا finance_entry", (await snap()).fin === base.fin);
  } finally {
    console.log("\n— تنظيف —");
    const phones = Object.values(PH);
    const leads = (await client.query("select id from sales_leads where customer_phone = any($1)", [phones])).rows.map((r) => r.id);
    await client.query("delete from agent_actions where agent_role='sales' and target_id = any($1)", [leads]);
    const dl = await client.query("delete from sales_leads where customer_phone = any($1)", [phones]);
    await client.query("delete from app_users where id = any($1)", [[owner.id, viewer.id]]);
    const after = await snap();
    console.log(`  حُذف sales_leads=${dl.rowCount} | بعد: ${JSON.stringify(after)}`);
    ok("عودة للـbaseline", JSON.stringify(after) === JSON.stringify(base));
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message, e.stack); process.exit(1); });
