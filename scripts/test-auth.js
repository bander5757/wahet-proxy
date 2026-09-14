// اختبارات الدخول والجلسات (staging فقط): scrypt، ترقية الصيغة القديمة، تذكرني، logout، الانتهاء، الكوكي.
// يستخدم مستخدمين مؤقتين بكلمات مرور تُولَّد هنا — لا يلمس حسابات الفريق.
const crypto = require("crypto");
const { Pool } = require("pg");
const app = require("../api/app");
const A = app.__auth;

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
async function expectErr(n, fn, code) { try { await fn(); ok(n, false, "لم يُرمَ خطأ"); } catch (e) { ok(n, e.statusCode === code, `statusCode=${e.statusCode}`); } }
const hours = (d) => (new Date(d).getTime() - Date.now()) / 3600e3;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  const code = crypto.randomBytes(12).toString("base64url");
  const legacyCode = crypto.randomBytes(12).toString("base64url");
  const u = (await client.query("insert into app_users (name,email,role,login_code_hash) values ('auth-test','auth-test@wkaimah.local','viewer',$1) returning id", [A.hashLoginCode(code)])).rows[0];
  const lu = (await client.query("insert into app_users (name,email,role,login_code_hash) values ('auth-legacy','auth-legacy@wkaimah.local','viewer',encode(sha256(convert_to($1,'UTF8')),'hex')) returning id", [legacyCode])).rows[0];
  try {
    console.log("— التجزئة —");
    const h = A.hashLoginCode(code);
    ok("scrypt بملح (نفس الكلمة ⇒ تجزئتان مختلفتان)", h.startsWith("scrypt$") && h !== A.hashLoginCode(code));
    ok("التحقق الصحيح/الخاطئ", A.verifyLoginCode(code, h).ok && !A.verifyLoginCode(code + "x", h).ok);

    console.log("— الدخول —");
    await expectErr("كلمة مرور خاطئة ⇒ 401", () => A.login(client, { identifier: "auth-test", code: code + "x" }), 401);
    await expectErr("مستخدم غير موجود ⇒ 401", () => A.login(client, { identifier: "nobody-x", code }), 401);
    const s1 = await A.login(client, { identifier: "auth-test", code, remember: false });
    ok("بدون تذكرني ⇒ جلسة قصيرة (≈12 ساعة) غير دائمة", s1.persistent === false && hours(s1.expires_at) > 11 && hours(s1.expires_at) <= 12.01, hours(s1.expires_at).toFixed(2));
    const s2 = await A.login(client, { identifier: "auth-test@wkaimah.local", code, remember: true });
    ok("مع تذكرني ⇒ 30 يوماً دائمة", s2.persistent === true && hours(s2.expires_at) > 719 && hours(s2.expires_at) <= 720.01);
    ok("لا تجزئة ولا كلمة مرور في المستخدم المُعاد", !("login_code_hash" in s2.user) && !JSON.stringify(s2.user).includes(code));

    console.log("— الكوكي —");
    const cp = A.sessionCookie(s2.token, true), cs = A.sessionCookie(s1.token, false);
    ok("الكوكي الدائم: HttpOnly Secure SameSite Max-Age=30 يوم", /HttpOnly/.test(cp) && /Secure/.test(cp) && /SameSite=Lax/.test(cp) && /Max-Age=2592000/.test(cp));
    ok("كوكي الجلسة القصيرة بلا Max-Age (يُحذف بإغلاق المتصفح)", /HttpOnly/.test(cs) && !/Max-Age|Expires/.test(cs));
    ok("كوكي الخروج Max-Age=0", /Max-Age=0/.test(A.clearSessionCookie()));
    ok("قراءة الكوكي من الترويسة", A.parseCookies(`a=1; wahet_session=${s2.token}; b=2`).wahet_session === s2.token);

    console.log("— الجلسة والتحديث (refresh) —");
    const me = await A.getUserFromToken(client, s2.token);
    ok("التحديث: الكوكي يعيد نفس المستخدم", me && me.name === "auth-test");
    ok("token مخزّن كبصمة فقط", (await client.query("select count(*)::int n from app_sessions where token_hash=$1", [s2.token])).rows[0].n === 0);

    console.log("— الخروج والإلغاء والانتهاء —");
    ok("logout يلغي الجلسة", (await A.revokeSession(client, s2.token)) === 1);
    ok("بعد logout لا دخول بنفس الكوكي", (await A.getUserFromToken(client, s2.token)) === null);
    ok("الجلسة الأخرى لا تتأثر", !!(await A.getUserFromToken(client, s1.token)));
    await client.query("update app_sessions set expires_at = now() - interval '1 minute' where token_hash=encode(sha256(convert_to($1,'UTF8')),'hex')", [s1.token]);
    ok("انتهاء الجلسة يمنع الدخول", (await A.getUserFromToken(client, s1.token)) === null);
    await client.query("update app_users set is_active=false where id=$1", [u.id]);
    const s3 = await A.login(client, { identifier: "auth-legacy", code: legacyCode }).catch(() => null);
    await client.query("update app_users set is_active=true where id=$1", [u.id]);

    console.log("— الصيغة القديمة —");
    ok("sha256 القديمة تُقبل", !!s3);
    const upgraded = (await client.query("select login_code_hash from app_users where id=$1", [lu.id])).rows[0].login_code_hash;
    ok("وتُرقّى تلقائياً إلى scrypt", upgraded.startsWith("scrypt$"));
    ok("والدخول بعد الترقية يعمل", !!(await A.login(client, { identifier: "auth-legacy", code: legacyCode })));
    await client.query("update app_users set is_active=false where id=$1", [lu.id]);
    await expectErr("حساب موقوف ⇒ 401", () => A.login(client, { identifier: "auth-legacy", code: legacyCode }), 401);
  } finally {
    await client.query("delete from app_users where id = any($1)", [[u.id, lu.id]]); // الجلسات تُحذف تتابعياً
    client.release(); await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
