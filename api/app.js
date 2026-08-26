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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Wahet-User");
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

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    role: row.role,
  };
}

async function getUserFromToken(client, token) {
  if (!token) return null;
  const result = await client.query(
    `select u.id, u.name, u.phone, u.email, u.role
     from app_sessions s
     join app_users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and u.is_active = true
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
    `select id, name, phone, email, role, login_code_hash
     from app_users
     where is_active = true and (email = $1 or phone = $1 or name = $1)
     limit 1`,
    [identifier]
  );
  const user = result.rows[0];
  if (!user || user.login_code_hash !== sha256(code)) {
    const err = new Error("بيانات الدخول غير صحيحة");
    err.statusCode = 401;
    throw err;
  }
  const token = crypto.randomBytes(32).toString("hex");
  await client.query(
    "insert into app_sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '30 days')",
    [user.id, sha256(token)]
  );
  return { token, user: publicUser(user) };
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
    const token = req.headers["x-wahet-token"] || "";
    const user = await getUserFromToken(client, token);

    if (req.method === "POST" && path === "/auth/login") {
      return res.status(200).json({ ok: true, data: await login(client, req.body || {}) });
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
