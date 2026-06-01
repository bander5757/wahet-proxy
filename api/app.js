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
  };
}

function generalAlertRow(row) {
  return {
    id: row.id,
    title: row.title,
    due: row.due_on,
    note: row.notes || "",
    status: row.status || "open",
  };
}

function tenderRow(row) {
  return {
    id: row.id,
    title: row.title,
    entity: row.entity_name || "",
    platform: row.source_name || "",
    url: row.source_url || "#",
    keyword: row.matched_keyword || "",
    due: row.due_on || "",
    score: TENDER_STATUS_LABELS[row.fit_status] || "تحتاج مراجعة",
    reason: row.fit_reason || "",
    decision: row.decision || "",
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
  const type = accountName === "الحساب الفرعي" ? "secondary" : accountName === "كاش" ? "cash" : "official";
  const found = await client.query(
    "select id from bank_accounts where account_type = $1 and is_active = true order by created_at asc limit 1",
    [type]
  );
  if (found.rows[0]) return found.rows[0].id;
  const inserted = await client.query(
    "insert into bank_accounts (name, account_type) values ($1, $2) returning id",
    [accountName || "الحساب الرسمي", type]
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

async function listStaffDocs(client) {
  const result = await client.query(`
    select id, employee_name, document_type, expires_on::text, notes
    from staff_documents
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
  return staffDocRow(result.rows[0]);
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
      vt.notes
    from vehicle_tasks vt
    join vehicles v on v.id = vt.vehicle_id
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
  return vehicleTaskRow({ ...result.rows[0], vehicle_name: name });
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
      select id, title, due_on::text, notes, status
      from general_alerts
      where status = 'open'
      order by due_on asc, created_at desc
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
  return generalAlertRow(result.rows[0]);
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
    select id, title, entity_name, source_name, source_url, matched_keyword,
           due_on::text, fit_status, fit_reason, decision, created_at
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
      (title, entity_name, source_name, source_url, matched_keyword, due_on, fit_status, fit_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, title, entity_name, source_name, source_url, matched_keyword,
               due_on::text, fit_status, fit_reason, decision, created_at`,
    [
      title,
      payload.entity || payload.entity_name || null,
      payload.platform || payload.source_name || null,
      payload.url || payload.source_url || null,
      payload.keyword || payload.matched_keyword || null,
      payload.due || payload.due_on || null,
      TENDER_STATUS_MAP[payload.score] || payload.fit_status || "review",
      payload.reason || payload.fit_reason || null,
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
     returning id, title, entity_name, source_name, source_url, matched_keyword,
               due_on::text, fit_status, fit_reason, decision, created_at`,
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

    const inserted = await client.query(
      `insert into finance_entries
        (entry_type, amount, account_id, related_user_id, category, statement, status, entry_date)
       values ($1, $2, $3, $4, $5, $6, 'draft', current_date)
       returning *`,
      [entryType, amount, accountId, relatedUserId, payload.category || null, String(payload.note || payload.statement).trim()]
    );
    if (user?.id) {
      await client.query("update finance_entries set entered_by = $1 where id = $2", [user.id, inserted.rows[0].id]);
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
         approved_by = case when $1 in ('approved', 'rejected') then $2 else null end,
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

async function dashboard(client, user) {
  const finance = await listFinance(client);
  const quoteStates = await listQuoteStates(client);
  const staffDocs = await listStaffDocs(client);
  const vehicles = await listVehicleTasks(client);
  const generalAlerts = await listGeneralAlerts(client);
  const tenders = await listTenders(client);
  const daftraSettings = await getSetting(client, "daftra");
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

    if (req.method === "GET" && path === "/settings/daftra") {
      return res.status(200).json({ ok: true, data: await getSetting(client, "daftra") });
    }

    if (req.method === "POST" && path === "/settings/daftra") {
      const saved = await setSetting(client, "daftra", validateDaftraSettings(req.body || {}));
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

    return res.status(404).json({ ok: false, error: "المسار غير موجود" });
  } catch (err) {
    const status = err.statusCode || (err.message.includes("DATABASE_URL") ? 503 : 500);
    return res.status(status).json({ ok: false, error: err.message });
  } finally {
    if (client) client.release();
  }
};
