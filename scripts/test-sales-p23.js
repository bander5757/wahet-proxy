// اختبارات P2.3 — بوابات الإرسال المحكوم. staging فقط. لا نقل فعلي هنا (لا Peach، لا واتساب).
const { Pool } = require("pg");
const app = require("../api/app");
const { handleSalesInbound, getSalesLead, approveSalesReply } = app.__p21;
const { approveAndSendSalesReply, recordSalesSendResult, salesSendBlockers, setSalesSendSettings } = app.__p23;

const PH = { T: "+966500000931", W: "+966500000932", X: "+966500000933", N: "+966500000934" };
const TEAM = "+966541449943";
let passed = 0, failed = 0, seq = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectErr(n, fn, code, blocker) {
  try { await fn(); ok(n, false, "لم يُرمَ خطأ"); }
  catch (e) { ok(n, e.statusCode === code && (!blocker || (e.blockers || []).includes(blocker)), `statusCode=${e.statusCode} ${e.message}`); }
}
const say = (client, phone, text, ts, conv = 777001) => handleSalesInbound(client,
  { provider: "test-p23", provider_message_id: "P23-" + (++seq), sender_phone: phone, text, message_timestamp: ts,
    peach: { contact_id: 1, conversation_id: conv } }, { now: new Date(ts), fetchAttachment: false });

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const snap = async () => (await client.query("select (select count(*)::int from whatsapp_intake) wi,(select count(*)::int from finance_entries) fin,(select count(*)::int from sales_leads) sl,(select count(*)::int from sales_outbound) ob")).rows[0];
  const base = await snap();
  console.log("baseline:", JSON.stringify(base));
  const prevSettings = (await client.query("select value from app_settings where key='sales_send'")).rows[0];
  const mk = async (name, email, role, perms) => (await client.query(
    "insert into app_users (name,email,role,permissions) values ($1,$2,$3,$4) returning id,name,role,permissions", [name, email, role, perms])).rows[0];
  const owner = await mk("p23 مالك", "p23-o@wkaimah.local", "owner", []);
  const abuFaiz = await mk("p23 أبو فايز", "p23-af@wkaimah.local", "viewer", ["sales.review"]);
  const viewer = await mk("p23 مشاهد", "p23-v@wkaimah.local", "viewer", []);
  const now = new Date();

  try {
    await client.query("delete from app_settings where key='sales_send'");
    const t1 = await say(client, PH.T, "السلام عليكم أبي خيمة أوروبية بالرياض", now.toISOString());

    console.log("\n— الاعتماد لا يرسل —");
    await approveSalesReply(client, { id: t1.lead_id }, owner);
    ok("اعتماد الرد لا يُنشئ أي إرسال", (await client.query("select count(*)::int n from sales_outbound where lead_id=$1", [t1.lead_id])).rows[0].n === 0);
    const L1 = await getSalesLead(client, t1.lead_id);
    ok("بصمة النص المعتمد محفوظة", !!L1.reply_approved_sha256 && L1.suggested_reply_status === "approved");

    console.log("\n— مفتاح الإيقاف والقائمة التجريبية —");
    await expectErr("مفتاح الإيقاف مغلق افتراضياً ⇒ 409", () => approveAndSendSalesReply(client, { id: t1.lead_id }, owner), 409, "kill_switch_off");
    await expectErr("تغيير المفتاح لغير المالك ⇒ 403", () => setSalesSendSettings(client, { enabled: true, allowed_phones: [PH.T] }, abuFaiz), 403);
    await setSalesSendSettings(client, { enabled: true, allowed_phones: [] }, owner);
    await expectErr("قائمة اختبار فارغة ⇒ لا إرسال", () => approveAndSendSalesReply(client, { id: t1.lead_id }, owner), 409, "test_allowlist_empty");
    await setSalesSendSettings(client, { enabled: true, allowed_phones: [PH.T] }, owner);
    process.env.SALES_SEND_HARD_OFF = "1";
    await expectErr("إيقاف قسري من البيئة ⇒ 409", () => approveAndSendSalesReply(client, { id: t1.lead_id }, owner), 409, "kill_switch_env");
    delete process.env.SALES_SEND_HARD_OFF;

    console.log("\n— الصلاحيات —");
    await expectErr("viewer بلا sales.review ⇒ 403", () => approveAndSendSalesReply(client, { id: t1.lead_id }, viewer), 403);
    const auth = await approveAndSendSalesReply(client, { id: t1.lead_id }, abuFaiz);
    ok("sales.review ⇒ تفويض بالنص المعتمد", auth.status === "authorized" && auth.text === L1.suggested_reply && auth.conversation_id === "777001");
    await expectErr("تفويض ثانٍ مفتوح ⇒ 409", () => approveAndSendSalesReply(client, { id: t1.lead_id }, owner), 409);

    console.log("\n— تسجيل النتيجة —");
    const bad = await recordSalesSendResult(client, { outbound_id: auth.outbound_id, ok: true, sent_text: auth.text + " (معدّل)", peach_message_id: "PM-1" }, abuFaiz);
    ok("نص مُرسل ≠ المعتمد ⇒ failed", bad.status === "failed" && /لا يطابق/.test(bad.error));
    ok("حالة الرد send_failed", (await getSalesLead(client, t1.lead_id)).suggested_reply_status === "send_failed");
    await expectErr("لا تسجيل مرتين لنفس التفويض", () => recordSalesSendResult(client, { outbound_id: auth.outbound_id, ok: true, sent_text: auth.text }, owner), 409);

    const t2 = await say(client, PH.T, "عندي 200 شخص طاولات وكراسي", new Date(now.getTime() + 60000).toISOString());
    const auth2 = await approveAndSendSalesReply(client, { id: t2.lead_id }, owner, { now: new Date(now.getTime() + 120000) });
    const good = await recordSalesSendResult(client, { outbound_id: auth2.outbound_id, ok: true, sent_text: auth2.text, peach_message_id: "PM-2" }, owner);
    ok("نص مطابق ⇒ sent", good.status === "sent");
    const L2 = await getSalesLead(client, t2.lead_id);
    ok("الرد sent + رسالة out_sent برقم Peach", L2.suggested_reply_status === "sent" && L2.messages.some((m) => m.direction === "out_sent" && m.text === auth2.text));
    const obRow = (await client.query("select * from sales_outbound where id=$1", [auth2.outbound_id])).rows[0];
    ok("سجل الإرسال كامل", obRow.peach_message_id === "PM-2" && obRow.approved_by_name === owner.name && obRow.sent_at && obRow.sent_text === obRow.suggested_text);
    const acts = (await client.query("select action from agent_actions where target_id=$1 order by created_at", [t1.lead_id])).rows.map((r) => r.action);
    ok("audit: authorized + sent + send_failed + refused", ["sales.send_authorized", "sales.sent", "sales.send_failed", "sales.send_refused"].every((a) => acts.includes(a)), acts.join(","));

    console.log("\n— البوابات —");
    const t3 = await say(client, PH.T, "في الرياض", new Date(now.getTime() + 180000).toISOString());
    await approveSalesReply(client, { id: t3.lead_id }, owner);
    await client.query("update sales_leads set suggested_reply = suggested_reply || ' تعديل' where id=$1", [t3.lead_id]);
    await expectErr("تغيّر النص بعد الاعتماد ⇒ مرفوض", () => approveAndSendSalesReply(client, { id: t3.lead_id }, owner), 409, "text_changed_after_approval");
    const priced = "السعر 5000 ريال";
    await client.query("update sales_leads set suggested_reply=$2, reply_approved_sha256=encode(sha256(convert_to($2,'UTF8')),'hex'), suggested_reply_status='approved' where id=$1", [t3.lead_id, priced]);
    await expectErr("الحاجز يُعاد لحظة الإرسال ⇒ مرفوض", () => approveAndSendSalesReply(client, { id: t3.lead_id }, owner), 409, "guardrail:مبلغ بعملة");

    const w = await say(client, PH.W, "أبي بيت شعر", new Date(now.getTime() - 25 * 3600 * 1000).toISOString(), 777002);
    await setSalesSendSettings(client, { enabled: true, allowed_phones: [PH.T, PH.W] }, owner);
    await expectErr("نافذة 24 ساعة مغلقة ⇒ مرفوض", () => approveAndSendSalesReply(client, { id: w.lead_id }, owner), 409, "reply_window_closed");
    const x = await say(client, PH.X, "أبي خيمة", now.toISOString(), 777003);
    await expectErr("رقم خارج قائمة الاختبار ⇒ مرفوض", () => approveAndSendSalesReply(client, { id: x.lead_id }, owner), 409, "phone_not_in_test_allowlist");
    const n = await handleSalesInbound(client, { provider: "test-p23", provider_message_id: "P23-N", sender_phone: PH.N, text: "أبي خيمة",
      message_timestamp: now.toISOString() }, { now, fetchAttachment: false });
    await setSalesSendSettings(client, { enabled: true, allowed_phones: [PH.T, PH.N, TEAM] }, owner);
    await expectErr("لا محادثة Peach ⇒ مرفوض", () => approveAndSendSalesReply(client, { id: n.lead_id }, owner), 409, "no_conversation");
    const teamLead = (await client.query(`insert into sales_leads (customer_phone, status, peach_conversation_id, suggested_reply, suggested_reply_status)
      values ($1,'qualifying','777004','مرحبا','pending') returning id`, [TEAM])).rows[0];
    await client.query("insert into sales_messages (lead_id, provider, direction, text, message_timestamp) values ($1,'test-p23','in','x',now())", [teamLead.id]);
    await expectErr("رقم فريق ⇒ مرفوض حتى لو في القائمة", () => approveAndSendSalesReply(client, { id: teamLead.id }, owner), 409, "team_number");

    console.log("\n— السلامة —");
    ok("لا finance_entry ولا intake", (await snap()).fin === base.fin && (await snap()).wi === base.wi);
  } finally {
    console.log("\n— تنظيف —");
    const phones = [...Object.values(PH), TEAM];
    const leads = (await client.query("select id from sales_leads where customer_phone = any($1) and (customer_phone <> $2 or peach_conversation_id = '777004')", [phones, TEAM])).rows.map((r) => r.id);
    await client.query("delete from agent_actions where agent_role='sales' and (target_id = any($1) or actor_ref = any($2))", [leads, [owner.id, abuFaiz.id]]);
    const dl = await client.query("delete from sales_leads where id = any($1)", [leads]);
    if (prevSettings) await client.query("update app_settings set value=$1::jsonb where key='sales_send'", [JSON.stringify(prevSettings.value)]);
    else await client.query("delete from app_settings where key='sales_send'");
    await client.query("delete from app_users where id = any($1)", [[owner.id, abuFaiz.id, viewer.id]]);
    const after = await snap();
    console.log(`  حُذف sales_leads=${dl.rowCount} | بعد: ${JSON.stringify(after)}`);
    ok("عودة للـbaseline", JSON.stringify(after) === JSON.stringify(base));
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message, e.stack); process.exit(1); });
