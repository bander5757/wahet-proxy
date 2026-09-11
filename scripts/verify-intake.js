// سكربت تحقق M0 — قراءة فقط. يتأكد من وجود جدول whatsapp_intake وأعمدته وفهارسه.
// الاستخدام: DATABASE_URL="postgresql://…staging…" DATABASE_SSL=true node scripts/verify-intake.js
const { Pool } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL مطلوب (مرّره في سطر التشغيل، لا تلمس .env.local)");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  try {
    const t = await pool.query("select to_regclass('public.whatsapp_intake') as tbl");
    if (!t.rows[0].tbl) {
      console.error("❌ جدول whatsapp_intake غير موجود");
      process.exit(2);
    }
    console.log("✅ جدول whatsapp_intake موجود");

    const cols = await pool.query(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_name = 'whatsapp_intake' order by ordinal_position`
    );
    console.log(`\nالأعمدة (${cols.rows.length}):`);
    for (const c of cols.rows) {
      console.log(`  - ${c.column_name} :: ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
    }

    const idx = await pool.query(
      `select indexname from pg_indexes where tablename = 'whatsapp_intake' order by indexname`
    );
    console.log(`\nالفهارس (${idx.rows.length}):`);
    idx.rows.forEach((r) => console.log(`  - ${r.indexname}`));

    const chk = await pool.query(
      `select con.conname, pg_get_constraintdef(con.oid) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       where rel.relname = 'whatsapp_intake' and con.contype = 'c'
       order by con.conname`
    );
    console.log(`\nقيود CHECK (${chk.rows.length}):`);
    chk.rows.forEach((r) => console.log(`  - ${r.conname}: ${r.def}`));

    const fk = await pool.query(
      `select con.conname, pg_get_constraintdef(con.oid) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       where rel.relname = 'whatsapp_intake' and con.contype = 'f'
       order by con.conname`
    );
    console.log(`\nمفاتيح أجنبية (${fk.rows.length}):`);
    fk.rows.forEach((r) => console.log(`  - ${r.conname}: ${r.def}`));

    const cnt = await pool.query("select count(*)::int as n from whatsapp_intake");
    console.log(`\nعدد الصفوف الحالية: ${cnt.rows[0].n} (يجب أن يكون 0 على قاعدة جديدة)`);

    // تأكيد الحقول المفتاحية على intake (الحساب مزدوج الطرف + parsed/final + missing_fields + provider)
    const wantCols = [
      "provider", "provider_message_id", "parsed_data", "final_data", "missing_fields",
      "source_account_id", "destination_account_id", "confidence_score", "updated_at",
    ];
    const gotCols = await pool.query(
      `select column_name from information_schema.columns
       where table_name='whatsapp_intake' and column_name = any($1)`,
      [wantCols]
    );
    const gotSet = new Set(gotCols.rows.map((r) => r.column_name));
    const missing = wantCols.filter((c) => !gotSet.has(c));
    console.log(`\nحقول intake المفتاحية: ${gotSet.size}/${wantCols.length}${missing.length ? " — مفقود: " + missing.join(", ") : " ✅"}`);
    if (missing.length) process.exit(4);

    // تأكيد الفهرس المركّب لمنع التكرار حسب المزوّد
    const provIdx = await pool.query(
      `select 1 from pg_indexes where tablename='whatsapp_intake' and indexname='idx_intake_provider_msg'`
    );
    console.log(`فهرس منع التكرار (provider, provider_message_id): ${provIdx.rowCount ? "موجود ✅" : "مفقود ❌"}`);
    if (!provIdx.rowCount) process.exit(5);

    // تأكيد جدول التدقيق agent_actions
    const aa = await pool.query("select to_regclass('public.agent_actions') as tbl");
    if (!aa.rows[0].tbl) {
      console.error("❌ جدول agent_actions غير موجود");
      process.exit(3);
    }
    const aaCols = await pool.query(
      `select count(*)::int as n from information_schema.columns where table_name='agent_actions'`
    );
    const aaIdx = await pool.query(
      `select count(*)::int as n from pg_indexes where tablename='agent_actions'`
    );
    const aaCnt = await pool.query("select count(*)::int as n from agent_actions");
    console.log(`✅ جدول agent_actions موجود — ${aaCols.rows[0].n} أعمدة، ${aaIdx.rows[0].n} فهارس، ${aaCnt.rows[0].n} صفوف`);

    // تأكيد أن الجداول الأساسية موجودة أيضاً (base schema طُبِّق)
    const base = await pool.query(
      `select count(*)::int as n from information_schema.tables
       where table_schema='public'
       and table_name in ('app_users','finance_entries','chart_accounts','customers','vehicles','rental_quotes','attachments')`
    );
    console.log(`جداول أساسية موجودة: ${base.rows[0].n}/7`);

    console.log("\n✅ التحقق اكتمل بنجاح");
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error("❌", e.message); process.exit(1); });
