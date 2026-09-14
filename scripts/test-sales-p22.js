// اختبارات P2.2 — عدم التكرار، نية التحويل لإنسان، قواعد حسب النوع، صلاحية sales.review. staging فقط.
const crypto = require("crypto");
const { Pool } = require("pg");
const app = require("../api/app");
const eng = require("../lib/sales-engine");
const { handleSalesInbound, getSalesLead, approveSalesReply, handoffSalesLead, requireSalesUser, hasPermission, getUserFromToken } = app.__p21;
const { requireIntakeAdmin } = app.__m26;
const { approveIntake } = app.__m2;

const NOW = new Date("2026-09-14T10:00:00Z");
const PH = { A: "+966500000911", A2: "+966500000912", A3: "+966500000919", B: "+966500000913", C: "+966500000914", D: "+966500000915",
  E: "+966500000916", F: "+966500000917", G: "+966500000918" };
let passed = 0, failed = 0, seq = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectThrow(n, fn, code) { try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode} ${e.message}`); } }
const say = (client, phone, text) => handleSalesInbound(client,
  { provider: "test-p22", provider_message_id: "P22-" + (++seq), sender_phone: phone, sender_name: "عميل تجريبي", text },
  { now: NOW, fetchAttachment: false });
const show = (r) => console.log("   🤖", JSON.stringify(r.suggested_reply));
const EURO_RULE = /10 أو 15 أو 20|وحدات 5 متر|بمضاعفات 5/;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const snap = async () => (await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from finance_entries) fin,(select count(*)::int from sales_leads) sl,(select count(*)::int from app_users) u")).rows[0];
  const base = await snap();
  console.log("baseline:", JSON.stringify(base));
  const mk = async (name, email, role, perms) => (await client.query(
    "insert into app_users (name,email,role,permissions) values ($1,$2,$3,$4) returning id,name,role,permissions", [name, email, role, perms])).rows[0];
  const abuFaiz = await mk("p22 أبو فايز", "p22-af@wkaimah.local", "viewer", ["sales.review"]);
  const plainViewer = await mk("p22 مشاهد", "p22-v@wkaimah.local", "viewer", []);
  const owner = await mk("p22 مالك", "p22-o@wkaimah.local", "owner", []);

  try {
    console.log("\n— (A) نفس السؤال مرتين ⇒ لا تكرار حرفي —");
    await say(client, PH.A, "السلام عليكم أبي بيت شعر");
    const a1 = await say(client, PH.A, "وش المقاسات");
    const a2 = await say(client, PH.A, "وش المقاسات");
    const a3 = await say(client, PH.A, "طيب وش المقاسات اللي عندكم");
    [a1, a2, a3].forEach(show);
    ok("الرد الثاني ≠ الأول", a1.suggested_reply !== a2.suggested_reply);
    ok("الرد الثالث ≠ الثاني", a2.suggested_reply !== a3.suggested_reply);
    ok("إعادة السؤال ⇒ «مثل ما ذكرت لك»", /مثل ما ذكرت لك/.test(a2.suggested_reply));
    ok("تشابه الكلمات بين الردين المتتاليين < 0.8", eng.similarity(a1.suggested_reply, a2.suggested_reply) < 0.8,
      eng.similarity(a1.suggested_reply, a2.suggested_reply).toFixed(2));
    ok("التحية لا تتكرر", !/وعليكم السلام/.test(a1.suggested_reply + a2.suggested_reply));
    const msgs = (await getSalesLead(client, a1.lead_id)).messages.filter((m) => m.direction === "out_suggested");
    ok("سجل المواضيع محفوظ مع كل رد", msgs.every((m) => Array.isArray(m.extracted?.topics)));
    // سؤال لم يُجب ⇒ صياغة مختلفة (ليس مطابقة نصية فقط)
    const q1 = await say(client, PH.A2, "أبي خيمة أوروبية");
    const q2 = await say(client, PH.A2, "طيب");
    [q1, q2].forEach(show);
    ok("سؤال الحجم لم يُجب ⇒ صياغة بديلة", q1.suggested_reply !== q2.suggested_reply && q2.missing_fields[0] === "size");
    const p1 = await say(client, PH.A2, "كم السعر");
    const p2 = await say(client, PH.A2, "طيب كم الأسعار؟");
    [p1, p2].forEach(show);
    ok("سياسة السعر المكررة تُختصر", /مثل ما ذكرت لك/.test(p2.suggested_reply) && !/بخصوص السعر/.test(p2.suggested_reply));
    ok("لا سعر في الردود", [p1, p2].every((r) => eng.guardSalesReply(r.suggested_reply).ok));

    // عميل يرد «تمام» دون معلومة جديدة ⇒ لا رد مكرر حرفياً أبداً، وفي النهاية صمت بدل الإلحاح
    await say(client, PH.A3, "أبي بيت شعر في الرياض 30 شخص");
    const stall = [];
    for (let i = 0; i < 6; i++) stall.push((await say(client, PH.A3, "تمام")).suggested_reply);
    stall.forEach((s) => console.log("   🤖", JSON.stringify(s)));
    const nonNull = stall.filter(Boolean);
    ok("لا رد مقترح يتكرر حرفياً عبر المحادثة", new Set(nonNull).size === nonNull.length, JSON.stringify(nonNull));
    ok("بعد استنفاد الأسئلة: «خذ راحتك» مرة ثم لا رد", nonNull.filter((s) => /خذ راحتك/.test(s)).length === 1 && stall[stall.length - 1] === null);

    console.log("\n— (B) «اكلم ولا ارسل» ⇒ لا تحويل تلقائي —");
    for (const s of ["اكلم ولا ارسل", "أتواصل معكم اتصال ولا أرسل هنا؟", "ابي رقمكم"]) {
      const x = eng.extractSalesFields(s);
      ok(`«${s}» غامض: ليس wants_human`, !x.wants_human && x.contact_question);
    }
    await say(client, PH.B, "أبي بيت شعر في الرياض");
    const b = await say(client, PH.B, "اكلم ولا ارسل");
    show(b);
    ok("الحالة ليست human_handoff", b.status !== "human_handoff", b.status);
    ok("يرد طبيعياً ويوضح الخيار", /تكمل معي هنا/.test(b.suggested_reply || "") && /أبي أحد يتواصل معي/.test(b.suggested_reply || ""));
    ok("ويكمل التأهيل بسؤال", /عدد الضيوف|كم شخص/.test(b.suggested_reply || ""));

    console.log("\n— (C) نية صريحة ⇒ human_handoff —");
    for (const s of ["أبي أكلم موظف", "حولني لأحد", "ممكن أحد يتواصل معي", "أبي أتحدث مع المسؤول", "ابي احد من الفريق يتصل علي"]) {
      ok(`«${s}» ⇒ wants_human`, eng.extractSalesFields(s).wants_human === true);
    }
    ok("«موظفين التركيب كم؟» ليس طلب تحويل", eng.extractSalesFields("كم موظف يركب الخيمة").wants_human === false);
    const c = await say(client, PH.C, "أبي أكلم موظف");
    ok("human_handoff بلا رد آلي", c.status === "human_handoff" && c.suggested_reply === null);

    console.log("\n— (D) بيت شعر ⇒ لا قواعد 10/15/20 —");
    ok("PRODUCT_RULES: بيت شعر بلا sizing", eng.PRODUCT_RULES.bait_shaar.sizing === null && eng.PRODUCT_RULES.european_tent.sizing === "euro");
    ok("deriveSizing(بيت شعر 12×25) ⇒ لا اقتراح", eng.deriveSizing({ request_type: "bait_shaar", requested_dimensions: { width: 12, length: 25 } }).suggested_dimensions === null);
    const d1 = await say(client, PH.D, "أبي بيت شعر 12×25");
    const d2 = await say(client, PH.D, "وش المقاسات");
    const d3 = await say(client, PH.D, "50 شخص طاولات وكراسي");
    [d1, d2, d3].forEach(show);
    const dL = await getSalesLead(client, d1.lead_id);
    ok("المقاس المطلوب محفوظ حرفياً بلا مقترح", dL.requested_dimensions.raw === "12×25" && dL.suggested_dimensions === null);
    ok("لا شرح مقاسات أوروبية في أي رد", ![d1, d2, d3].some((r) => EURO_RULE.test(r.suggested_reply || "")));
    ok("النواقص لا تتضمن event_details الأوروبي", !dL.missing_fields.includes("event_details"));

    console.log("\n— (E) دورات مياه ⇒ العدد بدل المقاس —");
    const e1 = await say(client, PH.E, "أبي دورات مياه متنقلة في الرياض");
    show(e1);
    ok("أول ناقص = quantity", e1.missing_fields[0] === "quantity", JSON.stringify(e1.missing_fields));
    ok("يسأل عن عدد الوحدات لا المساحة", /كم وحدة/.test(e1.suggested_reply) && !/المساحة|مقاس/.test(e1.suggested_reply));
    const e2 = await say(client, PH.E, "6 وحدات VIP من 5 الى 7 نوفمبر");
    show(e2);
    const eL = await getSalesLead(client, e1.lead_id);
    ok("عدد الوحدات 6 + النوع في الملاحظات", eL.units_count === 6 && /VIP/.test(eL.customer_notes || ""));
    ok("مؤهَّل ⇒ ملخص بعدد الوحدات", e2.status === "ready_for_confirmation" && /عدد الوحدات: 6/.test(e2.suggested_reply));
    ok("لا sizing لدورات المياه", eL.suggested_dimensions === null);

    console.log("\n— (F) تجهيز متكامل ⇒ الضيوف ونوع المناسبة والخدمات —");
    const f1 = await say(client, PH.F, "أبي تجهيز فعالية متكامل");
    show(f1);
    ok("أول ناقص = guest_count", f1.missing_fields[0] === "guest_count", JSON.stringify(f1.missing_fields));
    ok("يسأل عن الضيوف لا المقاس", /كم عدد الضيوف/.test(f1.suggested_reply) && !EURO_RULE.test(f1.suggested_reply));
    const f2 = await say(client, PH.F, "200 ضيف حفل تخرج ونحتاج إضاءة وصوتيات وضيافة");
    show(f2);
    const fL = await getSalesLead(client, f1.lead_id);
    ok("الخدمات محفوظة", ["إضاءة", "صوتيات", "ضيافة"].every((s) => (fL.requested_services || []).includes(s)), JSON.stringify(fL.requested_services));
    ok("نوع المناسبة + لا اقتراح مقاس", fL.event_type && fL.suggested_dimensions === null);
    ok("الخدمات ليست إلزامية؛ التالي هو التاريخ", f2.missing_fields[0] === "start_date" && !f2.missing_fields.includes("services"));

    console.log("\n— (G) أبو فايز: sales.review فقط —");
    await say(client, PH.G, "أبي خيمة أوروبية 15×30 بالرياض من 20 إلى 22 أكتوبر");
    const g = await say(client, PH.G, "نعم صحيح");
    ok("طلب جاهز للفريق", g.status === "ready_for_team");
    await expectThrow("viewer بلا صلاحية لا يعتمد ⇒ 403", () => approveSalesReply(client, { id: g.lead_id }, plainViewer), 403);
    await expectThrow("viewer بلا صلاحية لا يسلّم ⇒ 403", () => handoffSalesLead(client, { id: g.lead_id }, plainViewer), 403);
    let readOk = true; try { requireSalesUser(abuFaiz); } catch (_) { readOk = false; }
    ok("أبو فايز يقرأ طلبات العملاء", readOk);
    ok("أبو فايز يفتح التفاصيل", !!(await getSalesLead(client, g.lead_id)).messages.length);
    const ap = await approveSalesReply(client, { id: g.lead_id }, abuFaiz);
    ok("أبو فايز يعتمد الرد (لم يُرسل)", ap.suggested_reply_status === "approved" && ap.sent === false);
    const ho = await handoffSalesLead(client, { id: g.lead_id }, abuFaiz);
    ok("أبو فايز يسلّم للفريق", ho.status === "handed_off");
    const log = await client.query("select actor_name from agent_actions where target_id=$1 and action='sales.handed_off'", [g.lead_id]);
    ok("التسليم مسجّل باسمه في agent_actions", log.rows[0]?.actor_name === abuFaiz.name);
    await expectThrow("لا إدارة قائمة الموثوقين ⇒ 403", async () => requireIntakeAdmin(abuFaiz), 403);
    await expectThrow("لا اعتماد صندوق واتساب المالي ⇒ 403", () => approveIntake(client, { id: "00000000-0000-0000-0000-000000000000" }, abuFaiz), 403);
    ok("الدور لم يتغيّر (viewer) ولا صلاحيات أخرى", abuFaiz.role === "viewer" && !hasPermission(abuFaiz, "admin") && abuFaiz.permissions.length === 1);
    const token = crypto.randomBytes(16).toString("hex");
    await client.query("insert into app_sessions (user_id, token_hash, expires_at) values ($1,$2, now() + interval '1 hour')",
      [abuFaiz.id, crypto.createHash("sha256").update(token).digest("hex")]);
    const viaToken = await getUserFromToken(client, token);
    ok("الجلسة تعيد permissions للواجهة", viaToken && viaToken.permissions.includes("sales.review") && viaToken.role === "viewer");
    await expectThrow("owner بلا permission يبقى مسموحاً (لا انحدار)", async () => { requireSalesUser(owner, true); throw Object.assign(new Error("ok"), { statusCode: 200 }); }, 200);

    console.log("\n— السلامة —");
    ok("لا finance_entry", (await snap()).fin === base.fin);
    ok("لم يلمس whatsapp_intake", (await snap()).wi === base.wi);
  } finally {
    console.log("\n— تنظيف —");
    const phones = Object.values(PH);
    const leads = (await client.query("select id from sales_leads where customer_phone = any($1)", [phones])).rows.map((r) => r.id);
    await client.query("delete from agent_actions where agent_role='sales' and target_id = any($1)", [leads]);
    const dl = await client.query("delete from sales_leads where customer_phone = any($1)", [phones]);
    await client.query("delete from app_users where id = any($1)", [[abuFaiz.id, plainViewer.id, owner.id]]);
    const after = await snap();
    console.log(`  حُذف sales_leads=${dl.rowCount} | بعد: ${JSON.stringify(after)}`);
    ok("عودة للـbaseline", JSON.stringify(after) === JSON.stringify(base));
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message, e.stack); process.exit(1); });
