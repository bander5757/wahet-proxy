const { Pool } = require("pg");
const crypto = require("crypto");

/* ─── Email / SMTP ─── */
let _mailerTransport = null;
function getMailer() {
  if (_mailerTransport) return _mailerTransport;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  const secure = process.env.SMTP_SECURE !== "false";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const nodemailer = require("nodemailer");
  _mailerTransport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  return _mailerTransport;
}

async function sendEmail(to, subject, html) {
  const mailer = getMailer();
  if (!mailer) return { ok: false, error: "إعدادات SMTP غير مكتملة" };
  const fromName = process.env.EMAIL_FROM_NAME || "واحة الخيمة";
  const fromAddr = process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER;
  try {
    await mailer.sendMail({ from: `"${fromName}" <${fromAddr}>`, to, subject, html });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ensureEmailLogTable(client) {
  await client.query(`
    create table if not exists email_notification_logs (
      id uuid primary key default gen_random_uuid(),
      notification_type text not null,
      recipient_user_id text,
      recipient_email text,
      related_type text,
      related_id text,
      subject text,
      status text not null check (status in ('sent','failed')),
      sent_at timestamptz,
      error_message text,
      created_at timestamptz not null default now()
    )
  `);
}

async function logEmailNotification(client, { type, userId, email, relatedType, relatedId, subject, status, error }) {
  await ensureEmailLogTable(client);
  await client.query(
    `insert into email_notification_logs
       (notification_type, recipient_user_id, recipient_email, related_type, related_id, subject, status, sent_at, error_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [type, userId || null, email || null, relatedType || null, relatedId || null,
     subject || null, status, status === "sent" ? new Date() : null, error || null]
  );
}

async function getNotificationPrefs(client) {
  return (await getSetting(client, "notification_prefs")) || {};
}

async function sendEventEmail(client, eventType, { subject, html, relatedType, relatedId }) {
  let prefs;
  try { prefs = await getNotificationPrefs(client); } catch(e) { return; }
  for (const [userName, cfg] of Object.entries(prefs)) {
    if (!cfg || !cfg.enabled || !cfg.email) continue;
    if (!Array.isArray(cfg.types) || !cfg.types.includes(eventType)) continue;
    const result = await sendEmail(cfg.email, subject, html);
    try {
      await logEmailNotification(client, {
        type: eventType, userId: userName, email: cfg.email,
        relatedType, relatedId, subject,
        status: result.ok ? "sent" : "failed",
        error: result.ok ? null : result.error,
      });
    } catch(e) { /* log failure is non-critical */ }
  }
}

function financeEmailHtml(entry, extra) {
  const typeLabel = entry.type || entry.entryType || "";
  return `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
    <h2 style="color:#1e3a5f">🏕️ واحة الخيمة — ${extra || typeLabel}</h2>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:6px;color:#555">النوع</td><td style="padding:6px;font-weight:bold">${typeLabel}</td></tr>
      <tr><td style="padding:6px;color:#555">المبلغ</td><td style="padding:6px;font-weight:bold">${Number(entry.amount||0).toLocaleString()} ر.س</td></tr>
      <tr><td style="padding:6px;color:#555">البيان</td><td style="padding:6px">${entry.note||entry.statement||''}</td></tr>
      <tr><td style="padding:6px;color:#555">الحساب</td><td style="padding:6px">${entry.account||''}</td></tr>
      <tr><td style="padding:6px;color:#555">أنشأها</td><td style="padding:6px">${entry.createdBy||entry.enteredBy||'—'}</td></tr>
      <tr><td style="padding:6px;color:#555">التاريخ</td><td style="padding:6px">${String(entry.created||'').slice(0,10)}</td></tr>
    </table>
  </div>`;
}

const TYPE_MAP = {
  "مصروف": "expense",
  "عهدة": "custody",
  "إيراد": "income",
  "سلفة": "loan",
  "دين": "debt",
  "تحويل": "transfer",
};

const TYPE_LABELS = Object.fromEntries(Object.entries(TYPE_MAP).map(([label, key]) => [key, label]));

const DOC_TYPE_MAP = {
  "إقامة": "iqama",
  "رخصة عمل": "work_permit",
  "جواز": "passport",
  "تأمين": "insurance",
  "عقد": "contract",
  "أخرى": "other",
};
const DOC_TYPE_LABELS = Object.fromEntries(Object.entries(DOC_TYPE_MAP).map(([label, key]) => [key, label]));

const VEHICLE_TASK_MAP = {
  "تغيير زيت": "oil_change",
  "فحص": "inspection",
  "تأمين": "insurance",
  "استمارة": "registration",
  "صيانة": "maintenance",
  "أخرى": "other",
};
const VEHICLE_TASK_LABELS = Object.fromEntries(Object.entries(VEHICLE_TASK_MAP).map(([label, key]) => [key, label]));

const TENDER_STATUS_MAP = {
  "مناسبة": "fit",
  "غير مناسبة": "not_fit",
  "تحتاج مراجعة": "review",
};
const TENDER_STATUS_LABELS = Object.fromEntries(Object.entries(TENDER_STATUS_MAP).map(([label, key]) => [key, label]));
const RADAR_KEYWORDS = [
  "خيام أوروبية",
  "خيام اوروبية",
  "خيمة أوروبية",
  "تأجير خيام",
  "ايجار خيام",
  "توريد خيام",
  "خيام فعاليات",
  "ضيافة خيام",
  "مخيمات فعاليات",
  "خيام",
  "خيمة",
  "مخيم فاخر",
];
const RADAR_NEGATIVE_WORDS = [
  "قطع غيار", "سيارات", "نظافة", "تقنية المعلومات",
  "رخص رقمية", "طباعة", "فريون", "قواعد البيانات",
  "معدات التحقق", "خيام رحلات", "خيام بر", "خيام أطفال",
  "حراج", "مستعملة", "السنيدي", "القاضي", "خياط خيام",
  "أرخص خيام", "تفصيل خيام شعر",
];
// كلمات مشروطة: سلبية إلا إذا اقترنت بالإيجار
const RADAR_CONDITIONAL_NEGATIVE = [
  { trigger: "بيت شعر", allowIf: ["إيجار","ايجار","تأجير","تاجير","استئجار"] },
  { trigger: "خيام شعر", allowIf: ["إيجار","ايجار","تأجير","تاجير","استئجار"] },
  { trigger: "بيوت شعر", allowIf: ["إيجار","ايجار","تأجير","تاجير","استئجار"] },
  { trigger: "تفصيل", allowIf: [] },
];

let pool;

function normalizeDatabaseUrl(value) {
  const url = String(value || "").trim();
  const bracketPassword = url.match(/^(postgres(?:ql)?:\/\/[^:]+:)\[(.*)\]@(.+)$/);
  if (bracketPassword) {
    return bracketPassword[1] + encodeURIComponent(bracketPassword[2]) + "@" + bracketPassword[3];
  }
  return url;
}

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Wahet-User, X-Wahet-Token, X-Intake-Secret");
}

function moneyNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : "";
}

function firstDate(...values) {
  return values.map(dateOnly).find(Boolean) || "";
}

function resolveDaftraProxyUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "/api/daftra";
  if (value.endsWith("/api/daftra")) return value;
  if (value.endsWith("/api/daftra/")) return value.slice(0, -1);
  if (value.startsWith("/") && value !== "/") return value;
  return value.replace(/\/+$/, "") + "/api/daftra";
}

function daftraItemsFrom(record, wrapper) {
  const candidates = [
    wrapper?.EstimateItem,
    wrapper?.EstimateItems,
    wrapper?.InvoiceItem,
    wrapper?.InvoiceItems,
    record?.EstimateItem,
    record?.EstimateItems,
    record?.InvoiceItem,
    record?.InvoiceItems,
    record?.items,
    record?.line_items,
    record?.details,
  ];
  const items = candidates.find(Array.isArray) || [];
  return items.map((item) => item.EstimateItem || item.InvoiceItem || item).map((item) => ({
    name: item.item || item.name || item.product_name || item.description || item.item_name || "بند",
    description: item.description || item.details || "",
    quantity: item.quantity || item.qty || "",
    unitPrice: item.unit_price || item.price || item.unitPrice || "",
    tax: item.tax1 || item.tax || item.tax_value || "",
    total: item.total || item.subtotal || item.line_total || "",
  }));
}

function daftraDetailsFrom(record, wrapper) {
  return {
    status: record.status || record.state || "",
    clientName: record.client_business_name || record.client_first_name || record.client_name || "",
    clientPhone: record.client_phone || "",
    notes: record.notes || record.note || record.description || "",
    terms: record.terms || record.terms_conditions || "",
    totals: {
      subtotal: record.subtotal || record.sub_total || record.net_total || record.before_tax || wrapper?.subtotal || wrapper?.sub_total || "",
      discount: record.discount || record.discount_value || record.discount_amount || wrapper?.discount || "",
      tax: record.tax_total || record.total_tax || record.tax || record.tax_value || record.vat || wrapper?.tax_total || "",
      total: record.total || record.grand_total || record.total_amount || record.amount || wrapper?.total || "",
      paid: record.paid || record.paid_amount || record.amount_paid || wrapper?.paid || "",
      balance: record.balance || record.due_amount || record.remaining || wrapper?.balance || "",
    },
    items: daftraItemsFrom(record, wrapper),
  };
}

function daftraExpenseFrom(wrapper) {
  const expense = wrapper?.Expense || wrapper?.expense || wrapper || {};
  return {
    id: String(expense.id || ""),
    code: expense.code || expense.no || expense.number || "",
    amount: moneyNumber(expense.amount || expense.total || expense.summary_total),
    currency: expense.currency_code || expense.currency || "SAR",
    vendor: expense.vendor || expense.vendor_name || expense.supplier_name || "",
    category: expense.category || expense.category_name || expense.expense_category || "",
    date: firstDate(expense.date, expense.created_at, expense.created),
    note: expense.note || expense.description || expense.notes || "",
    account: expense.account_name || expense.treasury_name || expense.payment_account_name || "",
    paymentMethod: expense.payment_method || expense.payment_method_name || "",
    taxAmount: moneyNumber(expense.tax1_amount || expense.tax2_amount || expense.tax_amount || expense.vat_amount),
    attachments: expense.attachments || expense.file || "",
    raw: expense,
  };
}

function daftraCustodyFrom(wrapper) {
  const custody = wrapper?.EmployeeCustody || wrapper?.Custody || wrapper?.custody || wrapper || {};
  return {
    id: String(custody.id || ""),
    code: custody.code || custody.no || custody.number || custody.custody_code || "",
    employee: custody.employee_name || custody.staff_name || custody.user_name || custody.employee || "",
    amount: moneyNumber(custody.amount || custody.total),
    remaining: moneyNumber(custody.remaining_balance || custody.balance || custody.remaining || custody.due_amount),
    status: custody.status || custody.state || "",
    date: firstDate(custody.date, custody.created_at, custody.created),
    dueDate: firstDate(custody.settlement_due_date, custody.due_date),
    note: custody.description || custody.note || custody.notes || "",
    raw: custody,
  };
}

function daftraPaymentFrom(wrapper) {
  const payment = wrapper?.Payment || wrapper?.Receipt || wrapper?.Transaction || wrapper?.payment || wrapper || {};
  return {
    id: String(payment.id || ""),
    code: payment.code || payment.no || payment.number || payment.receipt_no || "",
    amount: moneyNumber(payment.amount || payment.total || payment.paid_amount),
    date: firstDate(payment.date, payment.created_at, payment.created),
    client: payment.client_business_name || payment.client_first_name || payment.client_name || payment.customer_name || "",
    invoiceId: payment.invoice_id || payment.InvoiceId || "",
    account: payment.account_name || payment.treasury_name || payment.payment_account_name || "",
    method: payment.payment_method || payment.payment_method_name || "",
    note: payment.note || payment.description || payment.notes || "",
    raw: payment,
  };
}

function daftraAccountFrom(wrapper) {
  const account = wrapper?.Treasury || wrapper?.Account || wrapper?.BankAccount || wrapper?.account || wrapper || {};
  return {
    id: String(account.id || ""),
    name: account.name || account.account_name || account.title || "",
    code: account.code || account.no || account.number || "",
    balance: moneyNumber(account.balance || account.current_balance || account.amount || account.total),
    currency: account.currency_code || account.currency || "SAR",
    type: account.type || account.account_type || "",
    raw: account,
  };
}

function financeRow(row) {
  return {
    id: row.id,
    type: TYPE_LABELS[row.entry_type] || row.entry_type,
    amount: moneyNumber(row.amount),
    account: row.account_name || "الحساب الرسمي",
    person: row.related_person || "",
    note: row.statement,
    attachment: row.attachment_name || "",
    category: row.category || "",
    chartAccountId: row.chart_account_id || "",
    created: row.created_at,
    createdBy: row.entered_by_name || "النظام",
    status: row.status,
  };
}

function staffDocRow(row) {
  return {
    id: row.id,
    name: row.employee_name,
    type: DOC_TYPE_LABELS[row.document_type] || row.document_type,
    expires: row.expires_on,
    note: row.notes || "",
    attachment: row.attachment_name || "",
  };
}

function vehicleTaskRow(row) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    name: row.vehicle_name,
    type: VEHICLE_TASK_LABELS[row.task_type] || row.task_type,
    due: row.due_on,
    odometer: row.due_odometer ? String(row.due_odometer) : row.notes || "",
    attachment: row.attachment_name || "",
  };
}

function generalAlertRow(row) {
  return {
    id: row.id,
    title: row.title,
    due: row.due_on,
    note: row.notes || "",
    status: row.status || "open",
    attachment: row.attachment_name || "",
  };
}

function chartAccountRow(row) {
  return {
    id: row.id,
    code: row.code,
    name_ar: row.name_ar,
    level: Number(row.level),
    parent_code: row.parent_code || "",
    original_row_number: row.original_row_number === null || row.original_row_number === undefined ? null : Number(row.original_row_number),
    account_type: row.account_type,
    normal_balance: row.normal_balance,
    is_postable: Boolean(row.is_postable),
    is_active: Boolean(row.is_active),
    full_path: row.full_path || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

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

function inferAccountType(code) {
  return ACCOUNT_TYPE_BY_ROOT[String(code || "")[0]] || null;
}

function expectedParentCode(code, level) {
  const value = String(code || "");
  if (level <= 1) return null;
  if (level === 2) return value.slice(0, 1);
  if (level === 3) return value.slice(0, 2);
  if (level === 4) return value.slice(0, 3);
  if (level === 5) return value.slice(0, 6);
  return null;
}

function validateChartAccountPayload(payload) {
  const code = String(payload.code || "").trim();
  const name = String(payload.name_ar || payload.name || "").trim();
  const level = Number(payload.level);
  if (!/^\d+$/.test(code)) {
    const err = new Error("كود الحساب يجب أن يكون أرقاماً فقط");
    err.statusCode = 400;
    throw err;
  }
  if (!name) {
    const err = new Error("اسم الحساب مطلوب");
    err.statusCode = 400;
    throw err;
  }
  if (!EXPECTED_CODE_LENGTH_BY_LEVEL[level] || code.length !== EXPECTED_CODE_LENGTH_BY_LEVEL[level]) {
    const err = new Error("مستوى الحساب لا يتوافق مع طول الكود");
    err.statusCode = 400;
    throw err;
  }
  const accountType = inferAccountType(code);
  if (!accountType) {
    const err = new Error("نوع الحساب غير معروف من أول رقم في الكود");
    err.statusCode = 400;
    throw err;
  }
  const parentCode = level === 1 ? null : String(payload.parent_code || expectedParentCode(code, level) || "").trim();
  return {
    code,
    name_ar: name,
    level,
    parent_code: parentCode,
    original_row_number: payload.original_row_number === undefined || payload.original_row_number === null ? null : Number(payload.original_row_number),
    account_type: accountType,
    normal_balance: NORMAL_BALANCE_BY_TYPE[accountType],
    is_postable: level === 5,
    is_active: payload.is_active !== false,
  };
}

function tenderRow(row) {
  return {
    id: row.id,
    title: row.title,
    entity: row.entity_name || "",
    platform: row.source_name || "",
    url: row.source_url || "#",
    externalKey: row.external_key || "",
    keyword: row.matched_keyword || "",
    type: row.opportunity_type || "tender",
    due: row.due_on || "",
    score: TENDER_STATUS_LABELS[row.fit_status] || "تحتاج مراجعة",
    reason: row.fit_reason || "",
    decision: row.decision || "",
    action: row.suggested_action || "",
    followStatus: row.follow_status || "new",
    lastSeen: row.last_seen_at,
    created: row.created_at,
  };
}

function quoteStateRow(row) {
  return {
    id: row.local_key,
    quoteConfirmed: Boolean(row.quote_confirmed),
    taxInvoiceIssued: Boolean(row.tax_invoice_issued),
    stage: row.stage,
    installDate: row.install_date || "",
    assignedTo: row.assigned_to || "—",
    notes: row.notes || "",
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/* ─── كلمات المرور والجلسات ───
   scrypt بملح لكل مستخدم: "scrypt$<salt>$<hash>". الصيغة القديمة (sha256 بلا ملح) تُقبل وتُرقّى تلقائياً عند أول دخول. */
function hashLoginCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(code), salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyLoginCode(code, stored) {
  if (!stored) return { ok: false, legacy: false };
  if (stored.startsWith("scrypt$")) {
    const [, saltB64, hashB64] = stored.split("$");
    const expected = Buffer.from(hashB64, "base64");
    const got = crypto.scryptSync(String(code), Buffer.from(saltB64, "base64"), expected.length);
    return { ok: expected.length === got.length && crypto.timingSafeEqual(expected, got), legacy: false };
  }
  const a = Buffer.from(sha256(code)), b = Buffer.from(String(stored));
  return { ok: a.length === b.length && crypto.timingSafeEqual(a, b), legacy: true };
}
const SESSION_COOKIE = "wahet_session";
const SESSION_PERSISTENT_DAYS = 30;   // «تذكرني على هذا الجهاز»
const SESSION_SHORT_HOURS = 12;       // بدون تذكرني: كوكي جلسة المتصفح + حد أقصى 12 ساعة على الخادم
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// HttpOnly: لا يقرؤه JavaScript الصفحة؛ بدون Max-Age = كوكي جلسة يُحذف بإغلاق المتصفح
function sessionCookie(token, persistent) {
  const base = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return persistent ? `${base}; Max-Age=${SESSION_PERSISTENT_DAYS * 86400}` : base;
}
const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
async function revokeSession(client, token) {
  if (!token) return 0;
  const r = await client.query("update app_sessions set revoked_at=now() where token_hash=$1 and revoked_at is null", [sha256(token)]);
  return r.rowCount;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    role: row.role,
    // صلاحيات دقيقة إضافية فوق الدور (مثل sales.review) — لا تمنح صلاحيات إدارية عامة
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    must_change_password: row.must_change_password === true || row.must_change_password === "true",
  };
}

/* تغيير المستخدم لكلمة مروره بنفسه — لا يغيّر أحد كلمة مرور غيره من هنا */
const MIN_PASSWORD_LEN = 8;
const WEAK_PASSWORDS = ["password", "123456", "12345678", "qwerty", "111111", "admin", "wahet", "waha"];
function validateNewPassword(pw, user) {
  const p = String(pw || "");
  if (p.length < MIN_PASSWORD_LEN) { const e = new Error(`كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LEN} خانات`); e.statusCode = 400; throw e; }
  if (!/[A-Za-z؀-ۿ]/.test(p) || !/\d/.test(p)) { const e = new Error("كلمة المرور يجب أن تحتوي حروفاً وأرقاماً"); e.statusCode = 400; throw e; }
  const low = p.toLowerCase();
  if (WEAK_PASSWORDS.some((w) => low.includes(w))) { const e = new Error("كلمة المرور ضعيفة/شائعة — اختر غيرها"); e.statusCode = 400; throw e; }
  const phone = String(user.phone || "").replace(/\D/g, "");
  if (phone && phone.length >= 6 && p.replace(/\D/g, "").includes(phone.slice(-9))) {
    const e = new Error("لا تستخدم رقم جوالك في كلمة المرور"); e.statusCode = 400; throw e;
  }
  return p;
}
async function changeOwnPassword(client, payload, user, currentToken) {
  if (!user) { const e = new Error("يجب تسجيل الدخول"); e.statusCode = 401; throw e; }
  const current = String(payload.current_password || "");
  const next = String(payload.new_password || "");
  const confirm = String(payload.confirm_password || "");
  if (!current || !next) { const e = new Error("كلمة المرور الحالية والجديدة مطلوبة"); e.statusCode = 400; throw e; }
  if (next !== confirm) { const e = new Error("تأكيد كلمة المرور لا يطابق"); e.statusCode = 400; throw e; }
  const row = (await client.query("select login_code_hash from app_users where id=$1 and is_active", [user.id])).rows[0];
  if (!row || !verifyLoginCode(current, row.login_code_hash).ok) {
    const e = new Error("كلمة المرور الحالية غير صحيحة"); e.statusCode = 401; throw e;
  }
  if (verifyLoginCode(next, row.login_code_hash).ok) { const e = new Error("كلمة المرور الجديدة مطابقة للحالية"); e.statusCode = 400; throw e; }
  validateNewPassword(next, user);
  await client.query("update app_users set login_code_hash=$2, must_change_password=false where id=$1", [user.id, hashLoginCode(next)]);
  // الجلسة الحالية تبقى؛ أي جلسة أخرى لنفس المستخدم تُلغى (تغيير كلمة المرور يُخرج بقية الأجهزة)
  const others = await client.query(
    "update app_sessions set revoked_at=now() where user_id=$1 and revoked_at is null and token_hash <> $2", [user.id, sha256(currentToken || "")]);
  // لا تُسجَّل كلمة المرور ولا التجزئة في أي مكان
  await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, action: "auth.password_changed",
    targetType: "app_users", targetId: user.id, summary: `غيّر كلمة مروره بنفسه — أُلغيت ${others.rowCount} جلسة أخرى` });
  return { ok: true, other_sessions_revoked: others.rowCount, must_change_password: false };
}

async function getUserFromToken(client, token) {
  if (!token) return null;
  // to_jsonb(u)->'permissions' يتحمّل غياب العمود (قاعدة لم تُطبَّق عليها الهجرة بعد)
  const result = await client.query(
    `select u.id, u.name, u.phone, u.email, u.role, to_jsonb(u)->'permissions' as permissions,
            to_jsonb(u)->>'must_change_password' as must_change_password
     from app_sessions s
     join app_users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and u.is_active = true
       and (to_jsonb(s)->>'revoked_at') is null
     limit 1`,
    [sha256(token)]
  );
  return publicUser(result.rows[0]);
}

async function login(client, payload) {
  const identifier = String(payload.identifier || "").trim();
  const code = String(payload.code || "").trim();
  if (!identifier || !code) {
    const err = new Error("اسم المستخدم وكود الدخول مطلوبة");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `select u.id, u.name, u.phone, u.email, u.role, u.login_code_hash, to_jsonb(u)->'permissions' as permissions,
            to_jsonb(u)->>'must_change_password' as must_change_password
     from app_users u
     where u.is_active = true and (u.email = $1 or u.phone = $1 or u.name = $1)
     limit 1`,
    [identifier]
  );
  const user = result.rows[0];
  const check = verifyLoginCode(code, user && user.login_code_hash);
  if (!user || !check.ok) {
    const err = new Error("بيانات الدخول غير صحيحة");
    err.statusCode = 401;
    throw err;
  }
  // ترقية الصيغة القديمة إلى scrypt بصمت
  if (check.legacy) await client.query("update app_users set login_code_hash=$2 where id=$1", [user.id, hashLoginCode(code)]);
  const persistent = payload.remember === true;
  const token = crypto.randomBytes(32).toString("hex");
  const expires = persistent ? `${SESSION_PERSISTENT_DAYS} days` : `${SESSION_SHORT_HOURS} hours`;
  const s = await client.query(
    `insert into app_sessions (user_id, token_hash, expires_at, persistent) values ($1, $2, now() + $3::interval, $4) returning expires_at`,
    [user.id, sha256(token), expires, persistent]
  );
  // token يُعاد للمعالج فقط ليضعه في كوكي HttpOnly — لا يُرسل في جسم الاستجابة
  return { token, user: publicUser(user), persistent, expires_at: s.rows[0].expires_at };
}

async function requireDefaultAccount(client, accountName) {
  const name = String(accountName || "الحساب الرسمي").trim() || "الحساب الرسمي";
  const exact = await client.query(
    "select id from bank_accounts where name = $1 and is_active = true order by created_at asc limit 1",
    [name]
  );
  if (exact.rows[0]) return exact.rows[0].id;
  const type = name === "الحساب الفرعي" ? "secondary" : name === "كاش" ? "cash" : "official";
  const found = await client.query(
    "select id from bank_accounts where account_type = $1 and name = $2 and is_active = true order by created_at asc limit 1",
    [type, name]
  );
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await client.query(
    "insert into bank_accounts (name, account_type) values ($1, $2) returning id",
    [name, type]
  );
  return inserted.rows[0].id;
}

async function listChartAccounts(client, onlyPostable = false) {
  const result = await client.query(`
    select id, code, name_ar, level, parent_code, account_type, normal_balance,
           original_row_number, is_postable, is_active, created_at, updated_at
    from chart_accounts
    order by coalesce(original_row_number, 999999), level asc, code asc, created_at asc
  `);
  const accounts = addChartAccountPaths(result.rows.map(chartAccountRow));
  return onlyPostable ? accounts.filter(account => account.is_active && account.is_postable) : accounts;
}

function addChartAccountPaths(accounts) {
  const rows = accounts.slice().sort((a, b) => {
    const ar = a.original_row_number ?? 999999;
    const br = b.original_row_number ?? 999999;
    return ar - br || a.level - b.level || String(a.code).localeCompare(String(b.code));
  });
  const previousByLevelCode = new Map();
  const byId = new Map();
  for (const account of rows) {
    let parent = null;
    if (account.level > 1 && account.parent_code) {
      for (let level = account.level - 1; level >= 1 && !parent; level -= 1) {
        const key = `${level}:${account.parent_code}`;
        const candidates = previousByLevelCode.get(key) || [];
        parent = candidates[candidates.length - 1] || null;
      }
    }
    const parentPath = parent ? parent.full_path : "";
    account.full_path = parentPath ? `${parentPath} > ${account.name_ar}` : account.name_ar;
    byId.set(account.id, account);
    const key = `${account.level}:${account.code}`;
    if (!previousByLevelCode.has(key)) previousByLevelCode.set(key, []);
    previousByLevelCode.get(key).push(account);
  }
  return accounts.map(account => byId.get(account.id) || account);
}

function chartAccountDuplicateWarnings(accounts) {
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
        level: account.level,
        parent_code: account.parent_code,
        full_path: account.full_path || account.name_ar,
      })),
    }));
}

async function validatePostableChartAccount(client, chartAccountId) {
  const id = String(chartAccountId || "").trim();
  if (!id) {
    const err = new Error("الحساب المحاسبي مطلوب");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `select id, code, name_ar, level, parent_code, account_type, normal_balance,
            original_row_number, is_postable, is_active, created_at, updated_at
     from chart_accounts
     where id = $1
     limit 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error("الحساب المحاسبي غير موجود في الدليل المعتمد");
    err.statusCode = 400;
    throw err;
  }
  if (!row.is_active) {
    const err = new Error("الحساب المحاسبي موقوف. اختر حساباً نشطاً.");
    err.statusCode = 400;
    throw err;
  }
  if (!row.is_postable) {
    const err = new Error("هذا الحساب رئيسي ولا يمكن الترحيل عليه. اختر حساباً فرعياً قابلاً للترحيل.");
    err.statusCode = 400;
    throw err;
  }
  return chartAccountRow(row);
}

async function importChartAccounts(client, payload) {
  const rows = Array.isArray(payload.accounts) ? payload.accounts : [];
  if (!rows.length) {
    const err = new Error("لا توجد حسابات للاستيراد");
    err.statusCode = 400;
    throw err;
  }
  const normalized = rows.map(validateChartAccountPayload);
  const codes = new Set(normalized.map(account => account.code));
  for (const account of normalized) {
    if (account.level > 1 && !codes.has(account.parent_code)) {
      const err = new Error("حساب فرعي بدون أب صحيح: " + account.code);
      err.statusCode = 400;
      throw err;
    }
  }

  await client.query("begin");
  try {
    await client.query("delete from chart_accounts");
    const byLevel = normalized.slice().sort((a, b) => {
      const ar = a.original_row_number ?? 999999;
      const br = b.original_row_number ?? 999999;
      return a.level - b.level || ar - br || a.code.localeCompare(b.code);
    });
    for (const account of byLevel) {
      await client.query(
        `insert into chart_accounts
          (code, name_ar, level, parent_code, original_row_number, account_type, normal_balance, is_postable, is_active, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
        [
          account.code,
          account.name_ar,
          account.level,
          account.parent_code,
          account.original_row_number,
          account.account_type,
          account.normal_balance,
          account.is_postable,
          account.is_active,
        ]
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  const accounts = await listChartAccounts(client);
  return { accounts, warnings: chartAccountDuplicateWarnings(accounts) };
}

async function listFinance(client) {
  const result = await client.query(`
    select
      f.*,
      b.name as account_name,
      u.name as entered_by_name,
      ru.name as related_person,
      a.file_name as attachment_name
    from finance_entries f
    left join bank_accounts b on b.id = f.account_id
    left join app_users u on u.id = f.entered_by
    left join app_users ru on ru.id = f.related_user_id
    left join lateral (
      select file_name
      from attachments
      where owner_type = 'finance_entry' and owner_id = f.id
      order by created_at desc
      limit 1
    ) a on true
    order by f.created_at desc
    limit 100
  `);
  return result.rows.map(financeRow);
}

async function listQuoteStates(client) {
  const result = await client.query(`
    select local_key, quote_confirmed, tax_invoice_issued, stage, install_date::text, assigned_to, notes
    from daftra_quote_states
  `);
  return Object.fromEntries(result.rows.map((row) => [row.local_key, quoteStateRow(row)]));
}

async function saveQuoteState(client, payload, user) {
  const localKey = String(payload.id || payload.local_key || "").trim();
  if (!localKey) {
    const err = new Error("معرف عرض دفترة مطلوب");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `insert into daftra_quote_states
      (local_key, daftra_estimate_id, daftra_invoice_id, daftra_client_id, quote_confirmed,
       tax_invoice_issued, stage, install_date, assigned_to, notes, updated_by, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     on conflict (local_key)
     do update set
       daftra_estimate_id = excluded.daftra_estimate_id,
       daftra_invoice_id = excluded.daftra_invoice_id,
       daftra_client_id = excluded.daftra_client_id,
       quote_confirmed = excluded.quote_confirmed,
       tax_invoice_issued = excluded.tax_invoice_issued,
       stage = excluded.stage,
       install_date = excluded.install_date,
       assigned_to = excluded.assigned_to,
       notes = excluded.notes,
       updated_by = excluded.updated_by,
       updated_at = now()
     returning local_key, quote_confirmed, tax_invoice_issued, stage, install_date::text, assigned_to, notes`,
    [
      localKey,
      payload.daftraEstId || payload.daftra_estimate_id || null,
      payload.daftraInvId || payload.daftra_invoice_id || null,
      payload.daftraClientId || payload.daftra_client_id || null,
      Boolean(payload.quoteConfirmed || payload.quote_confirmed),
      Boolean(payload.taxInvoiceIssued || payload.tax_invoice_issued),
      payload.stage || "عرض_سعر",
      payload.installDate || payload.install_date || null,
      payload.assignedTo || payload.assigned_to || null,
      payload.notes || null,
      user?.id || null,
    ]
  );
  return quoteStateRow(result.rows[0]);
}

async function saveAttachment(client, ownerType, ownerId, attachment, mimeType) {
  const fileName = String(attachment || "").trim().slice(0, 240);
  if (!fileName) return;
  await client.query(
    `insert into attachments (owner_type, owner_id, file_name, file_path, mime_type)
     values ($1, $2, $3, $4, $5)`,
    [ownerType, ownerId, fileName, "pending-local-upload/" + fileName, mimeType || null]
  );
}

async function listStaffDocs(client) {
  const result = await client.query(`
    select sd.id, sd.employee_name, sd.document_type, sd.expires_on::text, sd.notes, a.file_name as attachment_name
    from staff_documents sd
    left join lateral (
      select file_name
      from attachments
      where owner_type = 'staff_doc' and owner_id = sd.id
      order by created_at desc
      limit 1
    ) a on true
    order by expires_on asc, created_at desc
  `);
  return result.rows.map(staffDocRow);
}

async function createStaffDoc(client, payload) {
  const name = String(payload.name || "").trim();
  const type = DOC_TYPE_MAP[payload.type] || payload.document_type;
  const expires = String(payload.expires || payload.expires_on || "").trim();
  if (!name || !type || !expires) {
    const err = new Error("اسم الموظف ونوع المستند وتاريخ الانتهاء مطلوبة");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `insert into staff_documents (employee_name, document_type, expires_on, notes)
     values ($1, $2, $3, $4)
     returning id, employee_name, document_type, expires_on::text, notes`,
    [name, type, expires, payload.note || payload.notes || null]
  );
  await saveAttachment(client, "staff_doc", result.rows[0].id, payload.attachment, payload.mime_type);
  return { ...staffDocRow(result.rows[0]), attachment: String(payload.attachment || "") };
}

async function deleteStaffDoc(client, id) {
  const result = await client.query("delete from staff_documents where id = $1 returning id", [id]);
  return Boolean(result.rows[0]);
}

async function listVehicleTasks(client) {
  const result = await client.query(`
    select
      vt.id,
      vt.vehicle_id,
      v.name as vehicle_name,
      vt.task_type,
      vt.due_on::text,
      vt.due_odometer,
      vt.notes,
      a.file_name as attachment_name
    from vehicle_tasks vt
    join vehicles v on v.id = vt.vehicle_id
    left join lateral (
      select file_name
      from attachments
      where owner_type = 'vehicle' and owner_id = vt.id
      order by created_at desc
      limit 1
    ) a on true
    where vt.status = 'open'
    order by vt.due_on asc nulls last, vt.created_at desc
  `);
  return result.rows.map(vehicleTaskRow);
}

async function requireVehicle(client, name) {
  const found = await client.query("select id from vehicles where name = $1 and is_active = true limit 1", [name]);
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await client.query("insert into vehicles (name) values ($1) returning id", [name]);
  return inserted.rows[0].id;
}

async function createVehicleTask(client, payload) {
  const name = String(payload.name || "").trim();
  const type = VEHICLE_TASK_MAP[payload.type] || payload.task_type;
  const due = String(payload.due || payload.due_on || "").trim();
  if (!name || !type || !due) {
    const err = new Error("اسم السيارة ونوع التنبيه وتاريخ الاستحقاق مطلوبة");
    err.statusCode = 400;
    throw err;
  }
  const vehicleId = await requireVehicle(client, name);
  const odometerValue = Number(String(payload.odometer || "").replace(/[^\d]/g, ""));
  const hasNumericOdometer = Number.isFinite(odometerValue) && odometerValue > 0;
  const result = await client.query(
    `insert into vehicle_tasks (vehicle_id, task_type, due_on, due_odometer, notes)
     values ($1, $2, $3, $4, $5)
     returning id, vehicle_id, task_type, due_on::text, due_odometer, notes`,
    [vehicleId, type, due, hasNumericOdometer ? odometerValue : null, hasNumericOdometer ? null : payload.odometer || null]
  );
  await saveAttachment(client, "vehicle", result.rows[0].id, payload.attachment, payload.mime_type);
  return { ...vehicleTaskRow({ ...result.rows[0], vehicle_name: name }), attachment: String(payload.attachment || "") };
}

async function deleteVehicleTask(client, id) {
  const result = await client.query(
    "update vehicle_tasks set status = 'cancelled' where id = $1 returning id",
    [id]
  );
  return Boolean(result.rows[0]);
}

async function listGeneralAlerts(client) {
  try {
    const result = await client.query(`
      select ga.id, ga.title, ga.due_on::text, ga.notes, ga.status, a.file_name as attachment_name
      from general_alerts ga
      left join lateral (
        select file_name
        from attachments
        where owner_type = 'general_alert' and owner_id = ga.id
        order by created_at desc
        limit 1
      ) a on true
      where ga.status = 'open'
      order by ga.due_on asc, ga.created_at desc
    `);
    return result.rows.map(generalAlertRow);
  } catch (err) {
    if (err.code === "42P01") return [];
    throw err;
  }
}

async function createGeneralAlert(client, payload) {
  const title = String(payload.title || "").trim();
  const due = String(payload.due || payload.due_on || "").trim();
  if (!title || !due) {
    const err = new Error("اسم التنبيه وتاريخ التنبيه مطلوبة");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `insert into general_alerts (title, due_on, notes)
     values ($1, $2, $3)
     returning id, title, due_on::text, notes, status`,
    [title, due, payload.note || payload.notes || null]
  );
  await saveAttachment(client, "general_alert", result.rows[0].id, payload.attachment, payload.mime_type);
  return { ...generalAlertRow(result.rows[0]), attachment: String(payload.attachment || "") };
}

async function deleteGeneralAlert(client, id) {
  const result = await client.query(
    "update general_alerts set status = 'cancelled' where id = $1 returning id",
    [id]
  );
  return Boolean(result.rows[0]);
}

async function listTenders(client) {
  const result = await client.query(`
    select id, title, entity_name, source_name, source_url, external_key, matched_keyword,
           opportunity_type, due_on::text, fit_status, fit_reason, decision,
           suggested_action, follow_status, last_seen_at, created_at
    from tenders
    order by created_at desc
    limit 200
  `);
  return result.rows.map(tenderRow);
}

async function createTender(client, payload) {
  const title = String(payload.title || "").trim();
  if (!title) {
    const err = new Error("عنوان المنافسة مطلوب");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `insert into tenders
      (title, entity_name, source_name, source_url, external_key, matched_keyword, opportunity_type,
       due_on, fit_status, fit_reason, suggested_action, follow_status, decision)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id, title, entity_name, source_name, source_url, external_key, matched_keyword,
               opportunity_type, due_on::text, fit_status, fit_reason, decision,
               suggested_action, follow_status, last_seen_at, created_at`,
    [
      title,
      payload.entity || payload.entity_name || null,
      payload.platform || payload.source_name || null,
      payload.url || payload.source_url || null,
      payload.externalKey || payload.external_key || null,
      payload.keyword || payload.matched_keyword || null,
      payload.type || payload.opportunity_type || "tender",
      payload.due || payload.due_on || null,
      TENDER_STATUS_MAP[payload.score] || payload.fit_status || "review",
      payload.reason || payload.fit_reason || null,
      payload.action || payload.suggested_action || null,
      payload.followStatus || payload.follow_status || "new",
      payload.decision || null,
    ]
  );
  return tenderRow(result.rows[0]);
}

async function updateTenderScore(client, payload) {
  const id = String(payload.id || "").trim();
  const status = TENDER_STATUS_MAP[payload.score] || payload.fit_status;
  if (!id || !["fit", "not_fit", "review"].includes(status)) {
    const err = new Error("بيانات تقييم المنافسة غير صحيحة");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `update tenders
     set fit_status = $1
     where id = $2
     returning id, title, entity_name, source_name, source_url, external_key, matched_keyword,
               opportunity_type, due_on::text, fit_status, fit_reason, decision,
               suggested_action, follow_status, last_seen_at, created_at`,
    [status, id]
  );
  if (!result.rows[0]) {
    const err = new Error("المنافسة غير موجودة");
    err.statusCode = 404;
    throw err;
  }
  return tenderRow(result.rows[0]);
}

async function deleteTender(client, id) {
  const result = await client.query("delete from tenders where id = $1 returning id", [id]);
  return Boolean(result.rows[0]);
}

function textIncludesAny(text, words) {
  const value = String(text || "").toLowerCase();
  return words.some((word) => value.includes(String(word).toLowerCase()));
}

function radarTenderFit(item, keyword) {
  const text = [item.tenderName, item.tenderActivityName, item.agencyName, item.tenderTypeName].filter(Boolean).join(" ");
  if (textIncludesAny(text, RADAR_NEGATIVE_WORDS)) return null;
  // فحص الكلمات المشروطة
  for (const rule of RADAR_CONDITIONAL_NEGATIVE) {
    if (textIncludesAny(text, [rule.trigger])) {
      if (!rule.allowIf.length || !textIncludesAny(text, rule.allowIf)) return null;
    }
  }
  const strong = textIncludesAny(text, ["خيام أوروبية","خيام اوروبية","خيمة أوروبية","تأجير خيام","توريد خيام"]);
  const medium = textIncludesAny(text, ["خيام","خيمة","خيم","مخيم"]);
  const event = textIncludesAny(text, ["فعاليات","مؤتمرات","معارض","ضيافة","استقبال","مهرجان"]);
  if (!strong && !medium && !event) return null;
  return {
    status: strong ? "fit" : medium ? "review" : "review",
    action: strong ? "تجهيز عرض سعر" : "مراجعة الرابط",
    reason: strong
      ? `مطابقة قوية — ${keyword}: ${item.tenderActivityName || item.tenderTypeName || ""}`
      : `فرصة محتملة — ${keyword}: ${item.tenderActivityName || item.tenderTypeName || ""}`,
  };
}

async function claudeAnalyzeTender(item) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey });
    const text = `
عنوان المنافسة: ${item.tenderName || ""}
الجهة: ${item.agencyName || item.branchName || ""}
نوع النشاط: ${item.tenderActivityName || ""}
نوع المنافسة: ${item.tenderTypeName || ""}
آخر موعد: ${item.lastOfferPresentationDate || "غير محدد"}
`.trim();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `أنت مساعد لشركة واحة الخيمة المتخصصة في تأجير الخيام الأوروبية الفاخرة للفعاليات والمهرجانات في السعودية.

${text}

هل هذه المنافسة مناسبة لشركتنا؟ أجب بـ JSON فقط بدون أي نص إضافي:
{"status":"fit"|"review"|"not_fit","score":1-10,"reason":"سبب مختصر بالعربي بجملة واحدة","action":"الإجراء المقترح"}

fit = مناسبة جداً، review = تحتاج مراجعة، not_fit = غير مناسبة`
      }]
    });
    const raw = msg.content[0]?.text?.trim() || "";
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : null;
  } catch (e) {
    return null;
  }
}

function etimadSearchUrl(keyword) {
  const params = new URLSearchParams({
    PageNumber: "1",
    PageSize: "10",
    IsSearch: "true",
    multipleSearch: keyword,
  });
  return `https://tenders.etimad.sa/Tender/AllTendersForVisitor?${params.toString()}`;
}

async function fetchEtimadKeyword(keyword) {
  const params = new URLSearchParams({
    PageNumber: "1",
    PageSize: "10",
    IsSearch: "true",
    multipleSearch: keyword,
  });
  const url = `https://tenders.etimad.sa/Tender/AllSupplierTendersForVisitorAsync?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://tenders.etimad.sa/Tender",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "WahetKhaimaRadar/1.0",
    },
  });
  if (!response.ok) throw new Error(`فشل جلب اعتماد لكلمة ${keyword}`);
  const text = await response.text();
  if (!text.trim().startsWith("{")) {
    throw new Error(`رد اعتماد غير متوقع لكلمة ${keyword}`);
  }
  const data = JSON.parse(text);
  return Array.isArray(data.data) ? data.data : [];
}

async function scanEtimadTenders(client) {
  const seen = new Map();
  const errors = [];
  for (const keyword of RADAR_KEYWORDS) {
    try {
      const rows = await fetchEtimadKeyword(keyword);
      for (const item of rows) {
        const key = `etimad:${item.tenderId || item.referenceNumber || item.tenderNumber}`;
        if (!key || seen.has(key)) continue;
        const fit = radarTenderFit(item, keyword);
        if (!fit) continue;
        seen.set(key, { item, keyword, fit });
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  const saved = [];
  const useAI = !!process.env.ANTHROPIC_API_KEY;
  for (const { item, keyword, fit } of seen.values()) {
    const externalKey = `etimad:${item.tenderId || item.referenceNumber || item.tenderNumber}`;
    const sourceUrl = etimadSearchUrl(keyword);
    // تحليل Claude إذا كان المفتاح موجود
    let finalFit = fit;
    if (useAI) {
      const ai = await claudeAnalyzeTender(item);
      if (ai) {
        finalFit = {
          status: ai.status,
          action: ai.action || fit.action,
          reason: `🤖 رادار كلود: ${ai.reason} (درجة ${ai.score}/10)`,
        };
      }
    }
    const result = await client.query(
      `insert into tenders
        (title, entity_name, source_name, source_url, external_key, matched_keyword,
         opportunity_type, due_on, fit_status, fit_reason, suggested_action, follow_status, decision, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, 'tender', $7, $8, $9, $10, 'new', $11, now())
       on conflict (external_key) where external_key is not null
       do update set
         source_url = excluded.source_url,
         matched_keyword = excluded.matched_keyword,
         fit_status = case when tenders.fit_status = 'not_fit' then tenders.fit_status else excluded.fit_status end,
         fit_reason = excluded.fit_reason,
         suggested_action = excluded.suggested_action,
         last_seen_at = now()
       returning id, title, entity_name, source_name, source_url, external_key, matched_keyword,
                 opportunity_type, due_on::text, fit_status, fit_reason, decision,
                 suggested_action, follow_status, last_seen_at, created_at`,
      [
        item.tenderName || "منافسة اعتماد",
        item.agencyName || item.branchName || "",
        useAI ? "رادار كلود" : "اعتماد",
        sourceUrl,
        externalKey,
        keyword,
        item.lastOfferPresentationDate ? String(item.lastOfferPresentationDate).slice(0, 10) : null,
        finalFit.status,
        `${finalFit.reason} — رقم: ${item.referenceNumber || item.tenderNumber || item.tenderId}`,
        finalFit.action,
        `نشاط: ${item.tenderActivityName || "غير محدد"}`,
      ]
    );
    saved.push(tenderRow(result.rows[0]));
  }

  return { saved, errors, keywords: RADAR_KEYWORDS, ai: useAI };
}

async function getSetting(client, key) {
  const result = await client.query("select value from app_settings where key = $1", [key]);
  return result.rows[0]?.value || null;
}

async function setSetting(client, key, value) {
  const result = await client.query(
    `insert into app_settings (key, value, updated_at)
     values ($1, $2::jsonb, now())
     on conflict (key)
     do update set value = excluded.value, updated_at = now()
     returning value`,
    [key, JSON.stringify(value)]
  );
  return result.rows[0].value;
}

function publicDaftraSettings(settings) {
  if (!settings || typeof settings !== "object") return null;
  return {
    subdomain: settings.subdomain || "",
    proxyUrl: settings.proxyUrl || "/api/daftra",
    hasKey: Boolean(settings.apikey),
  };
}

async function getDaftraClientsCache(client) {
  const cache = await getSetting(client, "daftra_clients_cache");
  if (!cache || !Array.isArray(cache.clients)) {
    return { clients: [], syncedAt: null, counts: { estimates: 0, invoices: 0 } };
  }
  return {
    clients: cache.clients,
    syncedAt: cache.syncedAt || null,
    counts: cache.counts || { estimates: 0, invoices: 0 },
  };
}

async function setDaftraClientsCache(client, payload) {
  const clients = Array.isArray(payload.clients) ? payload.clients.slice(0, 1000) : [];
  const counts = payload.counts && typeof payload.counts === "object" ? payload.counts : {};
  const cache = {
    clients,
    syncedAt: payload.syncedAt || new Date().toISOString(),
    counts: {
      estimates: Number(counts.estimates) || 0,
      invoices: Number(counts.invoices) || 0,
    },
  };
  return setSetting(client, "daftra_clients_cache", cache);
}

async function getDaftraFinanceCache(client) {
  const cache = await getSetting(client, "daftra_finance_cache");
  if (!cache || typeof cache !== "object") {
    return { expenses: [], custodies: [], payments: [], accounts: [], syncedAt: null, counts: { expenses: 0, custodies: 0, payments: 0, accounts: 0 }, errors: [] };
  }
  return {
    expenses: Array.isArray(cache.expenses) ? cache.expenses : [],
    custodies: Array.isArray(cache.custodies) ? cache.custodies : [],
    payments: Array.isArray(cache.payments) ? cache.payments : [],
    accounts: Array.isArray(cache.accounts) ? cache.accounts : [],
    syncedAt: cache.syncedAt || null,
    counts: cache.counts || { expenses: 0, custodies: 0, payments: 0, accounts: 0 },
    errors: Array.isArray(cache.errors) ? cache.errors : [],
  };
}

async function setDaftraFinanceCache(client, payload) {
  const counts = payload.counts && typeof payload.counts === "object" ? payload.counts : {};
  const cache = {
    expenses: Array.isArray(payload.expenses) ? payload.expenses.slice(0, 2000) : [],
    custodies: Array.isArray(payload.custodies) ? payload.custodies.slice(0, 1000) : [],
    payments: Array.isArray(payload.payments) ? payload.payments.slice(0, 2000) : [],
    accounts: Array.isArray(payload.accounts) ? payload.accounts.slice(0, 500) : [],
    syncedAt: payload.syncedAt || new Date().toISOString(),
    counts: {
      expenses: Number(counts.expenses) || 0,
      custodies: Number(counts.custodies) || 0,
      payments: Number(counts.payments) || 0,
      accounts: Number(counts.accounts) || 0,
    },
    errors: Array.isArray(payload.errors) ? payload.errors.slice(0, 20) : [],
  };
  return setSetting(client, "daftra_finance_cache", cache);
}

function daftraCapabilityRow(key, label, result, count, statusOverride) {
  const supported = !result.error;
  let status = statusOverride || (supported ? "supported" : "error");
  const message = result.error || "";
  if (/not found|404|invalid endpoint/i.test(message)) status = "unsupported";
  if (/unauthor|forbidden|401|403|permission|صلاح/i.test(message)) status = "unauthorized";
  return {
    key,
    label,
    status,
    endpoint: result.base || "",
    count: Number(count) || 0,
    lastSuccessAt: supported ? new Date().toISOString() : null,
    lastErrorAt: supported ? null : new Date().toISOString(),
    lastError: message,
  };
}

async function getDaftraCapabilities(client) {
  const saved = await getSetting(client, "daftra_capabilities");
  if (!saved || typeof saved !== "object") {
    return { checkedAt: null, sources: [] };
  }
  return {
    checkedAt: saved.checkedAt || null,
    sources: Array.isArray(saved.sources) ? saved.sources : [],
  };
}

async function setDaftraCapabilities(client, sources) {
  return setSetting(client, "daftra_capabilities", {
    checkedAt: new Date().toISOString(),
    sources: Array.isArray(sources) ? sources : [],
  });
}

async function getBankStatementCache(client) {
  const cache = await getSetting(client, "bank_statement_cache");
  if (!cache || !Array.isArray(cache.rows)) {
    return { rows: [], month: null, fileName: "", sourceType: "", savedAt: null, analysis: null };
  }
  return {
    rows: cache.rows.slice(0, 2000),
    month: cache.month || null,
    fileName: cache.fileName || "",
    sourceType: cache.sourceType || "",
    savedAt: cache.savedAt || null,
    analysis: cache.analysis || null,
  };
}

async function setBankStatementCache(client, payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 2000) : [];
  const cache = {
    rows,
    month: payload.month || null,
    fileName: String(payload.fileName || "").slice(0, 240),
    sourceType: String(payload.sourceType || "").slice(0, 40),
    savedAt: payload.savedAt || new Date().toISOString(),
    analysis: payload.analysis || null,
  };
  return setSetting(client, "bank_statement_cache", cache);
}

async function getFinanceMeta(client) {
  const meta = await getSetting(client, "finance_meta");
  if (!meta || typeof meta !== "object") return { bankAccounts: [], custodySpends: {} };
  return {
    bankAccounts: Array.isArray(meta.bankAccounts) ? meta.bankAccounts : [],
    custodySpends: meta.custodySpends && typeof meta.custodySpends === "object" ? meta.custodySpends : {},
    updatedAt: meta.updatedAt || null,
  };
}

async function setFinanceMeta(client, payload) {
  const meta = {
    bankAccounts: Array.isArray(payload.bankAccounts) ? payload.bankAccounts : [],
    custodySpends: payload.custodySpends && typeof payload.custodySpends === "object" ? payload.custodySpends : {},
    updatedAt: new Date().toISOString(),
  };
  return setSetting(client, "finance_meta", meta);
}

async function syncDaftraClientsCache(client) {
  const cfg = await getSetting(client, "daftra");
  if (!cfg?.subdomain || !cfg?.apikey) {
    const err = new Error("إعدادات دفترة غير مكتملة");
    err.statusCode = 400;
    throw err;
  }

  async function requestDaftra(endpoint) {
    const url = `https://${cfg.subdomain}.daftra.com/api2/${endpoint}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        APIKEY: cfg.apikey,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || data.message || `فشل طلب دفترة: ${endpoint}`);
    }
    return data;
  }

  async function fetchPages(base) {
    const rows = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await requestDaftra(`${base}.json?limit=100&page=${page}`);
      const batch = data?.data || [];
      rows.push(...batch);
      if (batch.length < 100) break;
    }
    return rows;
  }

  async function fetchOptionalPages(base, label) {
    try {
      return { rows: await fetchPages(base), error: null, base, label };
    } catch (err) {
      return { rows: [], error: `${label}: ${err.message}`, base, label };
    }
  }

  async function fetchFirstAvailable(candidates, label) {
    const errors = [];
    for (const base of candidates) {
      const result = await fetchOptionalPages(base, label);
      if (!result.error) return result;
      errors.push(result.error);
    }
    return { rows: [], error: errors.join(" | "), base: candidates[0], label };
  }

  const unsupportedCustodiesResult = { rows: [], error: "العهد غير متاحة حالياً من API دفترة بالمسارات المختبرة", base: "غير معتمد", label: "العهد" };
  const unsupportedPaymentsResult = { rows: [], error: "المدفوعات غير متاحة حالياً كمسار مستقل؛ يتم الاعتماد على بيانات الفاتورة إن رجعت المدفوع والمتبقي", base: "غير معتمد", label: "المدفوعات" };
  const [estimates, invoices, quoteStates, expensesResult, accountsResult] = await Promise.all([
    fetchPages("estimates"),
    fetchPages("invoices"),
    listQuoteStates(client),
    fetchOptionalPages("expenses", "المصروفات"),
    fetchOptionalPages("treasuries", "الأرصدة"),
  ]);
  const merged = [];

  estimates.forEach((item) => {
    const est = item.Estimate || item;
    const hasInvoice = invoices.some((row) => {
      const inv = row.Invoice || row;
      return String(inv.estimate_id || inv.estimateId || "") === String(est.id);
    });
    if (hasInvoice) return;

    const total = moneyNumber(est.summary_total || est.total);
    const created = firstDate(est.date, est.created_at, est.created);
    const updatedAt = firstDate(est.updated_at, est.modified, est.modified_at, est.last_modified, est.last_update, est.date);
    const card = {
      id: `est_${est.id}`,
      daftraEstId: est.id,
      daftraClientId: est.client_id,
      name: est.client_business_name || est.client_first_name || "عميل",
      phone: est.client_phone || "",
      products: "—",
      location: est.client_state || "",
      offerPrice: total,
      deposit: 0,
      remaining: total,
      quoteConfirmed: false,
      taxInvoiceIssued: false,
      stage: "عرض_سعر",
      installDate: "",
      notes: "",
      assignedTo: "—",
      created,
      updatedAt,
      followupDate: updatedAt || created,
      source: "daftra",
      daftraNo: est.no,
      daftraDetails: daftraDetailsFrom(est, item),
    };
    Object.assign(card, quoteStates[card.id] || {});
    if (card.quoteConfirmed && card.stage === "عرض_سعر") card.stage = "موافق";
    merged.push(card);
  });

  invoices.forEach((item) => {
    const inv = item.Invoice || item;
    const relatedEstimateId = inv.estimate_id || inv.estimateId || inv.Estimate?.id || "";
    const existing = merged.find(
      (card) =>
        (relatedEstimateId && String(card.daftraEstId || "") === String(relatedEstimateId)) ||
        (card.daftraInvId && String(card.daftraInvId) === String(inv.id))
    );
    const total = moneyNumber(inv.summary_total || inv.total);
    const details = daftraDetailsFrom(inv, item);
    const paid = moneyNumber(details.totals?.paid);
    const balance = moneyNumber(details.totals?.balance);
    const created = firstDate(inv.date, inv.created_at, inv.created);
    const updatedAt = firstDate(inv.updated_at, inv.modified, inv.modified_at, inv.last_modified, inv.last_update, inv.date);
    const card = {
      ...(existing || {}),
      id: existing ? existing.id : `inv_${inv.id}`,
      daftraInvId: inv.id,
      daftraClientId: inv.client_id,
      name: inv.client_business_name || inv.client_first_name || existing?.name || "عميل",
      phone: inv.client_phone || existing?.phone || "",
      products: existing?.products || "—",
      location: inv.client_state || existing?.location || "",
      offerPrice: total,
      deposit: paid,
      remaining: balance || Math.max(0, total - paid),
      quoteConfirmed: true,
      taxInvoiceIssued: true,
      stage: existing?.stage === "تم_التركيب" || existing?.stage === "مكتمل" ? existing.stage : "فاتورة_صادرة",
      installDate: existing?.installDate || "",
      notes: existing?.notes || "",
      assignedTo: existing?.assignedTo || "—",
      created,
      updatedAt,
      followupDate: updatedAt || created,
      source: "daftra",
      daftraNo: inv.no,
      daftraDetails: details,
    };
    Object.assign(card, quoteStates[card.id] || {});
    card.quoteConfirmed = true;
    card.taxInvoiceIssued = true;

    const idx = merged.findIndex(
      (row) =>
        (card.daftraInvId && String(row.daftraInvId || "") === String(card.daftraInvId)) ||
        (relatedEstimateId && String(row.daftraEstId || "") === String(relatedEstimateId))
    );
    if (idx >= 0) merged[idx] = card;
    else merged.push(card);
  });

  const clientsCache = await setDaftraClientsCache(client, {
    clients: merged,
    syncedAt: new Date().toISOString(),
    counts: { estimates: estimates.length, invoices: invoices.length },
  });

  const expenses = expensesResult.rows.map(daftraExpenseFrom).filter((row) => row.id || row.amount || row.date);
  const custodies = [];
  const payments = [];
  const accounts = accountsResult.rows.map(daftraAccountFrom).filter((row) => row.id || row.name || row.balance);
  const financeErrors = [expensesResult.error, unsupportedCustodiesResult.error, unsupportedPaymentsResult.error, accountsResult.error].filter(Boolean);
  const financeCache = await setDaftraFinanceCache(client, {
    expenses,
    custodies,
    payments,
    accounts,
    syncedAt: new Date().toISOString(),
    counts: { expenses: expenses.length, custodies: custodies.length, payments: payments.length, accounts: accounts.length },
    errors: financeErrors,
  });
  const capabilities = await setDaftraCapabilities(client, [
    daftraCapabilityRow("estimates", "عروض الأسعار", { base: "estimates", error: null }, estimates.length),
    daftraCapabilityRow("invoices", "الفواتير", { base: "invoices", error: null }, invoices.length),
    daftraCapabilityRow("expenses", "المصروفات", expensesResult, expenses.length),
    daftraCapabilityRow("custodies", "العهد", unsupportedCustodiesResult, custodies.length, "unsupported"),
    daftraCapabilityRow("payments", "المدفوعات", unsupportedPaymentsResult, payments.length, "unsupported"),
    daftraCapabilityRow("accounts", "الأرصدة/الخزائن", accountsResult, accounts.length),
  ]);

  return {
    ...clientsCache,
    finance: financeCache,
    capabilities,
  };
}

function validateDaftraSettings(payload) {
  const proxyUrl = String(payload.proxyUrl || "").trim();
  const subdomain = String(payload.subdomain || "").trim();
  const apikey = String(payload.apikey || "").trim();
  if (!proxyUrl || !subdomain || !apikey) {
    const err = new Error("رابط دفترة الوسيط وSubdomain ومفتاح API مطلوبة");
    err.statusCode = 400;
    throw err;
  }
  return { proxyUrl, subdomain, apikey };
}

const DAFTRA_SOURCE_TESTS = {
  estimates: { label: "عروض الأسعار", endpoints: ["estimates"] },
  invoices: { label: "الفواتير", endpoints: ["invoices"] },
  expenses: { label: "المصروفات", endpoints: ["expenses"] },
  custodies: { label: "العهد", endpoints: ["employee_custodies", "employee-custodies", "custodies"] },
  payments: { label: "المدفوعات", endpoints: ["payments", "receipts", "transactions"] },
  accounts: { label: "الأرصدة/الخزائن", endpoints: ["treasuries", "bank_accounts", "accounts"] },
};

async function testDaftraSource(client, sourceKey) {
  const source = DAFTRA_SOURCE_TESTS[sourceKey];
  if (!source) {
    const err = new Error("مصدر دفترة غير معروف");
    err.statusCode = 400;
    throw err;
  }
  const cfg = await getSetting(client, "daftra");
  if (!cfg?.subdomain || !cfg?.apikey) {
    const err = new Error("إعدادات دفترة غير مكتملة");
    err.statusCode = 400;
    throw err;
  }
  const errors = [];
  for (const endpoint of source.endpoints) {
    try {
      const url = `https://${cfg.subdomain}.daftra.com/api2/${endpoint}.json?limit=1&page=1`;
      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json", APIKEY: cfg.apikey },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        errors.push(`${endpoint}: ${data.error || data.message || res.status}`);
        continue;
      }
      const rows = Array.isArray(data.data) ? data.data : [];
      return daftraCapabilityRow(sourceKey, source.label, { base: endpoint, error: null }, rows.length);
    } catch (err) {
      errors.push(`${endpoint}: ${err.message}`);
    }
  }
  return daftraCapabilityRow(sourceKey, source.label, { base: source.endpoints[0], error: errors.join(" | ") }, 0);
}

async function createFinance(client, payload, user) {
  const entryType = TYPE_MAP[payload.type] || payload.entry_type;
  if (!entryType || !Object.values(TYPE_MAP).includes(entryType)) {
    const err = new Error("نوع الحركة غير صحيح");
    err.statusCode = 400;
    throw err;
  }
  const amount = moneyNumber(payload.amount);
  if (amount <= 0) {
    const err = new Error("المبلغ مطلوب");
    err.statusCode = 400;
    throw err;
  }
  if (!String(payload.note || payload.statement || "").trim()) {
    const err = new Error("البيان مطلوب");
    err.statusCode = 400;
    throw err;
  }

  await client.query("begin");
  try {
    const chartAccount = await validatePostableChartAccount(client, payload.chartAccountId);
    const accountId = await requireDefaultAccount(client, payload.account || "الحساب الرسمي");
    let relatedUserId = null;
    if (payload.person) {
      const user = await client.query(
        "select id from app_users where name = $1 limit 1",
        [payload.person]
      );
      relatedUserId = user.rows[0]?.id || null;
    }

    const requestedStatus = String(payload.status || "").trim();
    const canAutoApprove = payload.autoApprove === true && user && ["owner", "accountant", "viewer"].includes(user.role);
    const initialStatus = canAutoApprove && requestedStatus === "approved" ? "approved" : "draft";
    const inserted = await client.query(
      `insert into finance_entries
        (entry_type, amount, account_id, related_user_id, chart_account_id, category, statement, status, entry_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, current_date)
       returning *`,
      [entryType, amount, accountId, relatedUserId, chartAccount.id, `${chartAccount.code} - ${chartAccount.name_ar}`, String(payload.note || payload.statement).trim(), initialStatus]
    );
    if (user?.id) {
      await client.query("update finance_entries set entered_by = $1 where id = $2", [user.id, inserted.rows[0].id]);
    }
    if (initialStatus === "approved" && user?.id) {
      await client.query("update finance_entries set approved_by = $1, approved_at = now() where id = $2", [user.id, inserted.rows[0].id]);
    }

    if (payload.attachment) {
      await client.query(
        `insert into attachments (owner_type, owner_id, file_name, file_path, mime_type)
         values ('finance_entry', $1, $2, $3, $4)`,
        [
          inserted.rows[0].id,
          String(payload.attachment).slice(0, 240),
          "pending-local-upload/" + String(payload.attachment).slice(0, 240),
          payload.mime_type || null,
        ]
      );
    }

    await client.query("commit");
    const rows = await listFinance(client);
    return rows.find((row) => row.id === inserted.rows[0].id) || financeRow(inserted.rows[0]);
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function updateFinanceStatus(client, payload, user) {
  if (!user || !["owner", "accountant", "viewer"].includes(user.role)) {
    const err = new Error("ليس لديك صلاحية اعتماد الحركات المالية");
    err.statusCode = 403;
    throw err;
  }
  const id = String(payload.id || "").trim();
  const status = String(payload.status || "").trim();
  if (!id || !["approved", "rejected", "draft"].includes(status)) {
    const err = new Error("بيانات الاعتماد غير صحيحة");
    err.statusCode = 400;
    throw err;
  }
  const result = await client.query(
    `update finance_entries
     set status = $1,
         approved_by = case when $1 in ('approved', 'rejected') then $2::uuid else null end,
         approved_at = case when $1 in ('approved', 'rejected') then now() else null end
     where id = $3
     returning *`,
    [status, user.id, id]
  );
  if (!result.rows[0]) {
    const err = new Error("الحركة غير موجودة");
    err.statusCode = 404;
    throw err;
  }
  const rows = await listFinance(client);
  return rows.find((row) => row.id === id) || financeRow(result.rows[0]);
}

async function updateFinanceEntry(client, payload, user) {
  if (!user || !["owner", "accountant", "viewer"].includes(user.role)) {
    const err = new Error("ليس لديك صلاحية تعديل الحركات المالية");
    err.statusCode = 403;
    throw err;
  }
  const id = String(payload.id || "").trim();
  const amount = moneyNumber(payload.amount);
  if (!id || amount <= 0) {
    const err = new Error("المبلغ أو رقم الحركة غير صحيح");
    err.statusCode = 400;
    throw err;
  }
  const accountId = await requireDefaultAccount(client, payload.account || "الحساب الرسمي");
  const categoryPatch = payload.chartAccountId ? await validatePostableChartAccount(client, payload.chartAccountId) : null;
  const result = await client.query(
    `update finance_entries
     set amount = $1,
         account_id = $2,
         statement = case when $3::text <> '' then $3::text else statement end,
         chart_account_id = coalesce($4::uuid, chart_account_id),
         category = case when $5::text <> '' then $5::text else category end
     where id = $6
     returning *`,
    [amount, accountId, String(payload.note || payload.statement || "").trim(), categoryPatch ? categoryPatch.id : null, categoryPatch ? `${categoryPatch.code} - ${categoryPatch.name_ar}` : "", id]
  );
  if (!result.rows[0]) {
    const err = new Error("الحركة غير موجودة");
    err.statusCode = 404;
    throw err;
  }
  const rows = await listFinance(client);
  return rows.find((row) => row.id === id) || financeRow(result.rows[0]);
}

async function renameBankAccount(client, payload, user) {
  if (!user || !["owner", "accountant", "viewer"].includes(user.role)) {
    const err = new Error("ليس لديك صلاحية تعديل الحسابات البنكية");
    err.statusCode = 403;
    throw err;
  }
  const oldName = String(payload.oldName || "").trim();
  const newName = String(payload.newName || "").trim();
  if (!oldName || !newName) {
    const err = new Error("اسم الحساب القديم والجديد مطلوبان");
    err.statusCode = 400;
    throw err;
  }
  const existing = await client.query(
    "select id from bank_accounts where name = $1 and is_active = true limit 1",
    [oldName]
  );
  if (existing.rows[0]) {
    await client.query("update bank_accounts set name = $1 where id = $2", [newName, existing.rows[0].id]);
  } else {
    await requireDefaultAccount(client, newName);
  }
  return { oldName, newName };
}

/* ─── WhatsApp Intake (M1): استقبال + تطبيع + allowlist + dedup + تخزين ─── */

// تطبيع رقم الهاتف إلى E.164 (موجّه للسعودية أساساً). يُرجع null إن تعذّر.
function normalizePhoneE164(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // تحويل الأرقام العربية/الفارسية إلى لاتينية
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
       .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
  const isIntl = s.startsWith("+") || s.replace(/[^\d+]/g, "").startsWith("00");
  let digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!isIntl) {
    if (/^05\d{8}$/.test(digits)) digits = "966" + digits.slice(1);        // 05XXXXXXXX
    else if (/^5\d{8}$/.test(digits)) digits = "966" + digits;             // 5XXXXXXXX
    else if (digits.startsWith("966")) { /* رمز الدولة موجود */ }
    else return null;                                                       // لا نخمّن رمز دولة مجهول
  }
  if (digits.length < 8 || digits.length > 15) return null;                 // حدود E.164
  return "+" + digits;
}

async function getIntakeAllowlist(client) {
  const setting = await getSetting(client, "intake_allowlist");
  return setting && Array.isArray(setting.members) ? setting.members : [];
}

function findAllowlistMember(members, e164) {
  return members.find((m) => m && m.active !== false && normalizePhoneE164(m.phone) === e164) || null;
}

function computeIntakeDedupHash({ e164, messageTimestamp, amount, originalMessage, attachmentUrl }) {
  const norm = String(originalMessage || "").replace(/\s+/g, " ").trim().toLowerCase();
  return sha256([e164, messageTimestamp || "", amount == null ? "" : String(amount), norm, attachmentUrl || ""].join("|"));
}

async function logAgentAction(client, a) {
  await client.query(
    `insert into agent_actions
       (actor_type, actor_ref, actor_name, agent_role, action, target_type, target_id,
        summary, before_state, after_state, confidence, status, error_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
    [
      a.actorType || "system", a.actorRef || null, a.actorName || null, a.agentRole || null,
      a.action, a.targetType || null, a.targetId || null, a.summary || null,
      a.beforeState != null ? JSON.stringify(a.beforeState) : null,
      a.afterState != null ? JSON.stringify(a.afterState) : null,
      a.confidence == null ? null : a.confidence, a.status || "done",
      a.errorMessage ? String(a.errorMessage).slice(0, 500) : null,
    ]
  );
}

/* ─── إدارة قائمة الموثوقين (M2.6) — owner فقط، بلا migration (app_settings) ─── */
function requireIntakeAdmin(user) {
  if (!user || user.role !== "owner") {
    const e = new Error("إدارة قائمة الموثوقين لمالك النظام فقط");
    e.statusCode = 403; throw e;
  }
}

async function listIntakeAllowlist(client) {
  const members = await getIntakeAllowlist(client);
  return members.map((m) => ({
    phone: normalizePhoneE164(m && m.phone) || String((m && m.phone) || ""),
    name: (m && m.name) || "", active: !(m && m.active === false),
    role: (m && m.role) || "", notes: (m && m.notes) || "",
  }));
}

// إضافة/تعديل/تعطيل عضو. الهوية = الرقم المطبَّع E.164 (الاسم بيان مساعد فقط).
async function upsertIntakeAllowlistMember(client, payload, user) {
  requireIntakeAdmin(user);
  const phone = normalizePhoneE164(payload.phone);
  if (!phone) { const e = new Error("رقم غير صالح (تعذّر تطبيعه إلى E.164)"); e.statusCode = 400; throw e; }
  const setting = (await getSetting(client, "intake_allowlist")) || {};
  const members = Array.isArray(setting.members) ? setting.members.slice() : [];
  const idx = members.findIndex((m) => normalizePhoneE164(m && m.phone) === phone);
  const before = idx >= 0 ? members[idx] : null;
  const next = {
    phone,
    name: payload.name !== undefined ? String(payload.name || "").trim() : (before?.name || ""),
    active: payload.active !== undefined ? payload.active !== false : (before ? before.active !== false : true),
    role: payload.role !== undefined ? String(payload.role || "").trim() : (before?.role || ""),
    notes: payload.notes !== undefined ? String(payload.notes || "").trim() : (before?.notes || ""),
  };
  if (idx >= 0) members[idx] = next; else members.push(next);
  await setSetting(client, "intake_allowlist", { members, updated_at: new Date().toISOString() });
  await logAgentAction(client, {
    actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "accounting",
    action: before ? "intake.allowlist.update" : "intake.allowlist.add",
    targetType: "intake_allowlist", targetId: phone, beforeState: before, afterState: next,
    summary: `${before ? "تعديل" : "إضافة"} رقم موثوق ${phone}${next.active ? "" : " (معطّل)"}`,
  });
  return listIntakeAllowlist(client);
}

// المنطق الأساسي لاستقبال رسالة WhatsApp. M1 فقط: لا parsing محاسبي، لا finance_entry.
async function createWhatsappIntake(client, payload, opts = {}) {
  const provider = String(payload.provider || "peach").trim() || "peach";
  const providerMessageId = payload.provider_message_id != null ? String(payload.provider_message_id).trim()
    : (payload.message_id != null ? String(payload.message_id).trim() : "");
  const senderName = payload.sender_name != null ? String(payload.sender_name).trim() : null;
  const originalMessage = payload.original_message != null ? String(payload.original_message)
    : (payload.text != null ? String(payload.text) : "");
  const source = String(payload.source || "whatsapp").trim() || "whatsapp";
  const messageTimestamp = payload.message_timestamp || null;
  const attachmentUrl = payload.attachment_url ? String(payload.attachment_url) : null;
  const attachmentName = payload.attachment_name ? String(payload.attachment_name).slice(0, 240) : null;
  const attachmentMime = payload.attachment_mime ? String(payload.attachment_mime).slice(0, 120) : null;
  const attachmentMeta = payload.attachment_meta != null ? payload.attachment_meta : null;
  const amount = payload.amount != null && payload.amount !== "" ? Number(payload.amount) : null;

  // الحقول المطلوبة
  if (!payload.sender_phone || !String(payload.sender_phone).trim()) {
    const e = new Error("sender_phone مطلوب"); e.statusCode = 400; throw e;
  }
  // رسالة بمرفق فقط (PDF/صورة بلا caption) مقبولة: النص إلزامي فقط عند غياب مرفق صالح.
  if ((!originalMessage || !originalMessage.trim()) && !attachmentUrl) {
    const e = new Error("original_message مطلوب (أو مرفق صالح)"); e.statusCode = 400; throw e;
  }

  // تطبيع E.164 قبل allowlist/dedup/التخزين
  const e164 = normalizePhoneE164(payload.sender_phone);
  if (!e164) { const e = new Error("رقم الهاتف غير صالح (تعذّر تطبيعه إلى E.164)"); e.statusCode = 400; throw e; }

  // allowlist — رقم غير موثوق: لا إدخال مالي، لا finance_entry، رفض واضح
  const members = await getIntakeAllowlist(client);
  const member = findAllowlistMember(members, e164);
  if (!member) {
    await logAgentAction(client, {
      actorType: "system", action: "intake.reject_untrusted", targetType: "whatsapp_intake",
      summary: `رفض رسالة من رقم غير موثوق: ${e164}`,
    });
    return { status: "rejected", reason: "untrusted_sender", stored: false, sender_phone: e164 };
  }

  // منع التكرار — أولاً (provider + provider_message_id)
  if (providerMessageId) {
    const dup = await client.query(
      "select id, status from whatsapp_intake where provider = $1 and provider_message_id = $2 limit 1",
      [provider, providerMessageId]
    );
    if (dup.rows[0]) return { status: "duplicate", reason: "provider_message_id", stored: false, existingId: dup.rows[0].id };
  }
  // معالجة المرفق (جلب + hash + استخراج) قبل الـdedup لأن الطبقات تعتمد عليها.
  // معزولة تماماً: أي فشل لا يمنع حفظ الرسالة.
  let attachmentProc = null, attachmentSha = null, txnRef = null, duplicateRefOf = null;
  if (attachmentUrl && opts.fetchAttachment !== false) {
    try {
      attachmentProc = typeof opts.processAttachment === "function"
        ? await opts.processAttachment(attachmentUrl, attachmentMime)
        : await processAttachment(attachmentUrl, attachmentMime);
    } catch (e) {
      attachmentProc = { status: "error", reason: String(e && e.message || e).slice(0, 300) };
    }
    attachmentSha = attachmentProc?.sha256 || null;
    txnRef = attachmentProc?.fields?.reference || null;
  }

  // (2) دليل قوي: نفس بصمة الملف ⇒ نفس المستند حرفياً (أقوى من الرابط)
  if (attachmentSha) {
    const dupS = await client.query("select id from whatsapp_intake where attachment_sha256 = $1 limit 1", [attachmentSha]);
    if (dupS.rows[0]) return { status: "duplicate", reason: "attachment_sha256", stored: false, existingId: dupS.rows[0].id };
  }
  if (attachmentUrl) {
    const dupA = await client.query("select id from whatsapp_intake where attachment_url = $1 limit 1", [attachmentUrl]);
    if (dupA.rows[0]) return { status: "duplicate", reason: "attachment", stored: false, existingId: dupA.rows[0].id };
  }
  // (3) مرجع العملية الموثوق من المستند
  if (txnRef) {
    const dupR = await client.query(
      "select id, attachment_sha256 from whatsapp_intake where transaction_reference = $1 limit 1", [txnRef]);
    if (dupR.rows[0]) {
      // نفس المرجع ونفس الملف ⇒ تكرار مؤكد. نفس المرجع وملف مختلف ⇒ لا نرفض تلقائياً:
      // قد تكون نسخة معاد إصدارها من نفس العملية ⇒ اشتباه يقرّره الإنسان.
      if (attachmentSha && dupR.rows[0].attachment_sha256 === attachmentSha) {
        return { status: "duplicate", reason: "transaction_reference", stored: false, existingId: dupR.rows[0].id };
      }
      duplicateRefOf = dupR.rows[0].id;
    }
  }
  // (2ب) بصمة متطابقة تماماً (نفس المرسل والوقت والنص والمبلغ والمرفق)
  const dedupHash = computeIntakeDedupHash({ e164, messageTimestamp, amount, originalMessage, attachmentUrl });
  const dupH = await client.query("select id from whatsapp_intake where dedup_hash = $1 limit 1", [dedupHash]);
  if (dupH.rows[0]) return { status: "duplicate", reason: "dedup_hash", stored: false, existingId: dupH.rows[0].id };

  // (3) اشتباه فقط: نفس المرسل ونفس النص خلال 24 ساعة بلا دليل قاطع.
  //     لا يُرفض ولا يُحذف — يُخزَّن ويُعلَّم ليقرّر الإنسان (معاملتان متشابهتان قد تكونان صحيحتين).
  let duplicateOf = null, duplicateReason = null;
  if (originalMessage && originalMessage.trim()) {
    const sim = await client.query(
      `select id, created_at from whatsapp_intake
       where sender_phone = $1 and original_message = $2
         and created_at > now() - interval '24 hours'
       order by created_at desc limit 1`,
      [e164, originalMessage]
    );
    if (sim.rows[0]) {
      duplicateOf = sim.rows[0].id;
      duplicateReason = "مشابه لمعاملة سابقة خلال 24 ساعة: نفس المرسل ونفس النص، بلا دليل قاطع (مرفق/معرّف رسالة مختلف) — يحتاج قرار بشري";
    }
  }
  if (duplicateRefOf && !duplicateOf) {
    duplicateOf = duplicateRefOf;
    duplicateReason = "نفس رقم مرجع العملية لمعاملة سابقة لكن الملف مختلف — قد تكون نسخة معاد إصدارها؛ يحتاج قرار بشري";
  }

  // إدراج — status='new' (لا تحليل محاسبي في M1)
  try {
    const ins = await client.query(
      `insert into whatsapp_intake
         (provider, provider_message_id, sender_phone, sender_name, original_message,
          message_timestamp, source, raw_payload, dedup_hash, status,
          attachment_url, attachment_name, attachment_mime, attachment_meta,
          duplicate_of, duplicate_reason, attachment_sha256, transaction_reference)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'new',$10,$11,$12,$13::jsonb,$14,$15,$16,$17)
       returning id`,
      [provider, providerMessageId || null, e164, senderName, originalMessage,
       messageTimestamp, source, JSON.stringify(payload || {}), dedupHash,
       attachmentUrl, attachmentName, attachmentMime,
       JSON.stringify(Object.assign({}, attachmentMeta || {},
         attachmentProc ? { extraction: attachmentProc } : {})),
       duplicateOf, duplicateReason, attachmentSha, txnRef]
    );
    const id = ins.rows[0].id;
    await logAgentAction(client, {
      actorType: "system", action: "intake.receive", targetType: "whatsapp_intake", targetId: id,
      summary: `استلام رسالة من ${e164}${member.name ? " (" + member.name + ")" : ""}`,
    });

    // M2.6: تحليل تلقائي بعد نجاح الحفظ. الرسالة محفوظة بالفعل ⇒ فشل التحليل لا يفقدها أبداً.
    let finalStatus = "new";
    const parse = { attempted: false, ok: false };
    if (opts.autoParse !== false) {
      parse.attempted = true;
      try {
        const parsed = await parseIntake(client, id, { parser: opts.parser });
        parse.ok = true; finalStatus = parsed.status;
      } catch (perr) {
        // لا نُلغي الحفظ؛ نعلّم السجل failed برسالة واضحة ويبقى قابلاً لإعادة المحاولة والمراجعة
        parse.error = String(perr.message || "parse failed");
        try {
          await client.query(
            "update whatsapp_intake set status='failed', error_message=$1, updated_at=now() where id=$2 and status='new'",
            [parse.error.slice(0, 500), id]
          );
          finalStatus = "failed";
        } catch (_) { /* الحفظ الأصلي يبقى سليماً */ }
        try {
          await logAgentAction(client, {
            actorType: "agent", agentRole: "accounting", action: "intake.parse",
            targetType: "whatsapp_intake", targetId: id, status: "failed",
            errorMessage: parse.error, summary: `فشل التحليل التلقائي: ${parse.error}`,
          });
        } catch (_) {}
      }
    }
    // (D) ربط الرسالة الشقيقة: نفس المرسل خلال 60 ثانية، أحدهما بمرفق والآخر نص،
    //     ومرشّح واحد فقط. عند تعدّد المرشحين لا نربط ولا نخمّن.
    try {
      const cand = await client.query(
        `select id from whatsapp_intake
         where id <> $1 and sender_phone = $2 and sibling_of is null
           and abs(extract(epoch from (coalesce(message_timestamp, created_at) - $3::timestamptz))) <= 60
           and ((attachment_url is null) <> ($4::boolean))
         limit 2`,
        [id, e164, messageTimestamp || new Date().toISOString(), !attachmentUrl]
      );
      if (cand.rows.length === 1) {
        await client.query("update whatsapp_intake set sibling_of=$1, updated_at=now() where id=$2", [cand.rows[0].id, id]);
        await logAgentAction(client, {
          actorType: "system", action: "intake.sibling_linked", targetType: "whatsapp_intake", targetId: id,
          summary: "رُبط بالرسالة الشقيقة (نفس المرسل خلال 60ث، مستند+نص، مرشّح واحد)",
          afterState: { sibling_of: cand.rows[0].id },
        });
      } else if (cand.rows.length > 1) {
        await logAgentAction(client, {
          actorType: "system", action: "intake.sibling_ambiguous", targetType: "whatsapp_intake", targetId: id,
          summary: "أكثر من مرشّح شقيق — لم يُربط، يحتاج قرار بشري",
        });
      }
    } catch (_) { /* الربط تحسين لا يُسقط الاستقبال */ }

    if (duplicateOf && finalStatus !== "failed") {
      await client.query("update whatsapp_intake set status='needs_review', updated_at=now() where id=$1", [id]);
      finalStatus = "needs_review";
      await logAgentAction(client, {
        actorType: "system", action: "intake.duplicate_suspected", targetType: "whatsapp_intake", targetId: id,
        summary: duplicateReason, afterState: { duplicate_of: duplicateOf },
      });
    }
    return { status: finalStatus, stored: true, id, sender_phone: e164, parse,
             possible_duplicate_of: duplicateOf || undefined };
  } catch (err) {
    if (err.code === "23505") return { status: "duplicate", reason: "unique_violation", stored: false };
    throw err;
  }
}


/* ─── P1.7: جلب المرفق واستخراج بياناته ─── */

// مضيفات المرفقات المسموحة حصراً (لا fetch عام ⇒ لا SSRF).
const ATTACHMENT_HOSTS = new Set(["app.trypeach.ai"]);

// يجلب المرفق ويحسب hash. لا يرمي أبداً: الفشل يعيد null فلا تُفقد الرسالة.
async function fetchAttachment(url, timeoutMs = 12000) {
  let u;
  try { u = new URL(String(url || "")); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || !ATTACHMENT_HOSTS.has(u.hostname)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(u.toString(), { redirect: "follow", signal: ac.signal });
    if (!r.ok) return { ok: false, httpStatus: r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, buf, bytes: buf.length,
      contentType: r.headers.get("content-type") || null,
      sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  } catch (e) { return { ok: false, error: e.name + ": " + e.message }; }
  finally { clearTimeout(timer); }
}

// يبحث عن رقم قريب من تسمية (قبلها أو بعدها) — تخطيط PDF يقلب الترتيب أحياناً.
function nearMatch(text, labelRe, valueRe, window = 60) {
  const m = labelRe.exec(text);
  if (!m) return null;
  const labelStart = m.index, labelEnd = m.index + m[0].length;
  const from = Math.max(0, labelStart - window);
  const to = Math.min(text.length, labelEnd + window);
  const slice = text.slice(from, to);
  const re = new RegExp(valueRe.source, "g");
  let best = null, bestDist = Infinity, mm;
  while ((mm = re.exec(slice))) {
    const aStart = from + mm.index, aEnd = aStart + mm[0].length;
    const dist = aEnd <= labelStart ? labelStart - aEnd : (aStart >= labelEnd ? aStart - labelEnd : 0);
    if (dist < bestDist) { bestDist = dist; best = mm[1] != null ? mm[1] : mm[0]; }
  }
  return best;
}

// استخراج حقول إيصال/فاتورة من نص مستخرج. ما لا يُوجَد يبقى null (لا تخمين).
function extractReceiptFields(text) {
  const t = String(text || "");
  const num = (s) => { const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  const amount = num(
    nearMatch(t, /Total\s*Amount|المبلغ\s*الإجمالي|الإجمالي/i, /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/)
    || nearMatch(t, /Amount|المبلغ/i, /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/)
  );
  // IBAN قد يُكتب متصلاً أو بمجموعات مفصولة بمسافات (SA## #### ####…)
  const ibanM = t.match(/\bSA\s?[0-9]{2}(?:\s?[0-9A-Z]){20}(?![0-9])/);
  // المرجع: نبحث بعد إزالة الـIBAN حتى لا تُلتقط أرقامه كمرجع. بعض القوالب (مثل «بين حساباتي») لا تحوي مرجعاً أصلاً ⇒ null بلا تخمين
  const tNoIban = ibanM ? t.replace(ibanM[0], " ") : t;
  const reference = nearMatch(tNoIban,
    /Payment\s*Reference\s*Number|Transaction\s*Reference|Reference\s*(?:Number|No\.?)|Ref\.?\s*No\.?|Transfer\s*(?:No|Number|Reference)|Transaction\s*(?:No|Number|ID)|رقم\s*العملية|الرقم\s*المرجعي|رقم\s*المرجع|رقم\s*الحوالة/i,
    /(\d{8,24})/, 80);
  const transferKind = /Between\s*my\s*accounts|بين\s*حساباتي/i.test(t) ? "own_accounts"
    : /International\s*Transfer|حوالة\s*دولية/i.test(t) ? "international"
    : /Local\s*Transfer/i.test(t) ? "local" : null;
  const dateM = t.match(/\b(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\b/);
  const bankM = t.match(/alrajhi|rajhi|الراجحي|alinma|الإنماء|الاهلي|الأهلي|riyad|الرياض|sabb|ساب|anb|البلاد|albilad/i);
  return {
    amount, currency: /SAR|ر\.?\s?س|ريال/i.test(t) ? "SAR" : null,
    reference: reference || null,
    iban: ibanM ? ibanM[0].replace(/\s/g, "") : null,
    transfer_kind: transferKind,
    transaction_date: dateM ? `${dateM[1]}-${String(dateM[2]).padStart(2, "0")}-${String(dateM[3]).padStart(2, "0")}` : null,
    bank: bankM ? bankM[0] : null,
    doc_kind: /Transfer\s*Receipt|إشعار\s*تحويل|حوالة/i.test(t) ? "transfer_receipt"
      : /Invoice|فاتورة/i.test(t) ? "invoice" : /Receipt|إيصال/i.test(t) ? "receipt" : null,
  };
}

// يجلب المرفق ويستخرج ما أمكن. يُرجع دائماً كائناً (لا يرمي).
async function processAttachment(url, mime) {
  const got = await fetchAttachment(url);
  if (!got) return { status: "skipped", reason: "host_not_allowed" };
  if (!got.ok) return { status: "fetch_failed", reason: got.error || ("http_" + got.httpStatus) };
  const isPdf = (got.contentType || "").includes("pdf") || (mime || "").includes("pdf");
  let text = "", fields = {};
  if (isPdf) {
    try { text = pdfExtractText(got.buf) || ""; } catch (e) { text = ""; }
    if (text) fields = extractReceiptFields(text);
  }
  return { status: text ? "extracted" : (isPdf ? "no_text" : "not_extractable"),
    sha256: got.sha256, bytes: got.bytes, contentType: got.contentType,
    text_len: text.length, text: text.slice(0, 4000), fields };
}

/* ─── WhatsApp Intake Review (M2): صندوق واتساب + مراجعة بشرية ─── */

function intakeRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    providerMessageId: row.provider_message_id || "",
    sender_phone: row.sender_phone,
    sender_name: row.sender_name || "",
    original_message: row.original_message || "",
    message_timestamp: row.message_timestamp,
    classification: row.classification || "",
    amount: row.amount == null ? null : moneyNumber(row.amount),
    currency: row.currency || "SAR",
    confidence_score: row.confidence_score == null ? null : Number(row.confidence_score),
    missing_fields: Array.isArray(row.missing_fields) ? row.missing_fields : [],
    source_account_id: row.source_account_id || null,
    source_account_name: row.source_account_name || "",
    destination_account_id: row.destination_account_id || null,
    destination_account_name: row.destination_account_name || "",
    supplier_name: row.supplier_name || "",
    project_name: row.project_name || "",
    status: row.status,
    rejection_reason: row.rejection_reason || "",
    duplicate_of: row.duplicate_of || null,
    sibling_of: row.sibling_of || null,
    attachment_sha256: row.attachment_sha256 || null,
    transaction_reference: row.transaction_reference || null,
    duplicate_reason: row.duplicate_reason || "",
    parsed_data: row.parsed_data || null,
    final_data: row.final_data || null,
    reviewed_by: row.reviewed_by || null,
    reviewed_by_name: row.reviewed_by_name || "",
    reviewed_at: row.reviewed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const INTAKE_SELECT = `
  select wi.*, sa.name as source_account_name, da.name as destination_account_name, u.name as reviewed_by_name
  from whatsapp_intake wi
  left join bank_accounts sa on sa.id = wi.source_account_id
  left join bank_accounts da on da.id = wi.destination_account_id
  left join app_users u on u.id = wi.reviewed_by`;

async function listIntake(client, { status } = {}) {
  const params = [];
  let where = "";
  if (status) { params.push(status); where = "where wi.status = $1"; }
  const result = await client.query(`${INTAKE_SELECT} ${where} order by wi.created_at desc limit 200`, params);
  return result.rows.map(intakeRow);
}

async function getIntake(client, id) {
  const result = await client.query(`${INTAKE_SELECT} where wi.id = $1 limit 1`, [String(id || "")]);
  if (!result.rows[0]) { const e = new Error("سجل الوارد غير موجود"); e.statusCode = 404; throw e; }
  return intakeRow(result.rows[0]);
}

function requireIntakeApprover(user) {
  if (!user || !["owner", "accountant"].includes(user.role)) {
    const e = new Error("ليس لديك صلاحية مراجعة/اعتماد صندوق واتساب");
    e.statusCode = 403; throw e;
  }
}

// الحقول القابلة للمراجعة فقط — parsed_data لا يُمَس أبداً
const INTAKE_EDITABLE = [
  "classification", "amount", "currency", "suggested_chart_account_id",
  "source_account_id", "destination_account_id", "customer_id", "vehicle_id",
  "quote_id", "supplier_name", "project_name",
];
const INTAKE_REVIEWABLE_STATES = ["new", "parsed", "needs_review", "failed"];

async function updateIntake(client, payload, user) {
  requireIntakeApprover(user);
  const id = String(payload.id || "").trim();
  if (!id) { const e = new Error("معرّف السجل مطلوب"); e.statusCode = 400; throw e; }
  const before = await getIntake(client, id);
  if (!INTAKE_REVIEWABLE_STATES.includes(before.status)) {
    const e = new Error(`لا يمكن تعديل سجل بحالة ${before.status}`); e.statusCode = 409; throw e;
  }
  const sets = []; const params = []; let i = 1;
  for (const f of INTAKE_EDITABLE) {
    if (payload[f] !== undefined) { sets.push(`${f} = $${i++}`); params.push(payload[f] === "" ? null : payload[f]); }
  }
  if (payload.final_data !== undefined) { sets.push(`final_data = $${i++}::jsonb`); params.push(JSON.stringify(payload.final_data)); }
  if (!sets.length) { const e = new Error("لا حقول للتعديل"); e.statusCode = 400; throw e; }
  sets.push("updated_at = now()");
  params.push(id);
  await client.query(`update whatsapp_intake set ${sets.join(", ")} where id = $${i}`, params);
  const after = await getIntake(client, id);
  await logAgentAction(client, {
    actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "accounting",
    action: "intake.edit", targetType: "whatsapp_intake", targetId: id,
    beforeState: before, afterState: after, summary: "تعديل حقول المراجعة",
  });
  return after;
}

async function approveIntake(client, payload, user) {
  requireIntakeApprover(user);
  const id = String(payload.id || "").trim();
  if (!id) { const e = new Error("معرّف السجل مطلوب"); e.statusCode = 400; throw e; }
  const before = await getIntake(client, id);
  if (!INTAKE_REVIEWABLE_STATES.includes(before.status)) {
    const e = new Error(`لا يمكن اعتماد سجل بحالة ${before.status}`); e.statusCode = 409; throw e;
  }
  // M2: اعتماد فقط — لا يُنشأ finance_entry هنا
  await client.query(
    "update whatsapp_intake set status='approved', reviewed_by=$1, reviewed_at=now(), updated_at=now() where id=$2",
    [user.id, id]
  );
  const after = await getIntake(client, id);
  await logAgentAction(client, {
    actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "accounting",
    action: "intake.approve", targetType: "whatsapp_intake", targetId: id,
    beforeState: before, afterState: after, summary: "اعتماد الحركة (بلا إنشاء قيد مالي في M2)",
  });
  return after;
}

async function rejectIntake(client, payload, user) {
  requireIntakeApprover(user);
  const id = String(payload.id || "").trim();
  const reason = String(payload.rejection_reason || payload.reason || "").trim();
  if (!id) { const e = new Error("معرّف السجل مطلوب"); e.statusCode = 400; throw e; }
  if (!reason) { const e = new Error("سبب الرفض مطلوب"); e.statusCode = 400; throw e; }
  const before = await getIntake(client, id);
  if (!INTAKE_REVIEWABLE_STATES.includes(before.status)) {
    const e = new Error(`لا يمكن رفض سجل بحالة ${before.status}`); e.statusCode = 409; throw e;
  }
  await client.query(
    "update whatsapp_intake set status='rejected', rejection_reason=$1, reviewed_by=$2, reviewed_at=now(), updated_at=now() where id=$3",
    [reason, user.id, id]
  );
  const after = await getIntake(client, id);
  await logAgentAction(client, {
    actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "accounting",
    action: "intake.reject", targetType: "whatsapp_intake", targetId: id,
    beforeState: before, afterState: after, summary: `رفض: ${reason}`,
  });
  return after;
}

/* ─── AI Parsing للـ whatsapp_intake (M2.5): new → parsed | needs_review ─── */

function toLatinDigits(s) {
  return String(s || "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
                        .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

// المبلغ لا يُستخرج إلا بسياق مالي صريح (عملة أو كلمة مالية).
// الأرقام المجرّدة تُتجاهل عمداً: جوّالات، IBAN، أرقام مراجع/هوية/عقود.
const MONEY_NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?";
const MONEY_CUE_WORD = "مبلغ|بمبلغ|قيمة|بقيمة|الاجمالي|الإجمالي|اجمالي|إجمالي|دفعت|دفعنا|حولت|حوّلت|تحويل|حوالة|دفعة|سددت|سدّدت|سدد|استلمنا|استلمت|تحصيل|عهدة|عهده|صرفت|صرفنا";

function plausibleAmount(raw, t, idx) {
  const clean = String(raw).replace(/,/g, "");
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return null;
  const intDigits = clean.split(".")[0].length;
  if (intDigits > 7) return null;                          // أطول من 9,999,999 ⇒ غالباً مرجع/جوال
  if (/^0\d/.test(clean)) return null;                     // يبدأ بصفر ⇒ جوّال/رقم مرجعي لا مبلغ
  // رفض إن كان جزءاً من سلسلة أطول (IBAN/مرجع ملتصق بحروف أو أرقام)
  const before = t[idx - 1] || "", after = t[idx + String(raw).length] || "";
  if (/[0-9A-Za-z٠-٩]/.test(before) || /[0-9A-Za-z]/.test(after)) return null;
  return n;
}

function extractIntakeAmount(text) {
  const t = toLatinDigits(text);
  const tryAll = (re) => {
    for (const m of t.matchAll(re)) {
      const g = m[1] != null ? m[1] : m[2];
      if (g == null) continue;
      const idx = t.indexOf(g, m.index);
      const v = plausibleAmount(g, t, idx);
      if (v != null) return v;
    }
    return null;
  };
  // (1) رقم + عملة  |  (2) عملة + رقم
  const cur = tryAll(new RegExp(`(${MONEY_NUM})\\s*(?:ر\\.?\\s?س|ريال|sar)|(?:ر\\.?\\s?س|ريال|sar)\\s*(${MONEY_NUM})`, "gi"));
  if (cur != null) return cur;
  // (3) كلمة مالية ثم رقم قريب (حتى 12 محرفاً غير رقمية بينهما)
  const cue = tryAll(new RegExp(`(?:${MONEY_CUE_WORD})[^\\d\\n]{0,12}(${MONEY_NUM})`, "gi"));
  if (cue != null) return cue;
  return null;                                             // لا سياق مالي ⇒ لا تخمين
}

// تصنيف بقواعد حتمية (fallback مستقل عن أي مزوّد AI)
/* فهم تعليق المعاملة (caption) — صيغ الشراء العربية واللهجات كلمات كاملة فقط
   («شراكة» و«شراع» لا تُعدّ شراء). اسم المادة وحده (مثل «فريون») ليس قاعدة تصنيف. */
const PURCHASE_VERB_RE = /(^|[\s،,.:؛\-])(?:تم\s+)?(شراء|شرا|اشتريت|اشترينا|اشتري|اشترى|شريت|شرينا|مشتريات)(?=$|[\s،,.:؛\-])/;
// استبدالات حرف-بحرف فقط (تحافظ على المواضع لاقتطاع النص الأصلي)
const normArabic1to1 = (s) => String(s || "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي");
function parseFinancialCaption(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { intent: null, description: null };
  const m = normArabic1to1(raw).match(PURCHASE_VERB_RE);
  if (!m) return { intent: null, description: raw.slice(0, 160) };
  const verbEnd = m.index + m[0].length;
  const object = raw.slice(verbEnd).replace(/^[\s،,.:؛\-]+/, "").trim();
  const head = m[2] === "مشتريات" ? "مشتريات" : "شراء";
  return { intent: "purchase", description: (object ? `${head} ${object}` : head).slice(0, 160) };
}

function ruleClassify(text) {
  const t = toLatinDigits(String(text || "")).toLowerCase();
  const has = (...ws) => ws.some((w) => t.includes(w));
  const purchase = PURCHASE_VERB_RE.test(normArabic1to1(t));
  let classification = "unknown";
  const isTransfer = has("تحويل داخلي", "تحويل بين") ||
    ((has("تحويل", "حولت", "حوّلت")) && /من\s[\s\S]*(الى|إلى)\s/.test(t));
  if (isTransfer) classification = "internal_transfer";
  else if (has("عهدة", "عهده", "سلفة تشغيل", "سلفه تشغيل")) classification = "custody";
  else if (has("استرجاع", "استرداد", "مرتجع", "رد مبلغ", "ريفند")) classification = "refund";
  // "استلم" جذع يغطي استلمت/استلمنا/استلم. تجنّبنا "وصل" المجرّد لأنه يطابق "توصيل" (مصروف).
  else if (has("دفعة عميل", "تحصيل", "حصلت", "حصلنا", "استلم", "سدد العميل", "سدّد العميل", "إيراد", "ايراد", "وصلني", "وصلنا")) classification = "receipt";
  else if (purchase || has("مصروف", "صرف", "دفعت", "اشتريت", "شراء", "فاتورة", "بنزين", "ديزل", "وقود", "صيانة", "زيت", "أجرة", "اجرة", "عمالة", "مواد")) classification = "expense";
  // تحديث تشغيلي: يعتمد على المحتوى لا على المرسِل. يُفحص فقط بعد استبعاد الأنواع المالية.
  else if (has("وصلنا الموقع", "وصلنا للموقع", "انتهى التركيب", "بدأنا التركيب", "جاري التركيب",
               "تم التركيب", "تم الفك", "نحتاج عمال", "نحتاج عمالة", "الفريق في", "تأخرنا",
               "تم التسليم", "جاهز للتسليم", "تقرير", "متابعة", "تواصل", "فرصة", "منافسة", "مهرجان", "معرض")) {
    classification = "operational_update";
  }
  return { classification, amount: extractIntakeAmount(text), currency: "SAR", supplier_name: null, project_name: null };
}

// abstraction لمزوّد AI: كل مزوّد يوفّر classify(text)؛ قواعد الحسابات/الحالة عامة بعده
function ruleIntakeParser() {
  return { name: "rule", async classify(text) { return ruleClassify(text); } };
}
function claudeIntakeParser() {
  return {
    name: "claude-haiku",
    async classify(text) {
      try {
        const Anthropic = require("@anthropic-ai/sdk");
        const c = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await c.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          messages: [{ role: "user", content:
`صنّف رسالة مالية داخلية لمؤسسة تأجير خيام. أعِد JSON فقط بدون أي نص:
{"classification":"expense|receipt|internal_transfer|custody|refund|unknown","amount":number|null,"currency":"SAR","supplier_name":string|null,"project_name":string|null}
الرسالة:
${text}` }],
        });
        const raw = msg.content[0]?.text?.trim() || "";
        const j = raw.match(/\{[\s\S]*\}/)?.[0];
        const p = j ? JSON.parse(j) : {};
        const cls = ["expense", "receipt", "internal_transfer", "custody", "refund", "unknown"].includes(p.classification) ? p.classification : "unknown";
        return { classification: cls, amount: p.amount != null ? Number(p.amount) : extractIntakeAmount(text), currency: p.currency || "SAR", supplier_name: p.supplier_name || null, project_name: p.project_name || null };
      } catch (e) {
        return ruleClassify(text); // fallback حتمي عند فشل المزوّد
      }
    },
  };
}
function getIntakeParser() {
  if (process.env.ANTHROPIC_API_KEY && process.env.INTAKE_PARSER !== "rule") return claudeIntakeParser();
  return ruleIntakeParser();
}

// توحيد صور الألف/الياء والتطويل حتى يطابق "أبو" ↔ "ابو".
function normalizeArabic(s) {
  return String(s || "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ـ/g, "");
}
function intakeAccountTokens(name) {
  return normalizeArabic(String(name || "")).split(/\s+/).map((w) => w.trim()).filter((w) => w && w !== "حساب" && w.length >= 3);
}
// استخراج الحسابات من النص بالاتجاه:
//   من ⇒ source · إلى/لحساب/في/على ⇒ destination (المال داخل إلى الحساب).
// لا تخمين إطلاقاً: حساب غير مذكور صراحةً يبقى null ويُدرَج في missing_fields.
function resolveAccountsFromText(text, accounts) {
  const t = normalizeArabic(toLatinDigits(String(text || "")));
  let source = null, dest = null;
  for (const a of accounts) {
    let idx = -1;
    for (const tok of intakeAccountTokens(a.name)) { const k = t.indexOf(tok); if (k >= 0) { idx = k; break; } }
    if (idx < 0) continue;
    const before = t.slice(Math.max(0, idx - 12), idx);
    if (/الي|لحساب|في|علي/.test(before)) { if (!dest) dest = a.id; }
    else if (/من/.test(before)) { if (!source) source = a.id; }
  }
  return { source_account_id: source, destination_account_id: dest };
}

// قواعد الحسابات + missing_fields + confidence + status (عامة لكل المزوّدين)
function finalizeIntakeParse(base, accIds, parserName) {
  const classification = base.classification || "unknown";
  const amount = base.amount != null ? base.amount : null;
  const source = accIds.source_account_id || null;
  const dest = accIds.destination_account_id || null;
  const missing = [];
  // المبلغ مطلوب للأنواع المالية فقط؛ التحديث التشغيلي بطبيعته بلا مبلغ.
  const FINANCIAL = ["expense", "receipt", "internal_transfer", "custody", "refund"];
  if (amount == null && FINANCIAL.includes(classification)) missing.push("amount");
  if (classification === "expense" && !source) missing.push("source_account_id");
  if (classification === "receipt" && !dest) missing.push("destination_account_id");
  if (classification === "internal_transfer") {
    if (!source) missing.push("source_account_id");
    if (!dest) missing.push("destination_account_id");
  }
  const reviewNote = base.review_note || null;
  let conf;
  if (classification === "unknown") conf = 0.2;
  else {
    conf = 0.5 + 0.2;                       // تصنيف معروف
    if (amount != null) conf += 0.15;
    const need = classification === "expense" ? ["s"] : classification === "receipt" ? ["d"]
      : classification === "internal_transfer" ? ["s", "d"] : [];
    if (need.length) { if (need.every((k) => (k === "s" ? source : dest))) conf += 0.15; }
    else conf += 0.1;                        // custody/refund بلا حساب إلزامي
  }
  conf = Math.max(0, Math.min(1, Number(conf.toFixed(3))));
  // تعارض بين التعليق والمستند ⇒ مراجعة بشرية دائماً
  const status = (missing.length > 0 || conf < 0.6 || classification === "unknown" || reviewNote) ? "needs_review" : "parsed";
  const parsed_data = {
    classification, amount, currency: base.currency || "SAR",
    source_account_id: source, destination_account_id: dest,
    supplier_name: base.supplier_name || null, project_name: base.project_name || null,
    confidence_score: conf, missing_fields: missing, parser: parserName,
    description: base.description || null, review_note: reviewNote,
    document: base.document || null,
  };
  return { parsed_data, classification, amount, currency: base.currency || "SAR",
    source_account_id: source, destination_account_id: dest,
    supplier_name: base.supplier_name || null, project_name: base.project_name || null,
    confidence: conf, missing_fields: missing, status };
}

// يحلّل سجلاً بحالة new فقط، ويحفظ parsed_data (أول تحليل، immutable) دون لمس final_data.
async function parseIntake(client, id, opts = {}) {
  const idS = String(id || "").trim();
  if (!idS) { const e = new Error("معرّف السجل مطلوب"); e.statusCode = 400; throw e; }
  const row = (await client.query("select id, status, original_message, parsed_data, attachment_meta from whatsapp_intake where id = $1", [idS])).rows[0];
  if (!row) { const e = new Error("سجل الوارد غير موجود"); e.statusCode = 404; throw e; }
  if (!["new", "failed"].includes(row.status)) { const e = new Error(`لا يمكن تحليل سجل بحالة ${row.status}`); e.statusCode = 409; throw e; }
  const parser = opts.parser || getIntakeParser();
  // دمج: caption الرسالة + النص المستخرج من المستند (إن وُجد)
  const ext = row.attachment_meta && row.attachment_meta.extraction ? row.attachment_meta.extraction : null;
  const docText = ext && ext.text ? String(ext.text) : "";
  const effectiveText = [row.original_message || "", docText].filter(Boolean).join("\n");
  const base = await parser.classify(effectiveText);
  // المبلغ المستخرج من المستند أوثق من نص الرسالة
  if (ext && ext.fields && ext.fields.amount != null) base.amount = ext.fields.amount;
  if (ext && ext.fields && ext.fields.currency) base.currency = ext.fields.currency;
  // التعليق يحدد الغرض والوصف؛ المستند يحدد طبيعة الحركة. لا نصنّف من اسم مادة وحده.
  const cap = parseFinancialCaption(row.original_message);
  base.description = cap.description;
  if (cap.intent === "purchase" && base.classification === "unknown") base.classification = "expense";
  const fields = (ext && ext.fields) || {};
  if (fields.transfer_kind === "own_accounts") {
    if (base.classification === "expense") {
      base.classification = "internal_transfer";
      base.review_note = "الإيصال تحويل بين حساباتك الخاصة بينما التعليق يذكر شراء — تحقّق: مصروف فعلي أم تحويل داخلي لتمويل الشراء؟";
    } else if (base.classification === "unknown") {
      base.classification = "internal_transfer";
      base.review_note = "إيصال تحويل بين الحسابات — حدّد الحسابين";
    }
  }
  if (ext && ext.fields) {
    base.document = { doc_kind: fields.doc_kind || null, transfer_kind: fields.transfer_kind || null, bank: fields.bank || null,
      transaction_date: fields.transaction_date || null, reference: fields.reference || null };
  }
  const accounts = (await client.query("select id, name from bank_accounts where is_active = true")).rows;
  const accIds = resolveAccountsFromText(effectiveText, accounts);
  const fin = finalizeIntakeParse(base, accIds, parser.name);
  await client.query(
    `update whatsapp_intake set
       classification = $1, amount = $2, currency = $3, source_account_id = $4, destination_account_id = $5,
       supplier_name = $6, project_name = $7, confidence_score = $8, missing_fields = $9,
       parsed_data = coalesce(parsed_data, $10::jsonb), status = $11, error_message = null, updated_at = now()
     where id = $12`,
    [fin.classification, fin.amount, fin.currency, fin.source_account_id, fin.destination_account_id,
     fin.supplier_name, fin.project_name, fin.confidence, fin.missing_fields,
     JSON.stringify(fin.parsed_data), fin.status, idS]
  );
  await logAgentAction(client, {
    actorType: "agent", actorName: parser.name, agentRole: "accounting", action: "intake.parse",
    targetType: "whatsapp_intake", targetId: idS, confidence: fin.confidence,
    afterState: { classification: fin.classification, status: fin.status, missing_fields: fin.missing_fields },
    summary: `تحليل: ${fin.classification} (${Math.round(fin.confidence * 100)}%) → ${fin.status}`,
  });
  // خصوصية: نص المستند الخام يُستخدم للتحليل فقط ثم يُحذف؛ تبقى الحقول المستخرجة والبصمة
  await client.query("update whatsapp_intake set attachment_meta = attachment_meta #- '{extraction,text}' where id=$1 and attachment_meta ? 'extraction'", [idS]);
  return await getIntake(client, idS);
}


/* ─── P2.1: وكيل المبيعات — Shadow Mode (مسار العملاء، مستقل عن intake والمحاسبة) ─── */
const salesEngine = require("../lib/sales-engine");
const SALES_OPEN = ["new", "qualifying", "ready_for_confirmation", "ready_for_team", "human_handoff"];
const SALES_MERGE_FIELDS = ["request_type", "requested_dimensions", "approx_area", "guest_count", "event_type",
  "seating_style", "start_date", "end_date", "duration_days", "city", "location_details", "rental_mode", "date_hint",
  "units_count"];
// node-pg يعيد أعمدة date كـDate — نوحّدها نصاً YYYY-MM-DD قبل أي منطق أو عرض.
function salesRowDates(row) {
  if (!row) return row;
  for (const k of ["start_date", "end_date"]) if (row[k]) row[k] = salesEngine.isoOf(row[k]);
  return row;
}

// التوجيه: رقم الفريق ⇒ internal intake، أي رقم آخر ⇒ مسار المبيعات. (لا يمسّ /intake/whatsapp)
function routeInboundTarget(members, e164) {
  return findAllowlistMember(members, e164) ? "internal" : "sales";
}

// صلاحية دقيقة: sales.review تتيح قراءة طلبات العملاء واعتماد الرد والتسليم للفريق فقط،
// دون تغيير الدور ودون أي صلاحية إدارية أخرى. (مثال: أبو فايز = viewer + sales.review)
const SALES_REVIEW_PERMISSION = "sales.review";
const KNOWN_PERMISSIONS = [SALES_REVIEW_PERMISSION];
function hasPermission(user, perm) {
  return !!user && Array.isArray(user.permissions) && user.permissions.includes(perm);
}
function requireSalesUser(user, action = false) {
  const byRole = action ? ["owner", "manager"] : ["owner", "manager", "viewer"];
  if (user && (byRole.includes(user.role) || hasPermission(user, SALES_REVIEW_PERMISSION))) return;
  const e = new Error("ليس لديك صلاحية على طلبات العملاء"); e.statusCode = 403; throw e;
}

async function handleSalesInbound(client, payload, opts = {}) {
  const now = opts.now || new Date();
  const e164 = normalizePhoneE164(payload.sender_phone);
  if (!e164) { const e = new Error("رقم الهاتف غير صالح"); e.statusCode = 400; throw e; }
  const members = await getIntakeAllowlist(client);
  if (routeInboundTarget(members, e164) === "internal") return { routed: "internal", stored: false };

  const provider = String(payload.provider || "peach");
  const pmid = payload.provider_message_id != null ? String(payload.provider_message_id) : null;
  if (pmid) {
    const d = await client.query("select lead_id from sales_messages where provider=$1 and provider_message_id=$2 limit 1", [provider, pmid]);
    if (d.rows[0]) return { routed: "sales", duplicate: true, stored: false, lead_id: d.rows[0].lead_id };
  }

  const text = String(payload.text ?? payload.original_message ?? "");
  const contentType = payload.content_type || (payload.media_url || payload.attachment_url ? "document" : payload.location ? "location" : "text");
  const mediaUrl = payload.media_url || payload.attachment_url || null;

  // العميل الواحد له طلب مفتوح واحد؛ بعد handed_off/stale يبدأ طلب جديد.
  let lead = (await client.query(
    "select * from sales_leads where customer_phone=$1 and status = any($2) order by created_at desc limit 1", [e164, SALES_OPEN])).rows[0];
  salesRowDates(lead);
  if (!lead) {
    lead = (await client.query(
      `insert into sales_leads (customer_phone, customer_name, peach_contact_id, peach_conversation_id, status)
       values ($1,$2,$3,$4,'new') returning *`,
      [e164, payload.sender_name || null, payload.peach?.contact_id != null ? String(payload.peach.contact_id) : null,
       payload.peach?.conversation_id != null ? String(payload.peach.conversation_id) : null])).rows[0];
  }

  const ex = salesEngine.extractSalesFields(text, now);
  let mediaMeta = null;
  if (mediaUrl) {
    mediaMeta = { name: payload.attachment_name || null, mime: payload.attachment_mime || null };
    if (opts.fetchAttachment !== false) {
      try {
        const proc = typeof opts.processAttachment === "function"
          ? await opts.processAttachment(mediaUrl, payload.attachment_mime) : await processAttachment(mediaUrl, payload.attachment_mime);
        mediaMeta.sha256 = proc?.sha256 || null; mediaMeta.extraction_status = proc?.status || null;
        mediaMeta.bytes = proc?.bytes || null; mediaMeta.text_len = proc?.text_len || 0;
      } catch (e) { mediaMeta.extraction_status = "error"; }
    }
  }
  const loc = payload.location && payload.location.lat != null ? payload.location : null;

  await client.query(
    `insert into sales_messages (lead_id, provider, provider_message_id, direction, text, content_type, media_url, media_meta, extracted, message_timestamp)
     values ($1,$2,$3,'in',$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [lead.id, provider, pmid, text, contentType, mediaUrl, mediaMeta ? JSON.stringify(mediaMeta) : null,
     JSON.stringify(ex), payload.message_timestamp || now.toISOString()]);

  // ── سجل المحادثة: ما قاله الوكيل وما سأله (مواضيع لا نصوص) ──
  const history = salesEngine.buildHistory((await client.query(
    "select text, extracted from sales_messages where lead_id=$1 and direction='out_suggested' order by created_at", [lead.id])).rows);

  // ── الانتقالات ──
  const L = { ...lead };
  const prevVal = (f) => String((f === "start_date" ? salesEngine.isoOf(lead[f]) : lead[f]) ?? "");
  const ack = Object.keys(salesEngine.FIELD_ACK).filter((f) => ex[f] != null && String(ex[f]) !== prevVal(f))
    .map((f) => salesEngine.FIELD_ACK[f]);
  let ctx = { greeting: ex.greeting && lead.status === "new", priceAsked: ex.price_question, sizeInfoRequested: ex.size_info_request,
    contactQuestion: ex.contact_question, contactIssue: ex.contact_issue, ack, history };
  const prevStatus = lead.status;
  const hadReq = JSON.stringify(lead.requested_dimensions || null);
  const dimsKey = (arr) => (arr || []).map((d) => `${d.width}x${d.length}`).join(",");
  const hadSug = dimsKey(lead.suggested_dimensions);
  const changed = SALES_MERGE_FIELDS.some((f) => ex[f] != null);

  if (prevStatus === "human_handoff" || ex.wants_human) {
    L.status = "human_handoff";
  } else if (prevStatus === "ready_for_team") {
    // الطلب عند الفريق — نسجّل الرسالة ولا نغيّر الحالة
  } else {
    for (const f of SALES_MERGE_FIELDS) {
      if (ex[f] == null) continue;
      if (f === "request_type" && ex[f] === "tent" && L.request_type && L.request_type !== "tent") continue;
      L[f] = ex[f];
    }
    if (ex.start_date) L.date_hint = null;
    if (ex.size_unsure) L.size_unsure = true;
    // الخدمات تُعتمد فقط لطلب التجهيز المتكامل (كلمة «خيام» في طلب خيمة ليست «خدمة»)
    if (L.request_type === "full_event" && ex.services) L.requested_services = [...new Set([...(L.requested_services || []), ...ex.services])];
    const extraNotes = [...(ex.extras || []), ...(L.request_type === "toilets" ? (ex.unit_types || []).map((u) => `النوع: ${u}`) : []),
      ex.guest_range ? `العدد تقريباً ${ex.guest_range}` : null,
      ex.contact_issue ? "العميل أفاد أن رقم التواصل الذي وصله ناقص/غلط" : null].filter(Boolean);
    if (extraNotes.length) {
      const cur = new Set(String(L.customer_notes || "").split(" · ").filter(Boolean));
      extraNotes.forEach((n) => cur.add(n));
      L.customer_notes = [...cur].join(" · ");
    }
    if (loc) { L.location_lat = loc.lat; L.location_lng = loc.lng; if (loc.name) L.location_details = loc.name; }
    if (contentType === "audio") L.customer_notes = [L.customer_notes, "أرسل رسالة صوتية — تحتاج استماع بشري"].filter(Boolean).join(" · ");
    Object.assign(L, salesEngine.deriveSizing(L));
    L.missing_fields = salesEngine.computeSalesMissing(L);
    const qualified = salesEngine.isQualified(L.missing_fields);
    if (prevStatus === "ready_for_confirmation" && ex.yes && !changed) L.status = "ready_for_team";
    else L.status = qualified ? "ready_for_confirmation" : "qualifying";
    // غير قياسي: عند إعطاء المقاس، أو عند معرفة أن الخيمة أوروبية بعد إعطائه
    ctx.nonstandardJustGiven = L.dimensions_confidence === "nonstandard" && dimsKey(L.suggested_dimensions) !== hadSug;
    ctx.sizingJustDerived = !ex.requested_dimensions && dimsKey(L.suggested_dimensions) !== hadSug
      && ["derived_from_area", "derived_from_guests"].includes(L.dimensions_confidence);
    ctx.changed = changed;
  }
  // حدّ عدم التقدّم: 12 رسالة عميل على نفس الطلب دون تأهيل ⇒ تحويل لإنسان
  const inCount = (await client.query("select count(*)::int n from sales_messages where lead_id=$1 and direction='in'", [lead.id])).rows[0].n;
  if (inCount >= 12 && ["new", "qualifying"].includes(L.status)) L.status = "human_handoff";

  let reply = null, replyStatus = null, blockReason = null, replyMeta = null;
  if (L.status === "human_handoff") replyStatus = null;
  else if (prevStatus === "ready_for_team") {
    reply = history.topics.at_team ? "مسجّل عندي، وأضفته لطلبك عند الفريق 👍"
      : "طلبك عند الفريق وبيتواصلون معك قريباً. إذا عندك أي إضافة أرسلها وأضيفها لطلبك 🌿";
    replyMeta = { topics: ["at_team"], asked: null };
  } else {
    const r = salesEngine.composeSalesReplyEx(L, ctx);
    reply = r.text || null; replyMeta = { topics: r.topics, asked: r.asked };
  }
  if (reply) {
    const g = salesEngine.guardSalesReply(reply);
    if (g.ok) replyStatus = "pending"; else { blockReason = g.reason; reply = null; replyStatus = "blocked"; L.status = "human_handoff"; }
  }

  let teamSummary = lead.team_summary;
  if (L.status === "ready_for_team" && prevStatus !== "ready_for_team") {
    const att = (await client.query("select media_meta, content_type from sales_messages where lead_id=$1 and media_url is not null", [lead.id]))
      .rows.map((r) => ({ name: r.media_meta?.name, content_type: r.content_type }));
    teamSummary = salesEngine.buildTeamSummary(L, att);
  }

  await client.query(
    `update sales_leads set status=$2, request_type=$3, requested_dimensions=$4::jsonb, suggested_dimensions=$5::jsonb,
       dimensions_confidence=$6, size_unsure=$7, approx_area=$8, guest_count=$9, event_type=$10, seating_style=$11,
       start_date=$12, end_date=$13, duration_days=$14, city=$15, location_details=$16, location_lat=$17, location_lng=$18,
       customer_notes=$19, missing_fields=$20, suggested_reply=$21, suggested_reply_status=$22, reply_block_reason=$23,
       team_summary=$24, customer_name=coalesce(customer_name,$25), last_customer_msg_at=$26,
       rental_mode=$27, date_hint=$28, units_count=$29, requested_services=$30, updated_at=now()
     where id=$1`,
    [lead.id, L.status, L.request_type || null, L.requested_dimensions ? JSON.stringify(L.requested_dimensions) : null,
     L.suggested_dimensions ? JSON.stringify(L.suggested_dimensions) : null, L.dimensions_confidence || null, !!L.size_unsure,
     L.approx_area || null, L.guest_count || null, L.event_type || null, L.seating_style || null,
     L.start_date || null, L.end_date || null, L.duration_days || null, L.city || null, L.location_details || null,
     L.location_lat || null, L.location_lng || null, L.customer_notes || null, L.missing_fields || [],
     reply, replyStatus, blockReason, teamSummary || null, payload.sender_name || null, now.toISOString(),
     L.rental_mode || null, L.date_hint || null, L.units_count || null,
     L.requested_services && L.requested_services.length ? L.requested_services : null]);
  if (reply) {
    // extracted للرسائل الصادرة = سجل المواضيع/السؤال — يغذي عدم التكرار في الرسائل التالية
    await client.query(`insert into sales_messages (lead_id, provider, direction, text, content_type, extracted) values ($1,'wahet','out_suggested',$2,'text',$3::jsonb)`,
      [lead.id, reply, JSON.stringify(replyMeta || {})]);
  }
  await logAgentAction(client, {
    actorType: "agent", agentRole: "sales", action: "sales.inbound", targetType: "sales_lead", targetId: lead.id,
    summary: `${prevStatus} → ${L.status}${blockReason ? " (رد محجوب: " + blockReason + ")" : ""}`,
    afterState: { status: L.status, missing_fields: L.missing_fields || [] },
  });
  return { routed: "sales", stored: true, lead_id: lead.id, status: L.status, missing_fields: L.missing_fields || [],
    suggested_reply: reply, reply_status: replyStatus, block_reason: blockReason };
}

async function listSalesLeads(client, { status } = {}) {
  const params = []; let where = "";
  if (status) { params.push(status); where = "where l.status = $1"; }
  const r = await client.query(
    `select l.*, (select text from sales_messages m where m.lead_id=l.id and m.direction='in' order by m.created_at desc limit 1) as last_message,
            (select count(*)::int from sales_messages m where m.lead_id=l.id and m.media_url is not null) as attachments_count
     from sales_leads l ${where} order by coalesce(l.last_customer_msg_at, l.created_at) desc limit 200`, params);
  return r.rows.map(salesRowDates);
}
async function getSalesLead(client, id) {
  const lead = salesRowDates((await client.query("select * from sales_leads where id=$1", [String(id || "")])).rows[0]);
  if (!lead) { const e = new Error("الطلب غير موجود"); e.statusCode = 404; throw e; }
  const messages = (await client.query(
    "select id, direction, text, content_type, media_meta, extracted, message_timestamp, created_at from sales_messages where lead_id=$1 order by created_at", [lead.id])).rows;
  return { ...lead, messages };
}
// Shadow Mode: الاعتماد يُسجَّل فقط — لا إرسال في P2.1.
async function approveSalesReply(client, payload, user) {
  requireSalesUser(user, true);
  const lead = await getSalesLead(client, payload.id);
  if (lead.suggested_reply_status !== "pending" || !lead.suggested_reply) {
    const e = new Error("لا يوجد رد مقترح بانتظار الاعتماد"); e.statusCode = 409; throw e;
  }
  // بصمة النص المعتمد: أي تغيير لاحق في suggested_reply يُبطل الاعتماد عند الإرسال
  await client.query("update sales_leads set suggested_reply_status='approved', reply_approved_by=$2, reply_approved_at=now(), reply_approved_sha256=$3, updated_at=now() where id=$1",
    [lead.id, user.id, sha256(lead.suggested_reply)]);
  await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "sales",
    action: "sales.reply_approved", targetType: "sales_lead", targetId: lead.id, summary: "اعتماد الرد المقترح (وضع الظل — لم يُرسل)" });
  return { id: lead.id, suggested_reply_status: "approved", sent: false };
}
async function handoffSalesLead(client, payload, user) {
  requireSalesUser(user, true);
  const lead = await getSalesLead(client, payload.id);
  if (lead.status !== "ready_for_team") { const e = new Error(`لا يمكن التسليم من حالة ${lead.status}`); e.statusCode = 409; throw e; }
  await client.query("update sales_leads set status='handed_off', handed_off_by=$2, handed_off_at=now(), updated_at=now() where id=$1", [lead.id, user.id]);
  await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "sales",
    action: "sales.handed_off", targetType: "sales_lead", targetId: lead.id, summary: "استلمه الفريق — التسعير يدوياً عبر دفترة" });
  return { id: lead.id, status: "handed_off" };
}
/* ─── P2.3: إرسال محكوم — الاعتماد منفصل عن الإرسال ───
   approve-and-send: يعتمد (إن لزم) ثم يمرّر كل البوابات ثم يُنشئ تفويض إرسال بالنص المعتمد حرفياً.
   النقل الفعلي خارج هذه الدالة (حالياً Peach Co-Pilot MCP بإشراف بشري؛ لاحقاً Peach API)،
   ثم send-result يسجّل النتيجة ويتحقق أن المُرسل = المعتمد. */
const SALES_SEND_WINDOW_MS = 24 * 3600 * 1000 - 5 * 60 * 1000; // هامش 5 دقائق قبل إغلاق النافذة
async function getSalesSendSettings(client) {
  const r = await client.query("select value from app_settings where key='sales_send'");
  const v = r.rows[0]?.value || {};
  return { enabled: v.enabled === true, allowed_phones: Array.isArray(v.allowed_phones) ? v.allowed_phones : [] };
}
async function setSalesSendSettings(client, payload, user) {
  if (!user || user.role !== "owner") { const e = new Error("مفتاح الإرسال لمالك النظام فقط"); e.statusCode = 403; throw e; }
  const before = await getSalesSendSettings(client);
  const next = {
    enabled: payload.enabled === true,
    allowed_phones: (Array.isArray(payload.allowed_phones) ? payload.allowed_phones : before.allowed_phones)
      .map((p) => normalizePhoneE164(p)).filter(Boolean),
  };
  await client.query(`insert into app_settings (key,value) values ('sales_send',$1::jsonb)
    on conflict (key) do update set value=excluded.value`, [JSON.stringify(next)]);
  await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "sales",
    action: next.enabled ? "sales.send_enabled" : "sales.send_disabled", targetType: "app_settings", targetId: null,
    summary: `الإرسال ${next.enabled ? "مفعّل" : "موقوف"} — أرقام مسموحة: ${next.allowed_phones.length}`, beforeState: before, afterState: next });
  return next;
}
// كل بوابات الإرسال — تعيد قائمة الموانع (فارغة = مسموح)
async function salesSendBlockers(client, lead, now = new Date()) {
  const b = [];
  if (process.env.SALES_SEND_HARD_OFF === "1") b.push("kill_switch_env");
  const s = await getSalesSendSettings(client);
  if (!s.enabled) b.push("kill_switch_off");
  if (s.allowed_phones.length && !s.allowed_phones.includes(lead.customer_phone)) b.push("phone_not_in_test_allowlist");
  if (!s.allowed_phones.length) b.push("test_allowlist_empty"); // مرحلة الاختبار: لا إرسال بلا قائمة صريحة
  if (routeInboundTarget(await getIntakeAllowlist(client), lead.customer_phone) === "internal") b.push("team_number");
  if (!lead.peach_conversation_id) b.push("no_conversation");
  const last = (await client.query("select max(message_timestamp) t from sales_messages where lead_id=$1 and direction='in'", [lead.id])).rows[0].t;
  if (!last || now.getTime() - new Date(last).getTime() > SALES_SEND_WINDOW_MS) b.push("reply_window_closed");
  if (!lead.suggested_reply) b.push("no_suggested_reply");
  else {
    if (lead.suggested_reply_status !== "approved") b.push("not_approved");
    if (!lead.reply_approved_sha256 || sha256(lead.suggested_reply) !== lead.reply_approved_sha256) b.push("text_changed_after_approval");
    const g = salesEngine.guardSalesReply(lead.suggested_reply);
    if (!g.ok) b.push("guardrail:" + g.reason);
  }
  if (["human_handoff", "handed_off", "stale"].includes(lead.status)) b.push("lead_status_" + lead.status);
  return b;
}
async function approveAndSendSalesReply(client, payload, user, opts = {}) {
  requireSalesUser(user, true);
  let lead = await getSalesLead(client, payload.id);
  if (lead.suggested_reply_status === "pending" && lead.suggested_reply) {
    await approveSalesReply(client, { id: lead.id }, user);
    lead = await getSalesLead(client, lead.id);
  }
  const blockers = await salesSendBlockers(client, lead, opts.now || new Date());
  if (blockers.length) {
    await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "sales",
      action: "sales.send_refused", targetType: "sales_lead", targetId: lead.id, status: "failed", summary: blockers.join(", ") });
    const e = new Error("الإرسال مرفوض: " + blockers.join("، ")); e.statusCode = 409; e.blockers = blockers; throw e;
  }
  let ob;
  try {
    ob = (await client.query(
      `insert into sales_outbound (lead_id, suggested_text, text_sha256, approved_by, approved_by_name, approved_at, transport, peach_conversation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [lead.id, lead.suggested_reply, lead.reply_approved_sha256, lead.reply_approved_by, user.name, lead.reply_approved_at,
       opts.transport || "peach_mcp", lead.peach_conversation_id])).rows[0];
  } catch (err) {
    if (err.code === "23505") { const e = new Error("يوجد تفويض إرسال مفتوح لهذا الطلب"); e.statusCode = 409; throw e; }
    throw err;
  }
  await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "sales",
    action: "sales.send_authorized", targetType: "sales_lead", targetId: lead.id,
    summary: `تفويض إرسال ${ob.id} عبر ${ob.transport}`, afterState: { outbound_id: ob.id, sha256: ob.text_sha256 } });
  return { outbound_id: ob.id, status: "authorized", transport: ob.transport, conversation_id: ob.peach_conversation_id, text: ob.suggested_text };
}
async function recordSalesSendResult(client, payload, user) {
  requireSalesUser(user, true);
  const ob = (await client.query("select * from sales_outbound where id=$1", [String(payload.outbound_id || "")])).rows[0];
  if (!ob) { const e = new Error("تفويض الإرسال غير موجود"); e.statusCode = 404; throw e; }
  if (ob.status !== "authorized") { const e = new Error(`التفويض ليس مفتوحاً (${ob.status})`); e.statusCode = 409; throw e; }
  const sentText = payload.sent_text != null ? String(payload.sent_text) : null;
  let ok = payload.ok === true, error = payload.error ? String(payload.error).slice(0, 500) : null;
  if (ok && (sentText == null || sha256(sentText) !== ob.text_sha256)) { ok = false; error = "النص المُرسل لا يطابق النص المعتمد"; }
  const pmid = payload.peach_message_id != null ? String(payload.peach_message_id) : null;
  await client.query("update sales_outbound set status=$2, sent_text=$3, peach_message_id=$4, error=$5, sent_at=case when $2='sent' then now() else sent_at end where id=$1",
    [ob.id, ok ? "sent" : "failed", sentText, pmid, error]);
  await client.query("update sales_leads set suggested_reply_status=$2, updated_at=now() where id=$1 and reply_approved_sha256=$3",
    [ob.lead_id, ok ? "sent" : "send_failed", ob.text_sha256]);
  if (ok) {
    await client.query(`insert into sales_messages (lead_id, provider, provider_message_id, direction, text, content_type, extracted, message_timestamp)
      values ($1,'peach',$2,'out_sent',$3,'text',$4::jsonb, now())`, [ob.lead_id, pmid, sentText, JSON.stringify({ outbound_id: ob.id })]);
  }
  await logAgentAction(client, { actorType: "human", actorRef: user.id, actorName: user.name, agentRole: "sales",
    action: ok ? "sales.sent" : "sales.send_failed", targetType: "sales_lead", targetId: ob.lead_id, status: ok ? "done" : "failed",
    summary: ok ? `أُرسل عبر ${ob.transport} — رسالة ${pmid || "?"}` : `فشل الإرسال: ${error}`, errorMessage: ok ? null : error,
    afterState: { outbound_id: ob.id, peach_message_id: pmid } });
  return { outbound_id: ob.id, status: ok ? "sent" : "failed", error };
}

async function markStaleSalesLeads(client, now = new Date(), days = 7) {
  const r = await client.query(
    `update sales_leads set status='stale', updated_at=now()
     where status in ('new','qualifying','ready_for_confirmation') and coalesce(last_customer_msg_at, created_at) < $1::timestamptz - make_interval(days => $2)
     returning id`, [now.toISOString(), days]);
  return r.rowCount;
}

async function dashboard(client, user) {
  const finance = await listFinance(client);
  const quoteStates = await listQuoteStates(client);
  const staffDocs = await listStaffDocs(client);
  const vehicles = await listVehicleTasks(client);
  const generalAlerts = await listGeneralAlerts(client);
  const tenders = await listTenders(client);
  const daftraSettings = await getSetting(client, "daftra");
  const daftraClientsCache = await getDaftraClientsCache(client);
  const daftraFinanceCache = await getDaftraFinanceCache(client);
  const daftraCapabilities = await getDaftraCapabilities(client);
  const bankStatement = await getBankStatementCache(client);
  const financeMeta = await getFinanceMeta(client);
  const chartAccounts = await listChartAccounts(client);
  const users = await client.query(
    "select id, name, phone, email, role, is_active from app_users where is_active = true order by created_at asc"
  );
  return {
    ok: true,
    currentUser: user,
    finance,
    quoteStates,
    staffDocs,
    vehicles,
    generalAlerts,
    tenders,
    clients: daftraClientsCache.clients,
    daftraSync: {
      syncedAt: daftraClientsCache.syncedAt,
      counts: daftraClientsCache.counts,
      financeSyncedAt: daftraFinanceCache.syncedAt,
      financeCounts: daftraFinanceCache.counts,
      financeErrors: daftraFinanceCache.errors,
    },
    daftraFinance: daftraFinanceCache,
    daftraCapabilities,
    bankStatement,
    financeMeta,
    chartAccounts,
    settings: {
      daftra: publicDaftraSettings(daftraSettings),
    },
    users: users.rows,
  };
}


// استخراج نص PDF بلا اعتماديات (FlateDecode + عوامل Tj/TJ).
// مُتحقَّق على إيصال تحويل حقيقي: الحقول اللاتينية/الرقمية تُقرأ، والعربية مشوّهة (CMap مخصّص).
function pdfExtractText(buf) {
  const zlib = require("zlib");
  const s = buf.toString("latin1");
  const out = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(s))) {
    const data = Buffer.from(m[1], "latin1");
    let txt = null;
    try { txt = zlib.inflateSync(data).toString("latin1"); }
    catch (_) { try { txt = zlib.inflateRawSync(data).toString("latin1"); } catch (_) { txt = null; } }
    if (!txt || !/(Tj|TJ)/.test(txt)) continue;
    const parts = [];
    const tj = /\((?:\\.|[^\\()])*\)/g;
    let t;
    while ((t = tj.exec(txt))) parts.push(t[0].slice(1, -1).replace(/\\([()\\])/g, "$1"));
    if (parts.length) out.push(parts.join(""));
  }
  return out.join("\n");
}

module.exports = async function handler(req, res) {
  sendCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const path = String(req.query.path || req.url.split("/api/app")[1] || "/").split("?")[0];
  if (req.method === "GET" && path === "/health") {
    try {
      const healthClient = await getPool().connect();
      try {
        await healthClient.query("select 1");
        return res.status(200).json({ ok: true, database: "connected" });
      } finally {
        healthClient.release();
      }
    } catch (err) {
      return res.status(503).json({ ok: false, database: "error", error: err.message });
    }
  }

  let client;
  try {
    client = await getPool().connect();
    const requestUrl = new URL(req.url || "/", "http://local");
    const query = { ...(req.query || {}), ...Object.fromEntries(requestUrl.searchParams.entries()) };
    // الجلسة من كوكي HttpOnly (المتصفح)، أو من الترويسة للأدوات والسكربتات
    const token = req.headers["x-wahet-token"] || parseCookies(req.headers.cookie)[SESSION_COOKIE] || "";
    const user = await getUserFromToken(client, token);

    if (req.method === "POST" && path === "/auth/login") {
      const r = await login(client, req.body || {});
      res.setHeader("Set-Cookie", sessionCookie(r.token, r.persistent));
      return res.status(200).json({ ok: true, data: { user: r.user, persistent: r.persistent, expires_at: r.expires_at } });
    }
    if (req.method === "POST" && path === "/auth/logout") {
      const revoked = await revokeSession(client, token);
      res.setHeader("Set-Cookie", clearSessionCookie());
      return res.status(200).json({ ok: true, data: { revoked } });
    }
    if (req.method === "POST" && path === "/auth/change-password") {
      return res.status(200).json({ ok: true, data: await changeOwnPassword(client, req.body || {}, user, token) });
    }
    if (req.method === "GET" && path === "/auth/me") {
      if (!user) return res.status(401).json({ ok: false, error: "لا توجد جلسة صالحة" });
      return res.status(200).json({ ok: true, data: { user } });
    }

    // WhatsApp Intake (M1): استقبال آلي عبر مفتاح خدمة (machine-to-machine)
    if (req.method === "POST" && path === "/intake/whatsapp") {
      const secret = process.env.INTAKE_SECRET;
      if (!secret) return res.status(503).json({ ok: false, error: "INTAKE_SECRET غير مُعد على الخادم" });
      if (String(req.headers["x-intake-secret"] || "") !== secret) {
        return res.status(401).json({ ok: false, error: "مفتاح الوارد غير صحيح" });
      }
      const data = await createWhatsappIntake(client, req.body || {});
      return res.status(data.stored ? 201 : 200).json({ ok: true, data });
    }

    // WhatsApp Intake Review (M2) — شاشة الصندوق والمراجعة البشرية (جلسة مستخدم)
    if (req.method === "GET" && path === "/intake") {
      requireIntakeApprover(user); // M2.5: القراءة أيضاً محصورة بـ owner/accountant
      return res.status(200).json({ ok: true, data: await listIntake(client, { status: query.status }) });
    }
    // إدارة قائمة الموثوقين (owner فقط) — يجب أن تسبق مطابقة /intake/:id العامة
    if (req.method === "GET" && path === "/intake/allowlist") {
      requireIntakeAdmin(user);
      return res.status(200).json({ ok: true, data: await listIntakeAllowlist(client) });
    }
    if (req.method === "POST" && path === "/intake/allowlist") {
      return res.status(200).json({ ok: true, data: await upsertIntakeAllowlistMember(client, req.body || {}, user) });
    }
    if (req.method === "GET" && path.startsWith("/intake/") && path !== "/intake/whatsapp" && path !== "/intake/allowlist") {
      requireIntakeApprover(user);
      const id = decodeURIComponent(path.slice("/intake/".length));
      return res.status(200).json({ ok: true, data: await getIntake(client, id) });
    }
    if (req.method === "POST" && path === "/intake/update") {
      return res.status(200).json({ ok: true, data: await updateIntake(client, req.body || {}, user) });
    }
    if (req.method === "POST" && path === "/intake/approve") {
      return res.status(200).json({ ok: true, data: await approveIntake(client, req.body || {}, user) });
    }
    if (req.method === "POST" && path === "/intake/reject") {
      return res.status(200).json({ ok: true, data: await rejectIntake(client, req.body || {}, user) });
    }
    // P2.1: وكيل المبيعات — Shadow Mode (لا إرسال واتساب، لا دفترة، لا finance)
    if (req.method === "POST" && path === "/sales/inbound") {
      const secret = process.env.INTAKE_SECRET;
      if (!secret) return res.status(503).json({ ok: false, error: "INTAKE_SECRET غير مُعد على الخادم" });
      if (String(req.headers["x-intake-secret"] || "") !== secret) return res.status(401).json({ ok: false, error: "مفتاح الوارد غير صحيح" });
      return res.status(200).json({ ok: true, data: await handleSalesInbound(client, req.body || {}) });
    }
    if (req.method === "GET" && path === "/sales/leads") {
      requireSalesUser(user);
      return res.status(200).json({ ok: true, data: await listSalesLeads(client, { status: query.status }) });
    }
    if (req.method === "GET" && path.startsWith("/sales/leads/")) {
      requireSalesUser(user);
      return res.status(200).json({ ok: true, data: await getSalesLead(client, decodeURIComponent(path.slice("/sales/leads/".length))) });
    }
    if (req.method === "POST" && path === "/sales/approve-reply") {
      return res.status(200).json({ ok: true, data: await approveSalesReply(client, req.body || {}, user) });
    }
    // P2.3: الإرسال منفصل تماماً عن /sales/approve-reply (الذي لا يرسل أبداً)
    if (req.method === "POST" && path === "/sales/approve-and-send") {
      return res.status(200).json({ ok: true, data: await approveAndSendSalesReply(client, req.body || {}, user) });
    }
    if (req.method === "POST" && path === "/sales/send-result") {
      return res.status(200).json({ ok: true, data: await recordSalesSendResult(client, req.body || {}, user) });
    }
    if (req.method === "POST" && path === "/sales/send-settings") {
      return res.status(200).json({ ok: true, data: await setSalesSendSettings(client, req.body || {}, user) });
    }
    if (req.method === "POST" && path === "/sales/handoff") {
      return res.status(200).json({ ok: true, data: await handoffSalesLead(client, req.body || {}, user) });
    }

    // M2.5: تحليل AI لسجل وارد (يشغّله الوكيل بمفتاح الخدمة أو مخوّل بشري)
    if (req.method === "POST" && path === "/intake/parse") {
      const secret = process.env.INTAKE_SECRET;
      const bySecret = secret && String(req.headers["x-intake-secret"] || "") === secret;
      if (!bySecret) requireIntakeApprover(user);
      return res.status(200).json({ ok: true, data: await parseIntake(client, (req.body || {}).id) });
    }

    if (req.method === "GET" && (path === "/" || path === "" || path === "/bootstrap")) {
      return res.status(200).json(await dashboard(client, user));
    }

    if (req.method === "GET" && path === "/finance") {
      return res.status(200).json({ ok: true, data: await listFinance(client) });
    }

    if (req.method === "GET" && path === "/chart-accounts") {
      const onlyPostable = query.postable === "1" || query.postable === "true";
      return res.status(200).json({ ok: true, data: await listChartAccounts(client, onlyPostable) });
    }

    if (req.method === "POST" && path === "/chart-accounts/import") {
      const accounts = await importChartAccounts(client, req.body || {});
      return res.status(200).json({ ok: true, data: accounts });
    }

    if (req.method === "GET" && path === "/quote-states") {
      return res.status(200).json({ ok: true, data: await listQuoteStates(client) });
    }

    if (req.method === "POST" && path === "/quote-states") {
      return res.status(200).json({ ok: true, data: await saveQuoteState(client, req.body || {}, user) });
    }

    if (req.method === "GET" && path === "/staff-docs") {
      return res.status(200).json({ ok: true, data: await listStaffDocs(client) });
    }

    if (req.method === "POST" && path === "/staff-docs") {
      return res.status(201).json({ ok: true, data: await createStaffDoc(client, req.body || {}) });
    }

    if (req.method === "POST" && path === "/staff-docs/delete") {
      await deleteStaffDoc(client, String(req.body?.id || ""));
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET" && path === "/vehicle-tasks") {
      return res.status(200).json({ ok: true, data: await listVehicleTasks(client) });
    }

    if (req.method === "POST" && path === "/vehicle-tasks") {
      return res.status(201).json({ ok: true, data: await createVehicleTask(client, req.body || {}) });
    }

    if (req.method === "POST" && path === "/vehicle-tasks/delete") {
      await deleteVehicleTask(client, String(req.body?.id || ""));
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET" && path === "/general-alerts") {
      return res.status(200).json({ ok: true, data: await listGeneralAlerts(client) });
    }

    if (req.method === "POST" && path === "/general-alerts") {
      return res.status(201).json({ ok: true, data: await createGeneralAlert(client, req.body || {}) });
    }

    if (req.method === "POST" && path === "/general-alerts/delete") {
      await deleteGeneralAlert(client, String(req.body?.id || ""));
      return res.status(200).json({ ok: true });
    }

    if (req.method === "GET" && path === "/tenders") {
      return res.status(200).json({ ok: true, data: await listTenders(client) });
    }

    if (req.method === "POST" && path === "/tenders") {
      return res.status(201).json({ ok: true, data: await createTender(client, req.body || {}) });
    }

    if (req.method === "POST" && path === "/tenders/status") {
      return res.status(200).json({ ok: true, data: await updateTenderScore(client, req.body || {}) });
    }

    if (req.method === "POST" && path === "/tenders/delete") {
      await deleteTender(client, String(req.body?.id || ""));
      return res.status(200).json({ ok: true });
    }

    if ((req.method === "POST" || req.method === "GET") && path === "/tenders/radar-scan") {
      // حارس تعطيل الرادار/الـcron على staging فقط (DISABLE_CRON=1 يُضبط في env المشروع البعيد).
      // عند تفعيله: لا اتصال بـEtimad، لا Anthropic، لا كتابة في القاعدة. الإنتاج لا يضبط المتغير ⇒ سلوكه دون تغيير.
      if (process.env.DISABLE_CRON === "1") {
        return res.status(200).json({ ok: true, skipped: true, reason: "cron_disabled" });
      }
      const radar = await scanEtimadTenders(client);
      return res.status(200).json({ ok: true, data: radar });
    }

    if (req.method === "GET" && path === "/settings/daftra") {
      return res.status(200).json({ ok: true, data: publicDaftraSettings(await getSetting(client, "daftra")) });
    }

    if (req.method === "POST" && path === "/settings/daftra") {
      const existing = (await getSetting(client, "daftra")) || {};
      const payload = { ...(req.body || {}) };
      if (!String(payload.apikey || "").trim() && existing.apikey) payload.apikey = existing.apikey;
      const saved = await setSetting(client, "daftra", validateDaftraSettings(payload));
      return res.status(200).json({ ok: true, data: publicDaftraSettings(saved) });
    }

    if (req.method === "GET" && path === "/daftra/capabilities") {
      return res.status(200).json({ ok: true, data: await getDaftraCapabilities(client) });
    }

    if ((req.method === "POST" || req.method === "GET") && path === "/daftra/source-test") {
      const source = req.body?.source || query.source || "";
      const result = await testDaftraSource(client, String(source));
      const current = await getDaftraCapabilities(client);
      const sources = (current.sources || []).filter((row) => row.key !== result.key).concat([result]);
      const saved = await setDaftraCapabilities(client, sources);
      return res.status(200).json({ ok: true, data: { result, capabilities: saved } });
    }

    if (req.method === "GET" && path === "/clients-cache") {
      return res.status(200).json({ ok: true, data: await getDaftraClientsCache(client) });
    }

    if (req.method === "POST" && path === "/clients-cache") {
      const saved = await setDaftraClientsCache(client, req.body || {});
      return res.status(200).json({ ok: true, data: saved });
    }

    if ((req.method === "POST" || req.method === "GET") && path === "/sync-daftra-cache") {
      const saved = await syncDaftraClientsCache(client);
      return res.status(200).json({
        ok: true,
        data: {
          syncedAt: saved.syncedAt,
          counts: saved.counts,
          clientsCount: Array.isArray(saved.clients) ? saved.clients.length : 0,
          financeSyncedAt: saved.finance?.syncedAt || null,
          financeCounts: saved.finance?.counts || { expenses: 0, custodies: 0 },
          financeErrors: saved.finance?.errors || [],
          capabilities: saved.capabilities || null,
        },
      });
    }

    if (req.method === "GET" && path === "/bank-statement") {
      return res.status(200).json({ ok: true, data: await getBankStatementCache(client) });
    }

    if (req.method === "POST" && path === "/bank-statement") {
      const saved = await setBankStatementCache(client, req.body || {});
      return res.status(200).json({ ok: true, data: saved });
    }

    if (req.method === "GET" && path === "/finance-meta") {
      return res.status(200).json({ ok: true, data: await getFinanceMeta(client) });
    }

    if (req.method === "POST" && path === "/finance-meta") {
      const saved = await setFinanceMeta(client, req.body || {});
      return res.status(200).json({ ok: true, data: saved });
    }

    if (req.method === "POST" && path === "/finance") {
      const entry = await createFinance(client, req.body || {}, user);
      // fire email notification (non-blocking)
      setImmediate(async () => {
        let c2;
        try {
          c2 = await getPool().connect();
          await sendEventEmail(c2, "finance", {
            subject: `حركة مالية جديدة: ${entry.type} — ${Number(entry.amount||0).toLocaleString()} ر.س`,
            html: financeEmailHtml(entry),
            relatedType: "finance", relatedId: entry.id,
          });
        } catch(e) {} finally { if (c2) c2.release(); }
      });
      return res.status(201).json({ ok: true, data: entry });
    }

    if (req.method === "POST" && path === "/finance/status") {
      const entry = await updateFinanceStatus(client, req.body || {}, user);
      return res.status(200).json({ ok: true, data: entry });
    }

    if (req.method === "POST" && path === "/finance/update") {
      const entry = await updateFinanceEntry(client, req.body || {}, user);
      return res.status(200).json({ ok: true, data: entry });
    }

    if (req.method === "POST" && path === "/finance/rename-account") {
      const renamed = await renameBankAccount(client, req.body || {}, user);
      return res.status(200).json({ ok: true, data: renamed });
    }

    /* ─── Email endpoints ─── */
    /* ── helper: owner-only guard ── */
    const requireOwner = () => {
      if (!user || user.role !== "owner") {
        const err = new Error("غير مصرح — هذه الوظيفة لبندر فقط");
        err.statusCode = 403;
        throw err;
      }
    };

    if (req.method === "GET" && path === "/email/logs") {
      requireOwner();
      await ensureEmailLogTable(client);
      const logs = await client.query(
        "select * from email_notification_logs order by created_at desc limit 200"
      );
      return res.status(200).json({ ok: true, data: logs.rows });
    }

    if (req.method === "POST" && path === "/email/test") {
      requireOwner();
      const targetUser = String(req.body?.user || "").trim();
      const prefs = await getNotificationPrefs(client);
      const cfg = prefs[targetUser];
      if (!cfg || !cfg.email) {
        return res.status(200).json({ ok: false, error: "لا يوجد إيميل لهذا الحساب" });
      }
      const subject = "اختبار تنبيهات واحة الخيمة";
      const html = `<div dir="rtl" style="font-family:Arial,sans-serif">
        <h2>🏕️ واحة الخيمة</h2>
        <p>هذه رسالة اختبار من نظام تنبيهات واحة الخيمة.</p>
        <p>إذا وصلتك هذه الرسالة فإعدادات البريد تعمل بشكل صحيح.</p>
        <p style="color:#888;font-size:12px">أُرسلت في: ${new Date().toLocaleString("ar-SA")}</p>
      </div>`;
      const result = await sendEmail(cfg.email, subject, html);
      await logEmailNotification(client, {
        type: "test", userId: targetUser, email: cfg.email,
        relatedType: "test", relatedId: null, subject,
        status: result.ok ? "sent" : "failed",
        error: result.ok ? null : result.error,
      });
      return res.status(200).json({ ok: result.ok, error: result.error });
    }

    if (req.method === "POST" && path === "/users/update-notifications") {
      requireOwner();
      const prefs = await getNotificationPrefs(client);
      const { userName, email, enabled, types } = req.body || {};
      if (!userName) return res.status(400).json({ ok: false, error: "userName مطلوب" });
      prefs[userName] = { email: email || "", enabled: !!enabled, types: Array.isArray(types) ? types : [] };
      await setSetting(client, "notification_prefs", prefs);
      return res.status(200).json({ ok: true, data: prefs });
    }

    if (req.method === "GET" && path === "/users/notification-prefs") {
      requireOwner();
      const prefs = await getNotificationPrefs(client);
      return res.status(200).json({ ok: true, data: prefs });
    }

    if (req.method === "POST" && path === "/email/check-payment-alerts") {
      requireOwner();
      // Check confirmed quotes with install date in 2 days and remaining > 0
      await ensureEmailLogTable(client);
      const prefs = await getNotificationPrefs(client);
      // Find saddam's config
      const saddamCfg = prefs["صدام"];
      const results = [];

      if (!saddamCfg || !saddamCfg.email || !saddamCfg.enabled) {
        return res.status(200).json({ ok: true, data: [], message: "تنبيهات المحاسب غير مفعلة أو لا يوجد إيميل" });
      }
      if (!Array.isArray(saddamCfg.types) || !saddamCfg.types.includes("payment_due")) {
        return res.status(200).json({ ok: true, data: [], message: "تنبيه استحقاق الدفعات غير مفعل للمحاسب" });
      }

      // Get daftra_quote_states with install_date = today + 2
      const twoDaysLater = new Date();
      twoDaysLater.setDate(twoDaysLater.getDate() + 2);
      const targetDate = twoDaysLater.toISOString().slice(0, 10);

      const quotes = await client.query(
        `select q.*, c.name as client_name
         from daftra_quote_states q
         left join customers c on c.name = q.assigned_to
         where q.quote_confirmed = true
           and q.install_date = $1`,
        [targetDate]
      );

      for (const q of quotes.rows) {
        const relatedId = q.local_key;
        // Check if already notified
        const existing = await client.query(
          `select id from email_notification_logs
           where notification_type = 'payment_due' and related_id = $1 and recipient_user_id = 'صدام'
           limit 1`,
          [relatedId]
        );
        if (existing.rows.length > 0) {
          results.push({ relatedId, skipped: true, reason: "تم الإرسال مسبقاً" });
          continue;
        }

        const clientName = q.client_name || q.assigned_to || "عميل";
        const subject = "تنبيه استحقاق دفعة قبل التركيب";
        const html = `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <h2 style="color:#b91c1c">⚠️ تنبيه استحقاق دفعة</h2>
          <p>يوجد عميل موعد تركيبه بعد يومين (${targetDate}) ولديه مبلغ متبقي:</p>
          <table style="width:100%;border-collapse:collapse;margin:12px 0">
            <tr style="background:#f5f5f5"><td style="padding:8px">اسم العميل</td><td style="padding:8px;font-weight:bold">${clientName}</td></tr>
            <tr><td style="padding:8px">رقم المرجع</td><td style="padding:8px">${q.local_key||'—'}</td></tr>
            <tr style="background:#f5f5f5"><td style="padding:8px">تاريخ التركيب</td><td style="padding:8px">${targetDate}</td></tr>
            <tr><td style="padding:8px">ملاحظات</td><td style="padding:8px">${q.notes||'—'}</td></tr>
          </table>
          <p style="color:#888;font-size:12px">أُرسل من نظام واحة الخيمة</p>
        </div>`;

        const result = await sendEmail(saddamCfg.email, subject, html);
        await logEmailNotification(client, {
          type: "payment_due", userId: "صدام", email: saddamCfg.email,
          relatedType: "quote", relatedId,
          subject, status: result.ok ? "sent" : "failed",
          error: result.ok ? null : result.error,
        });
        results.push({ relatedId, clientName, sent: result.ok, error: result.error });
      }

      return res.status(200).json({ ok: true, data: results });
    }

    /* ─── Finance soft-delete endpoint ─── */
    if (req.method === "POST" && path === "/finance/soft-delete") {
      const { id, deletedBy, deletionReason } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: "id مطلوب" });
      await client.query(`
        alter table finance_entries
          add column if not exists is_deleted boolean not null default false,
          add column if not exists deleted_at timestamptz,
          add column if not exists deleted_by text,
          add column if not exists deletion_reason text
      `);
      await client.query(
        `update finance_entries set is_deleted = true, deleted_at = now(), deleted_by = $1, deletion_reason = $2 where id = $3`,
        [deletedBy || '—', deletionReason || '—', id]
      );
      // Fire email if configured
      try {
        await sendEventEmail(client, "finance_delete", {
          subject: "تم حذف حركة مالية",
          html: `<div dir="rtl"><h3>🗑️ تم حذف حركة مالية</h3><p>بواسطة: ${deletedBy||'—'}</p><p>السبب: ${deletionReason||'—'}</p></div>`,
          relatedType: "finance", relatedId: id,
        });
      } catch(e) {}
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ ok: false, error: "المسار غير موجود" });
  } catch (err) {
    const status = err.statusCode || (err.message.includes("DATABASE_URL") ? 503 : 500);
    return res.status(status).json({ ok: false, error: err.message });
  } finally {
    if (client) client.release();
  }
};

// تصدير دوال M1 الداخلية لأغراض الاختبار فقط (لا يؤثر على handler الافتراضي في Vercel)
module.exports.__m1 = {
  normalizePhoneE164, computeIntakeDedupHash, createWhatsappIntake,
  getIntakeAllowlist, findAllowlistMember,
};
// دوال M2 (مراجعة الصندوق) لأغراض الاختبار فقط
module.exports.__m2 = {
  listIntake, getIntake, updateIntake, approveIntake, rejectIntake, intakeRow,
};
// دوال M2.5 (تحليل AI) لأغراض الاختبار فقط
module.exports.__m25 = {
  parseIntake, ruleClassify, finalizeIntakeParse, resolveAccountsFromText,
  ruleIntakeParser, getIntakeParser, extractIntakeAmount,
};
// دوال M2.6 (إدارة الموثوقين) لأغراض الاختبار فقط
module.exports.__m26 = {
  listIntakeAllowlist, upsertIntakeAllowlistMember, requireIntakeAdmin,
};
// دوال P1.7 (المرفقات والاستخراج) لأغراض الاختبار فقط
module.exports.__p17 = {
  fetchAttachment, processAttachment, extractReceiptFields, pdfExtractText, ATTACHMENT_HOSTS,
  parseFinancialCaption, ruleClassify,
};
// دوال P2.1 (وكيل المبيعات) لأغراض الاختبار فقط
module.exports.__p21 = {
  handleSalesInbound, listSalesLeads, getSalesLead, approveSalesReply, handoffSalesLead,
  markStaleSalesLeads, routeInboundTarget, requireSalesUser, hasPermission, getUserFromToken, KNOWN_PERMISSIONS,
};
module.exports.__auth = {
  hashLoginCode, verifyLoginCode, login, getUserFromToken, revokeSession, sessionCookie, clearSessionCookie, parseCookies,
  changeOwnPassword, validateNewPassword, MIN_PASSWORD_LEN,
};
module.exports.__p23 = {
  approveAndSendSalesReply, recordSalesSendResult, salesSendBlockers, getSalesSendSettings, setSalesSendSettings,
};
