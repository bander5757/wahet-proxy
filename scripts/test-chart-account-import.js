const assert = require("node:assert/strict");

const ACCOUNT_TYPE_BY_ROOT = {
  "1": "asset",
  "2": "liability",
  "3": "equity",
  "4": "revenue",
  "5": "expense",
};

const NORMAL_BALANCE_BY_TYPE = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

const EXPECTED_CODE_LENGTH_BY_LEVEL = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 7 };

function expectedParentCode(code, level) {
  if (level <= 1) return "";
  if (level === 2) return code.slice(0, 1);
  if (level === 3) return code.slice(0, 2);
  if (level === 4) return code.slice(0, 3);
  if (level === 5) return code.slice(0, 6);
  return "";
}

function normalizeAccount(account) {
  const code = String(account.code || "").trim();
  const level = Number(account.level);
  const accountType = ACCOUNT_TYPE_BY_ROOT[code[0]];
  return {
    code,
    name_ar: String(account.name_ar || "").trim(),
    level,
    parent_code: level === 1 ? "" : String(account.parent_code || expectedParentCode(code, level)).trim(),
    account_type: accountType,
    normal_balance: NORMAL_BALANCE_BY_TYPE[accountType],
    is_postable: level === 5,
    is_active: true,
  };
}

function validateChartAccounts(accounts, expectedCount) {
  const normalized = accounts.map(normalizeAccount);
  const codes = new Set();
  for (const account of normalized) {
    assert.match(account.code, /^\d+$/, `invalid code: ${account.code}`);
    assert.equal(account.code.length, EXPECTED_CODE_LENGTH_BY_LEVEL[account.level], `bad level/code length: ${account.code}`);
    assert.ok(account.name_ar, `missing account name: ${account.code}`);
    assert.ok(account.account_type, `missing account type: ${account.code}`);
    assert.ok(!codes.has(account.code), `duplicate account code: ${account.code}`);
    codes.add(account.code);
  }
  for (const account of normalized) {
    if (account.level > 1) {
      assert.equal(account.parent_code, expectedParentCode(account.code, account.level), `bad parent by code: ${account.code}`);
      assert.ok(codes.has(account.parent_code), `missing parent: ${account.code} -> ${account.parent_code}`);
    }
    assert.equal(account.is_postable, account.level === 5, `bad postable flag: ${account.code}`);
  }
  assert.equal(normalized.length, expectedCount, "corrected chart account count changed");
  return normalized;
}

const correctedRegressionAccounts = [
  { code: "2", name_ar: "الخصوم", level: 1 },
  { code: "22", name_ar: "طويلة الاجل", level: 2 },
  { code: "221", name_ar: "القروض", level: 3 },
  { code: "221001", name_ar: "البنوك", level: 4 },
  { code: "221002", name_ar: "شركات التمويل", level: 4 },
  { code: "2210011", name_ar: "الراجحي", level: 5 },
  { code: "2210012", name_ar: "تساهيل", level: 5 },
  { code: "2210021", name_ar: "تساهيل", level: 5 },
  { code: "5", name_ar: "المصروفات", level: 1 },
  { code: "51", name_ar: "مصروفات تشغيلية", level: 2 },
  { code: "511", name_ar: "مصروفات التاجير", level: 3 },
  { code: "511001", name_ar: "مصروفات السيارات", level: 4 },
  { code: "511002", name_ar: "مستلزمات الخيام", level: 4 },
  { code: "5110011", name_ar: "تامين", level: 5 },
  { code: "5110012", name_ar: "صيانة", level: 5 },
  { code: "5110013", name_ar: "مخالفات مرور", level: 5 },
  { code: "5110014", name_ar: "محروقات", level: 5 },
  { code: "5110021", name_ar: "عدد مستهلكة", level: 5 },
  { code: "5110022", name_ar: "فريون للمكيفات", level: 5 },
  { code: "5110023", name_ar: "اعاشة العمال", level: 5 },
  { code: "5110024", name_ar: "الرواتب والاضافات", level: 5 },
];

const normalized = validateChartAccounts(correctedRegressionAccounts, 21);
for (const requiredCode of ["2210012", "2210021", "511002", "5110023", "5110024"]) {
  assert.ok(normalized.some(account => account.code === requiredCode), `missing corrected regression account: ${requiredCode}`);
}

console.log("chart account import regression ok");
