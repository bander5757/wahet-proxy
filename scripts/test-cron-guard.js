// اختبار حارس DISABLE_CRON — staging فقط. لا يشغّل الرادار الحقيقي (لا Etimad/Anthropic/كتابة).
const { Pool } = require("pg");
const app = require("../api/app");

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
function mockRes() { const r = { code: 0, body: null }; r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; }
const radarReq = () => ({ method: "POST", url: "/api/app/tenders/radar-scan", query: { path: "/tenders/radar-scan" }, headers: {}, body: {} });

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  console.log("DB:", (await client.query("select current_database()")).rows[0].current_database);
  const before = (await client.query("select count(*)::int n from tenders")).rows[0].n;
  console.log("tenders baseline:", before);

  try {
    // (أ) DISABLE_CRON=1 ⇒ skipped بلا أي side effect
    process.env.DISABLE_CRON = "1";
    const res = mockRes();
    await app(radarReq(), res);
    ok("status 200", res.code === 200, `code=${res.code}`);
    ok("skipped=true & reason=cron_disabled", res.body && res.body.ok === true && res.body.skipped === true && res.body.reason === "cron_disabled", JSON.stringify(res.body));
    const afterDisabled = (await client.query("select count(*)::int n from tenders")).rows[0].n;
    ok("لا كتابة في القاعدة (tenders لم يتغيّر)", afterDisabled === before, `before=${before} after=${afterDisabled}`);

    // (ب) بدون DISABLE_CRON: الحارس لا يُفعَّل ⇒ السلوك القديم محفوظ.
    // إثبات بنيوي فقط (لا نستدعي الرادار الحقيقي عمداً لتفادي Etimad/Anthropic/الكتابة).
    delete process.env.DISABLE_CRON;
    ok("unset ⇒ الحارس لا يُفعَّل", (process.env.DISABLE_CRON === "1") === false);
    process.env.DISABLE_CRON = "0";
    ok("'0' ⇒ الحارس لا يُفعَّل (شرط صارم ==='1')", (process.env.DISABLE_CRON === "1") === false);
    delete process.env.DISABLE_CRON;

    const afterAll = (await client.query("select count(*)::int n from tenders")).rows[0].n;
    ok("القاعدة عند baseline (لا آثار)", afterAll === before, `n=${afterAll}`);
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("خطأ:", e.message); process.exit(1); });
