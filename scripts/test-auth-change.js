// اختبارات تغيير المستخدم لكلمة مروره بنفسه (staging فقط). كلمات المرور هنا مؤقتة ومولّدة، ولا تُطبع.
const crypto = require("crypto");
const { Pool } = require("pg");
const app = require("../api/app");
const A = app.__auth;

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectErr(n, fn, code, re) {
  try { await fn(); ok(n, false, "لم يُرمَ خطأ"); }
  catch (e) { ok(n, e.statusCode === code && (!re || re.test(e.message)), `statusCode=${e.statusCode} ${e.message}`); }
}
const pw = () => "Tst@" + crypto.randomInt(1000, 9999) + "pass";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const first = pw(), second = pw();
  const u = (await client.query(
    `insert into app_users (name,email,phone,role,permissions,login_code_hash,must_change_password)
     values ('pwtest','pwtest@wkaimah.local','+966500000944','viewer',$1,$2,true) returning id,name,role,phone`,
    [["sales.review"], A.hashLoginCode(first)])).rows[0];
  const other = (await client.query("insert into app_users (name,email,role,login_code_hash) values ('pwtest2','pwtest2@wkaimah.local','viewer',$1) returning id", [A.hashLoginCode(first)])).rows[0];
  try {
    console.log("— الدخول بكلمة مؤقتة —");
    const s1 = await A.login(client, { identifier: "pwtest", code: first, remember: true });
    ok("الدخول ينجح ويطلب التغيير", !!s1.token && s1.user.must_change_password === true);
    const s2 = await A.login(client, { identifier: "pwtest", code: first, remember: false });   // جلسة ثانية (جهاز آخر)
    ok("جلستان فعّالتان قبل التغيير", !!(await A.getUserFromToken(client, s1.token)) && !!(await A.getUserFromToken(client, s2.token)));

    console.log("— التحقق قبل التغيير —");
    const me = await A.getUserFromToken(client, s1.token);
    await expectErr("كلمة حالية خاطئة ⇒ 401", () => A.changeOwnPassword(client, { current_password: first + "x", new_password: second, confirm_password: second }, me, s1.token), 401, /الحالية/);
    await expectErr("تأكيد غير مطابق ⇒ 400", () => A.changeOwnPassword(client, { current_password: first, new_password: second, confirm_password: second + "z" }, me, s1.token), 400, /تأكيد/);
    await expectErr("قصيرة ⇒ 400", () => A.changeOwnPassword(client, { current_password: first, new_password: "Ab1", confirm_password: "Ab1" }, me, s1.token), 400, /خانات/);
    await expectErr("بلا أرقام ⇒ 400", () => A.changeOwnPassword(client, { current_password: first, new_password: "بدون ارقام هنا", confirm_password: "بدون ارقام هنا" }, me, s1.token), 400, /حروفاً وأرقاماً/);
    await expectErr("شائعة ⇒ 400", () => A.changeOwnPassword(client, { current_password: first, new_password: "password2026", confirm_password: "password2026" }, me, s1.token), 400, /ضعيفة/);
    await expectErr("رقم الجوال ⇒ 400", () => A.changeOwnPassword(client, { current_password: first, new_password: "Aa500000944", confirm_password: "Aa500000944" }, me, s1.token), 400, /جوالك/);
    await expectErr("نفس الحالية ⇒ 400", () => A.changeOwnPassword(client, { current_password: first, new_password: first, confirm_password: first }, me, s1.token), 400, /مطابقة/);
    await expectErr("بلا تسجيل دخول ⇒ 401", () => A.changeOwnPassword(client, { current_password: first, new_password: second, confirm_password: second }, null, null), 401);

    console.log("— التغيير —");
    const r = await A.changeOwnPassword(client, { current_password: first, new_password: second, confirm_password: second }, me, s1.token);
    ok("نجح وألغى الجلسات الأخرى فقط", r.ok === true && r.other_sessions_revoked === 1);
    ok("الجلسة الحالية باقية (تذكرني مستمر)", !!(await A.getUserFromToken(client, s1.token)));
    ok("الجلسة الأخرى أُلغيت", (await A.getUserFromToken(client, s2.token)) === null);
    await expectErr("القديمة تفشل ⇒ 401", () => A.login(client, { identifier: "pwtest", code: first }), 401);
    const s3 = await A.login(client, { identifier: "pwtest", code: second, remember: true });
    ok("الجديدة تنجح ولا تطلب تغييراً", !!s3.token && s3.user.must_change_password === false);
    ok("الدور والصلاحيات لم تتغير", s3.user.role === "viewer" && (s3.user.permissions || []).includes("sales.review"));
    const stored = (await client.query("select login_code_hash, must_change_password from app_users where id=$1", [u.id])).rows[0];
    ok("التجزئة scrypt والعلم أُزيل", stored.login_code_hash.startsWith("scrypt$") && stored.must_change_password === false);
    ok("لا كلمة مرور في السجل", (await client.query(
      "select count(*)::int n from agent_actions where target_id=$1 and (summary like $2 or coalesce(after_state::text,'') like $2 or coalesce(before_state::text,'') like $2)",
      [u.id, `%${second}%`])).rows[0].n === 0);
    ok("العملية مسجّلة في audit", (await client.query("select count(*)::int n from agent_actions where target_id=$1 and action='auth.password_changed'", [u.id])).rows[0].n === 1);

    console.log("— لا أحد يغيّر لغيره —");
    const otherUser = { id: other.id, name: "pwtest2", role: "viewer", permissions: [] };
    await expectErr("كلمة مستخدم آخر لا تُقبل كـ«حالية»", () => A.changeOwnPassword(client, { current_password: second, new_password: pw(), confirm_password: "x" }, otherUser, null), 400, /تأكيد/);
    const before = (await client.query("select login_code_hash from app_users where id=$1", [u.id])).rows[0].login_code_hash;
    const attempt = pw();
    await expectErr("محاولة بكلمة خاطئة على حساب آخر ⇒ 401", () => A.changeOwnPassword(client, { current_password: "whatever1", new_password: attempt, confirm_password: attempt }, otherUser, null), 401);
    ok("حساب pwtest لم يتأثر", (await client.query("select login_code_hash from app_users where id=$1", [u.id])).rows[0].login_code_hash === before);
  } finally {
    await client.query("delete from agent_actions where target_id = any($1)", [[u.id, other.id]]);
    await client.query("delete from app_users where id = any($1)", [[u.id, other.id]]);
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
