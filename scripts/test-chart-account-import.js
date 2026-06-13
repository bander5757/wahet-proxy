const assert = require("node:assert/strict");
const fs = require("node:fs");

function duplicateWarnings(accounts) {
  const grouped = accounts.reduce((acc, account) => {
    if (!acc[account.code]) acc[account.code] = [];
    acc[account.code].push(account);
    return acc;
  }, {});
  return Object.entries(grouped)
    .filter(([, rows]) => rows.length > 1)
    .map(([code, rows]) => ({
      code,
      accounts: rows.map(account => ({
        id: account.id,
        code: account.code,
        name_ar: account.name_ar,
        parent_code: account.parent_code,
        level: account.level,
        full_path: account.full_path,
      })),
    }));
}

function validateImportedChart(accounts) {
  for (const account of accounts) {
    assert.ok(account.id, `missing internal id: ${account.code} ${account.name_ar}`);
    assert.match(account.code, /^\d+$/, `invalid code: ${account.code}`);
    assert.ok(account.name_ar, `missing account name: ${account.id}`);
    assert.ok(account.level >= 1 && account.level <= 5, `invalid level: ${account.code}`);
    assert.equal(account.is_postable, account.level === 5, `postable must follow current final level only: ${account.code}`);
  }
  return duplicateWarnings(accounts);
}

const accountantChartAsWritten = [
  { id: "a1", code: "5", name_ar: "المصروفات", level: 1, parent_code: "", full_path: "المصروفات", is_postable: false },
  { id: "a2", code: "51", name_ar: "مصروفات تشغيلية", level: 2, parent_code: "5", full_path: "المصروفات > مصروفات تشغيلية", is_postable: false },
  { id: "a3", code: "511", name_ar: "مصروفات التاجير", level: 3, parent_code: "51", full_path: "المصروفات > مصروفات تشغيلية > مصروفات التاجير", is_postable: false },
  { id: "a4", code: "511001", name_ar: "مصروفات السيارات", level: 4, parent_code: "511", full_path: "المصروفات > مصروفات تشغيلية > مصروفات التاجير > مصروفات السيارات", is_postable: false },
  { id: "a5", code: "511001", name_ar: "مستلزمات الخيام", level: 4, parent_code: "511", full_path: "المصروفات > مصروفات تشغيلية > مصروفات التاجير > مستلزمات الخيام", is_postable: false },
  { id: "a6", code: "5110023", name_ar: "اعاشة العمال", level: 5, parent_code: "511001", full_path: "المصروفات > مصروفات تشغيلية > مصروفات التاجير > مستلزمات الخيام > اعاشة العمال", is_postable: true },
  { id: "a7", code: "5110023", name_ar: "الرواتب والاضافات", level: 5, parent_code: "511001", full_path: "المصروفات > مصروفات تشغيلية > مصروفات التاجير > مستلزمات الخيام > الرواتب والاضافات", is_postable: true },
  { id: "b1", code: "2", name_ar: "الخصوم", level: 1, parent_code: "", full_path: "الخصوم", is_postable: false },
  { id: "b2", code: "22", name_ar: "طويلة الاجل", level: 2, parent_code: "2", full_path: "الخصوم > طويلة الاجل", is_postable: false },
  { id: "b3", code: "221", name_ar: "القروض", level: 3, parent_code: "22", full_path: "الخصوم > طويلة الاجل > القروض", is_postable: false },
  { id: "b4", code: "221001", name_ar: "البنوك", level: 4, parent_code: "221", full_path: "الخصوم > طويلة الاجل > القروض > البنوك", is_postable: false },
  { id: "b5", code: "2210012", name_ar: "تساهيل", level: 5, parent_code: "221001", full_path: "الخصوم > طويلة الاجل > القروض > البنوك > تساهيل", is_postable: true },
];

const warnings = validateImportedChart(accountantChartAsWritten);
assert.ok(warnings.some(group => group.code === "511001" && group.accounts.length === 2), "duplicate 511001 must be warning, not error");
assert.ok(warnings.some(group => group.code === "5110023" && group.accounts.length === 2), "duplicate 5110023 must be warning, not error");
const duplicatePostableAccount = accountantChartAsWritten.find(account => account.id === "a7");
assert.ok(duplicatePostableAccount.id, "duplicate postable account can be selected by chart_account_id");
assert.equal(duplicatePostableAccount.is_postable, true, "duplicate postable account remains postable");

const tentSupplies = accountantChartAsWritten.find(account => account.name_ar === "مستلزمات الخيام");
const payroll = accountantChartAsWritten.find(account => account.name_ar === "الرواتب والاضافات");
const tasheel = accountantChartAsWritten.find(account => account.name_ar === "تساهيل");
assert.equal(tentSupplies.code, "511001");
assert.equal(payroll.code, "5110023");
assert.equal(tasheel.code, "2210012");
assert.ok(!accountantChartAsWritten.some(account => account.code === "2210021"), "2210021 must not be generated unless present in accountant file");

const apiSource = fs.readFileSync("api/app.js", "utf8");
assert.match(apiSource, /chart_account_id/, "finance entries must store chart_account_id");
assert.match(apiSource, /validatePostableChartAccount\(client, payload\.chartAccountId\)/, "finance creation must validate by internal account id");
assert.match(apiSource, /if \(!id\)[\s\S]{0,120}الحساب المحاسبي مطلوب/, "code-only finance saves must be rejected when chart_account_id is missing");
assert.doesNotMatch(apiSource, /where code = \$1[\s\S]{0,120}\[code\]/, "finance validation must not select chart account by code");
assert.doesNotMatch(apiSource, /لا يتم الترحيل عليه حتى يراجع المحاسب/, "duplicate codes must not block finance saves");

const uiSource = fs.readFileSync("index.html", "utf8");
assert.match(uiSource, /تم الاعتماد على المعرف الداخلي والمسار الكامل للتمييز/, "duplicate code warning must be shown without blocking");
assert.match(uiSource, /chartAccountId/, "UI must send chartAccountId for finance entries");
assert.match(apiSource, /category: row\.category \|\| ""/, "old finance entries with text category must still render");

console.log("chart account import regression ok");
