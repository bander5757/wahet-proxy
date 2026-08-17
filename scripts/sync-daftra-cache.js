const fs = require("fs");
const { Pool } = require("pg");

function readLocalDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  return env.match(/DATABASE_URL=(.*)/)?.[1]?.trim();
}

function normalizeDatabaseUrl(value) {
  const url = String(value || "").trim();
  const bracketPassword = url.match(/^(postgres(?:ql)?:\/\/[^:]+:)\[(.*)\]@(.+)$/);
  if (bracketPassword) {
    return bracketPassword[1] + encodeURIComponent(bracketPassword[2]) + "@" + bracketPassword[3];
  }
  return url;
}

function resolveProxyUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "https://wahet-proxy.vercel.app/api/daftra";
  if (value.endsWith("/api/daftra")) return value;
  if (value.endsWith("/api/daftra/")) return value.slice(0, -1);
  return value.replace(/\/+$/, "") + "/api/daftra";
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

async function main() {
  const databaseUrl = readLocalDatabaseUrl();
  if (!databaseUrl) throw new Error("DATABASE_URL is missing");

  const pool = new Pool({
    connectionString: normalizeDatabaseUrl(databaseUrl),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });

  try {
    const settings = await pool.query("select value from app_settings where key = 'daftra'");
    const cfg = settings.rows[0]?.value;
    if (!cfg?.subdomain || !cfg?.apikey) throw new Error("Daftra settings are missing");

    const proxyUrl = resolveProxyUrl(cfg.proxyUrl);
    async function requestDaftra(endpoint) {
      const res = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subdomain: cfg.subdomain,
          apikey: cfg.apikey,
          endpoint,
          method: "GET",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || data.message || `Daftra request failed: ${endpoint}`);
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

    const [estimates, invoices, statesResult, expensesResult, custodiesResult] = await Promise.all([
      fetchPages("estimates"),
      fetchPages("invoices"),
      pool.query(`
        select local_key, quote_confirmed, tax_invoice_issued, stage, install_date::text, assigned_to, notes
        from daftra_quote_states
      `),
      fetchOptionalPages("expenses", "المصروفات"),
      fetchFirstAvailable(["employee_custodies", "employee-custodies", "custodies"], "العهد"),
    ]);

    const states = Object.fromEntries(
      statesResult.rows.map((row) => [
        row.local_key,
        {
          quoteConfirmed: Boolean(row.quote_confirmed),
          taxInvoiceIssued: Boolean(row.tax_invoice_issued),
          stage: row.stage,
          installDate: row.install_date || "",
          assignedTo: row.assigned_to || "—",
          notes: row.notes || "",
        },
      ])
    );

    const merged = [];
    for (const item of estimates) {
      const est = item.Estimate || item;
      const created = firstDate(est.date, est.created_at, est.created);
      const updatedAt = firstDate(est.updated_at, est.modified, est.modified_at, est.last_modified, est.last_update, est.date);
      const hasInvoice = invoices.some((row) => {
        const inv = row.Invoice || row;
        return String(inv.estimate_id || inv.estimateId || "") === String(est.id);
      });
      if (hasInvoice) continue;

      const total = moneyNumber(est.summary_total || est.total);
      const card = {
        id: `est_${est.id}`,
        daftraEstId: est.id,
        daftraClientId: est.client_id,
        name: est.client_business_name || est.client_first_name || "عميل",
        phone: est.client_phone || "",
        products: "—",
        location: est.client_state || "",
        offerPrice: total,
        deposit: Math.round(total / 2),
        remaining: Math.round(total / 2),
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
      Object.assign(card, states[card.id] || {});
      if (card.quoteConfirmed && card.stage === "عرض_سعر") card.stage = "موافق";
      merged.push(card);
    }

    for (const item of invoices) {
      const inv = item.Invoice || item;
      const relatedEstimateId = inv.estimate_id || inv.estimateId || inv.Estimate?.id || "";
      const created = firstDate(inv.date, inv.created_at, inv.created);
      const updatedAt = firstDate(inv.updated_at, inv.modified, inv.modified_at, inv.last_modified, inv.last_update, inv.date);
      const existing = merged.find(
        (card) =>
          (relatedEstimateId && String(card.daftraEstId || "") === String(relatedEstimateId)) ||
          (card.daftraInvId && String(card.daftraInvId) === String(inv.id))
      );
      const total = moneyNumber(inv.summary_total || inv.total);
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
        deposit: Math.round(total / 2),
        remaining: Math.round(total / 2),
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
        daftraDetails: daftraDetailsFrom(inv, item),
      };
      Object.assign(card, states[card.id] || {});
      card.quoteConfirmed = true;
      card.taxInvoiceIssued = true;

      const idx = merged.findIndex(
        (row) =>
          (card.daftraInvId && String(row.daftraInvId || "") === String(card.daftraInvId)) ||
          (relatedEstimateId && String(row.daftraEstId || "") === String(relatedEstimateId))
      );
      if (idx >= 0) merged[idx] = card;
      else merged.push(card);
    }

    const cache = {
      clients: merged,
      syncedAt: new Date().toISOString(),
      counts: { estimates: estimates.length, invoices: invoices.length },
    };
    await pool.query(
      `insert into app_settings (key, value, updated_at)
       values ('daftra_clients_cache', $1::jsonb, now())
       on conflict (key)
       do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(cache)]
    );

    const expenses = expensesResult.rows.map(daftraExpenseFrom).filter((row) => row.id || row.amount || row.date);
    const custodies = custodiesResult.rows.map(daftraCustodyFrom).filter((row) => row.id || row.amount || row.date);
    const financeCache = {
      expenses,
      custodies,
      syncedAt: new Date().toISOString(),
      counts: { expenses: expenses.length, custodies: custodies.length },
      errors: [expensesResult.error, custodiesResult.error].filter(Boolean),
    };
    await pool.query(
      `insert into app_settings (key, value, updated_at)
       values ('daftra_finance_cache', $1::jsonb, now())
       on conflict (key)
       do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(financeCache)]
    );

    console.log(
      JSON.stringify(
        {
          cached: merged.length,
          estimates: estimates.length,
          invoices: invoices.length,
          expenses: expenses.length,
          custodies: custodies.length,
          financeErrors: financeCache.errors,
          first: merged[0]
            ? { id: merged[0].id, name: merged[0].name, created: merged[0].created, stage: merged[0].stage }
            : null,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
