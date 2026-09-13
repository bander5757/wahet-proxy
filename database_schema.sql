-- Wahet Al Khaima operational database draft
-- Target: PostgreSQL / Supabase-compatible schema

create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text unique,
  login_code_hash text,
  role text not null check (role in ('owner', 'manager', 'supervisor', 'data_entry', 'accountant', 'viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  location text,
  source text not null default 'manual',
  notes text,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists rental_quotes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  daftra_estimate_id text,
  daftra_invoice_id text,
  daftra_number text,
  products text,
  offer_total numeric(12,2) not null default 0,
  paid_total numeric(12,2) not null default 0,
  remaining_total numeric(12,2) generated always as (offer_total - paid_total) stored,
  quote_status text not null default 'not_confirmed'
    check (quote_status in ('not_confirmed', 'followed_up', 'confirmed', 'invoiced', 'installed', 'completed', 'cancelled')),
  is_confirmed_revenue boolean not null default false,
  has_tax_invoice boolean not null default false,
  install_date date,
  assigned_to uuid references app_users(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Daftra remains the source of truth for customers, estimates, and invoices.
-- This table stores only Wahet operational state over Daftra records.
create table if not exists daftra_quote_states (
  id uuid primary key default gen_random_uuid(),
  local_key text not null unique,
  daftra_estimate_id text,
  daftra_invoice_id text,
  daftra_client_id text,
  quote_confirmed boolean not null default false,
  tax_invoice_issued boolean not null default false,
  stage text not null default 'عرض_سعر',
  install_date date,
  assigned_to text,
  notes text,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists bank_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type text not null check (account_type in ('official', 'secondary', 'cash')),
  opening_balance numeric(12,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references app_users(id),
  updated_at timestamptz not null default now()
);

create table if not exists chart_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name_ar text not null,
  level integer not null check (level between 1 and 5),
  parent_code text,
  original_row_number integer,
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  is_postable boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chart_accounts_level_code_length_check check (
    (level = 1 and char_length(code) = 1) or
    (level = 2 and char_length(code) = 2) or
    (level = 3 and char_length(code) = 3) or
    (level = 4 and char_length(code) = 6) or
    (level = 5 and char_length(code) = 7)
  )
);

create table if not exists finance_entries (
  id uuid primary key default gen_random_uuid(),
  entry_type text not null check (entry_type in ('expense', 'custody', 'income', 'loan', 'debt', 'transfer')),
  amount numeric(12,2) not null check (amount > 0),
  account_id uuid references bank_accounts(id),
  related_user_id uuid references app_users(id),
  related_customer_id uuid references customers(id),
  related_quote_id uuid references rental_quotes(id),
  chart_account_id uuid references chart_accounts(id),
  category text,
  statement text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  entered_by uuid references app_users(id),
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  entry_date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('finance_entry', 'customer', 'quote', 'staff_doc', 'vehicle', 'general_alert')),
  owner_id uuid not null,
  file_name text not null,
  file_path text not null,
  mime_type text,
  uploaded_by uuid references app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists staff_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users(id),
  employee_name text not null,
  document_type text not null check (document_type in ('iqama', 'work_permit', 'passport', 'insurance', 'contract', 'other')),
  expires_on date not null,
  alert_days integer[] not null default array[60,30,15,7],
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plate_number text,
  odometer integer,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists vehicle_tasks (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  task_type text not null check (task_type in ('oil_change', 'inspection', 'insurance', 'registration', 'maintenance', 'other')),
  due_on date,
  due_odometer integer,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists general_alerts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  due_on date not null,
  notes text,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists tenders (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  entity_name text,
  source_name text,
  source_url text,
  external_key text,
  matched_keyword text,
  opportunity_type text not null default 'tender'
    check (opportunity_type in ('tender', 'lead', 'site', 'event')),
  due_on date,
  fit_status text not null default 'review' check (fit_status in ('fit', 'not_fit', 'review')),
  fit_reason text,
  decision text,
  suggested_action text,
  follow_status text not null default 'new'
    check (follow_status in ('new', 'reviewing', 'contacted', 'proposal', 'ignored', 'done')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table tenders add column if not exists opportunity_type text not null default 'tender';
alter table tenders add column if not exists external_key text;
alter table tenders add column if not exists suggested_action text;
alter table tenders add column if not exists follow_status text not null default 'new';
alter table tenders add column if not exists last_seen_at timestamptz not null default now();

create index if not exists idx_rental_quotes_status on rental_quotes(quote_status);
create index if not exists idx_rental_quotes_install_date on rental_quotes(install_date);
create index if not exists idx_daftra_quote_states_local_key on daftra_quote_states(local_key);
create index if not exists idx_chart_accounts_parent_code on chart_accounts(parent_code);
create index if not exists idx_chart_accounts_postable_active on chart_accounts(is_postable, is_active);
create index if not exists idx_chart_accounts_code on chart_accounts(code);
create index if not exists idx_finance_entries_chart_account_id on finance_entries(chart_account_id);
create index if not exists idx_finance_entries_entry_date on finance_entries(entry_date);
create index if not exists idx_staff_documents_expires_on on staff_documents(expires_on);
create index if not exists idx_vehicle_tasks_due_on on vehicle_tasks(due_on);
create index if not exists idx_general_alerts_due_on on general_alerts(due_on);
create index if not exists idx_tenders_due_on on tenders(due_on);
create unique index if not exists idx_tenders_external_key on tenders(external_key) where external_key is not null;

-- WhatsApp Intake (Peach → Claude → مراجعة بشرية → finance).
-- سجلات الوارد تعيش هنا فقط ولا تدخل أي إجمالي مالي إلا بعد الاعتماد (ينشأ finance_entry).
-- ملاحظة تطبيقية: الـAPI يجب أن يطبّع sender_phone إلى E.164 قبل allowlist matching
-- والـdedup والتخزين. لا نفرض regex/check معقّداً في DB الآن.
create table if not exists whatsapp_intake (
  id                     uuid primary key default gen_random_uuid(),

  -- المصدر والهوية (dedup)
  provider               text not null default 'peach',   -- المزوّد (peach، وغيره مستقبلاً)
  provider_message_id    text,                             -- معرّف الرسالة لدى المزوّد
  sender_phone           text not null,                    -- يُخزَّن دائماً E.164 مطبَّعاً (مسؤولية الـAPI)
  sender_name            text,                             -- مساعِد فقط، لا يُعتمد للهوية
  original_message       text,
  message_timestamp      timestamptz,
  source                 text not null default 'whatsapp',

  -- تحليل الوكيل
  parsed_data            jsonb,          -- تحليل Claude الأصلي كما خرج أول مرة (immutable تطبيقياً بعد الحفظ)
  final_data             jsonb,          -- البيانات النهائية بعد الاستكمال/التصحيح البشري (للمقارنة وقياس الدقة)
  classification         text,           -- expense/customer_payment/supplier_payment/custody/purchase/
                                        -- fuel/maintenance/salary/project_cost/operational_update/
                                        -- vehicle_update/inventory/other
  amount                 numeric(12,2),
  currency               text default 'SAR',
  confidence_score       numeric(4,3),   -- 0..1
  missing_fields         text[],         -- الحقول الناقصة (needs_review + طلب الحقل المفقود)
  suggested_chart_account_id uuid references chart_accounts(id),  -- اقتراح، يؤكده المراجِع

  -- الحسابات (نموذج مزدوج الطرف): source عند الخروج/التحويل، destination عند الدخول/التحويل.
  -- اقتراح الوكيل يؤكده المراجِع. التحويل الداخلي يملأ الطرفين ولا يُعدّ إيراداً/مصروفاً.
  source_account_id      uuid references bank_accounts(id),
  destination_account_id uuid references bank_accounts(id),

  -- روابط اختيارية (تبقى null إن لم تُحل — لا جداول suppliers/projects جديدة الآن)
  customer_id            uuid references customers(id),
  vehicle_id             uuid references vehicles(id),
  quote_id               uuid references rental_quotes(id),   -- أقرب مفهوم "مشروع" حالياً
  supplier_name          text,                                -- نص وصفي فقط
  project_name           text,                                -- نص وصفي فقط

  -- المرفقات (مرجع فقط — لا ندّعي تخزيناً دائماً في M0/M1)
  attachment_url         text,          -- Peach media URL إن وفّره
  attachment_name        text,
  attachment_mime        text,
  attachment_meta        jsonb,

  -- دورة الحياة (= processing status للـintake)
  status                 text not null default 'new'
    check (status in ('new','parsed','needs_review','approved','rejected','synced','duplicate','failed')),
  rejection_reason       text,
  reviewed_by            uuid references app_users(id),  -- من راجع/صحّح/اعتمد (بشري)
  reviewed_at            timestamptz,

  -- الربط والتدقيق
  finance_entry_id       uuid references finance_entries(id),  -- بعد الاعتماد
  daftra_sync_status     text not null default 'none'
    check (daftra_sync_status in ('none','pending','synced','na')),
  daftra_id              text,
  dedup_hash             text,          -- sha256(sender_phone + message_timestamp + amount + normalized_text|media_ref)
  raw_payload            jsonb,         -- الحمولة الخام كما وصلت (غير parsed_data)
  error_message          text,          -- عند status='failed'
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint chk_intake_confidence check (
    confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)
  )
);

-- منع التكرار حسب (المزوّد + معرّف رسالته)؛ نفس message_id قد يتكرر بين مزوّدين مختلفين.
-- P1.7: مفاتيح مطابقة مستخرجة من المستند (تُفهرس ⇒ أعمدة لا jsonb).
alter table whatsapp_intake add column if not exists attachment_sha256 text;
alter table whatsapp_intake add column if not exists transaction_reference text;
alter table whatsapp_intake add column if not exists sibling_of uuid references whatsapp_intake(id);
create index if not exists idx_intake_att_sha on whatsapp_intake(attachment_sha256) where attachment_sha256 is not null;
create index if not exists idx_intake_txn_ref on whatsapp_intake(transaction_reference) where transaction_reference is not null;
create index if not exists idx_intake_sibling on whatsapp_intake(sibling_of) where sibling_of is not null;

-- P1.5: الاشتباه بالتكرار (ليس رفضاً) — السجل يُخزَّن ويُعلَّم للمراجع البشري.
alter table whatsapp_intake add column if not exists duplicate_of uuid references whatsapp_intake(id);
alter table whatsapp_intake add column if not exists duplicate_reason text;
create index if not exists idx_intake_duplicate_of on whatsapp_intake(duplicate_of) where duplicate_of is not null;

create unique index if not exists idx_intake_provider_msg
  on whatsapp_intake(provider, provider_message_id) where provider_message_id is not null;
-- بصمة احتياطية مستقلة عند غياب المعرّف.
create unique index if not exists idx_intake_dedup
  on whatsapp_intake(dedup_hash) where dedup_hash is not null;
create index if not exists idx_intake_status  on whatsapp_intake(status);
create index if not exists idx_intake_created on whatsapp_intake(created_at desc);

-- Audit Trail موحّد لكل الوكلاء (المحاسبة أولاً، ثم المبيعات/التشغيل/المناقصات لاحقاً).
-- يسجّل ما فعله وكيل أو بشر: الفعل، الهدف، قبل/بعد، الثقة، الحالة. لا حذف — سجل تدقيق دائم.
create table if not exists agent_actions (
  id            uuid primary key default gen_random_uuid(),
  actor_type    text not null check (actor_type in ('agent', 'human', 'system')),
  actor_ref     text,          -- app_users.id للبشر، أو معرّف/اسم الوكيل للآلة
  actor_name    text,          -- اسم مقروء (للعرض في التدقيق)
  agent_role    text,          -- 'accounting' | 'sales' | 'operations' | 'tenders' | ...
  action        text not null, -- 'intake.parse' | 'intake.approve' | 'alert.send' | 'reconcile.propose' | 'anomaly.flag' | ...
  target_type   text,          -- 'whatsapp_intake' | 'finance_entry' | 'reconciliation_match' | ...
  target_id     text,
  summary       text,
  before_state  jsonb,
  after_state   jsonb,
  confidence    numeric(4,3),  -- 0..1 عند وجود قرار آلي
  status        text not null default 'done'
    check (status in ('proposed', 'done', 'failed', 'superseded')),
  error_message text,
  created_at    timestamptz not null default now(),

  constraint chk_agent_actions_confidence check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  )
);

create index if not exists idx_agent_actions_target  on agent_actions(target_type, target_id);
create index if not exists idx_agent_actions_created on agent_actions(created_at desc);
create index if not exists idx_agent_actions_actor   on agent_actions(actor_type, agent_role);
create index if not exists idx_agent_actions_action  on agent_actions(action);
