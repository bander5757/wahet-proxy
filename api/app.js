const { Pool } = require("pg");
const crypto = require("crypto");

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
  "خيام",
  "خيمة",
  "خيم",
  "فعاليات",
  "مؤتمرات",
  "معارض",
  "اللقاءات",
  "ورش العمل",
  "ضيافة",
  "استقبال",
  "مهرجان",
  "مخيم",
];
const RADAR_NEGATIVE_WORDS = [
  "قطع غيار",
  "سيارات",
  "نظافة",
  "تقنية المعلومات",
  "رخص رقمية",
  "طباعة",
  "فريون",
  "قواعد البيانات",
  "معدات التحقق",
];

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
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
  const strong = textIncludesAny(text, ["خيام", "خيمة", "خيم", "مخيم"]);
  const event = textIncludesAny(text, ["فعاليات", "مؤتمرات", "معارض", "اللقاءات", "ورش العمل", "ضيافة", "استقبال", "مهرجان"]);
  if (!strong && !event) return null;
  return {
    status: strong ? "fit" : "review",
    action: strong ? "تجهيز عرض سعر" : "مراجعة الرابط",
    reason: strong
      ? `مطابقة قوية لكلمة ${keyword}: ${item.tenderActivityName || item.tenderTypeName || "منافسة اعتماد"}`
      : `فرصة محتملة مرتبطة بالفعاليات أو الضيافة: ${item.tenderActivityName || item.tenderTypeName || "منافسة اعتماد"}`,
  };
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
  for (const { item, keyword, fit } of seen.values()) {
    const externalKey = `etimad:${item.tenderId || item.referenceNumber || item.tenderNumber}`;
    const sourceUrl = etimadSearchUrl(keyword);
    const result = await client.query(
      `insert into tenders
        (title, entity_name, source_name, source_url, external_key, matched_keyword,
         opportunity_type, due_on, fit_status, fit_reason, suggested_action, follow_status, decision, last_seen_at)
       values ($1, $2, 'اعتماد', $3, $4, $5, 'tender', $6, $7, $8, $9, 'new', $10, now())
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
        sourceUrl,
        externalKey,
        keyword,
        item.lastOfferPresentationDate ? String(item.lastOfferPresentationDate).slice(0, 10) : null,
        fit.status,
        `${fit.reason}. رقم المنافسة: ${item.referenceNumber || item.tenderNumber || item.tenderId}. نوعها: ${item.tenderTypeName || "غير محدد"}.`,
        fit.action,
        `نشاط اعتماد: ${item.tenderActivityName || "غير محدد"}`,
      ]
    );
    saved.push(tenderRow(result.rows[0]));
  }

  return { saved, errors, keywords: RADAR_KEYWORDS };
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

  const [estimates, invoices, quoteStates] = await Promise.all([
    fetchPages("estimates"),
    fetchPages("invoices"),
    listQuoteStates(client),
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

  return setDaftraClientsCache(client, {
    clients: merged,
    syncedAt: new Date().toISOString(),
    counts: { estimates: estimates.length, invoices: invoices.length },
  });
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
        (entry_type, amount, account_id, related_user_id, category, statement, status, entry_date)
       values ($1, $2, $3, $4, $5, $6, $7, current_date)
       returning *`,
      [entryType, amount, accountId, relatedUserId, payload.category || null, String(payload.note || payload.statement).trim(), initialStatus]
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
  const result = await client.query(
    `update finance_entries
     set amount = $1,
         account_id = $2,
         statement = case when $3::text <> '' then $3::text else statement end
     where id = $4
     returning *`,
    [amount, accountId, String(payload.note || payload.statement || "").trim(), id]
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
  const bankStatement = await getBankStatementCache(client);
  const financeMeta = await getFinanceMeta(client);
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
    },
    bankStatement,
    financeMeta,
    settings: {
      daftra: daftraSettings,
    },
    users: users.rows,
  };
}

module.exports = async function handler(req, res) {
  sendCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  let client;
  try {
    client = await getPool().connect();
    const path = String(req.query.path || req.url.split("/api/app")[1] || "/").split("?")[0];
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
      return res.status(200).json({ ok: true, data: await getSetting(client, "daftra") });
    }

    if (req.method === "POST" && path === "/settings/daftra") {
      const saved = await setSetting(client, "daftra", validateDaftraSettings(req.body || {}));
      return res.status(200).json({ ok: true, data: saved });
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

    return res.status(404).json({ ok: false, error: "المسار غير موجود" });
  } catch (err) {
    const status = err.statusCode || (err.message.includes("DATABASE_URL") ? 503 : 500);
    return res.status(status).json({ ok: false, error: err.message });
  } finally {
    if (client) client.release();
  }
};
