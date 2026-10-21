// اختبارات حقل المؤسسة المستفيدة في عقد المحلل — دوال نقية، بلا قاعدة بيانات وبلا شبكة.
// التشغيل: node scripts/test-analysis-org.js
const { sanitizeAnalysis } = require("../api/app").__analysis;

let passed = 0, failed = 0;
const ok = (n, c, e) => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.log(`  ❌ ${n}${e ? " — " + e : ""}`); } };
const org = (fields) => {
  const r = sanitizeAnalysis({ fields });
  return `${r.fields.organization}/${r.fields.organization_source}`;
};

console.log("— قاعدة الافتراضي —");
ok("لا اسم ⇒ main/default", org({}) === "main/default", org({}));
ok("حقول أخرى بلا مؤسسة ⇒ main/default", org({ amount: 100, description: "بنزين" }) === "main/default");

console.log("\n— الاسم الصريح —");
ok("main صريح ⇒ main/explicit", org({ organization: "main", organization_source: "explicit" }) === "main/explicit");
ok("secondary صريح ⇒ secondary/explicit", org({ organization: "secondary", organization_source: "explicit" }) === "secondary/explicit");
ok("اسم بلا مصدر ⇒ explicit", org({ organization: "secondary" }) === "secondary/explicit");
ok("مسافات حول القيمة لا تكسر المطابقة", org({ organization: " secondary " }) === "secondary/explicit");

console.log("\n— التعارض لا يُحسم على الخادم —");
ok("conflict ⇒ unresolved/conflict", org({ organization_source: "conflict" }) === "unresolved/conflict");
ok("conflict مع اسم ⇒ لا يرجّح الاسم", org({ organization: "secondary", organization_source: "conflict" }) === "unresolved/conflict");
ok("unresolved ⇒ unresolved/conflict", org({ organization: "unresolved" }) === "unresolved/conflict");

console.log("\n— القيم غير المعروفة والمزيج المتناقض —");
ok("اسم غير معروف ⇒ unresolved/conflict لا main", org({ organization: "المؤسسة الثالثة" }) === "unresolved/conflict");
ok("مصدر غير معروف ⇒ unresolved/conflict", org({ organization: "main", organization_source: "guess" }) === "unresolved/conflict");
ok("default مع secondary متناقض ⇒ unresolved/conflict", org({ organization: "secondary", organization_source: "default" }) === "unresolved/conflict");
ok("default مع main ⇒ main/default", org({ organization: "main", organization_source: "default" }) === "main/default");
ok("مصدر default بلا اسم ⇒ main/default", org({ organization_source: "default" }) === "main/default");
ok("مصدر explicit بلا اسم ⇒ unresolved/conflict", org({ organization_source: "explicit" }) === "unresolved/conflict");

console.log("\n— لا تلوّث لبقية العقد —");
const full = sanitizeAnalysis({
  fields: { amount: 100, description: "بنزين", organization: "secondary", organization_source: "explicit", bogus: "x" },
  items: [{ description: "ديزل", amount: 100, direction: "out", kind: "expense" }], reported_total: 100,
});
ok("الحقول المسموحة باقية", full.fields.amount === 100 && full.fields.description === "بنزين");
ok("الحقول غير المسموحة تُحذف", !("bogus" in full.fields));
ok("المطابقة تبقى محسوبة على الخادم", full.expenses_match === true && Number(full.expenses_diff) === 0, JSON.stringify({ m: full.expenses_match, d: full.expenses_diff }));
ok("المؤسسة لا تؤثر على التصنيف", sanitizeAnalysis({ fields: { organization: "secondary" }, suggested_classification: "expense" }).suggested_classification === "expense");

console.log(`\nالنتيجة: ${passed} ناجح، ${failed} فاشل`);
process.exit(failed ? 1 : 0);
