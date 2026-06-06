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

create table if not exists finance_entries (
  id uuid primary key default gen_random_uuid(),
  entry_type text not null check (entry_type in ('expense', 'custody', 'income', 'loan', 'debt', 'transfer')),
  amount numeric(12,2) not null check (amount > 0),
  account_id uuid references bank_accounts(id),
  related_user_id uuid references app_users(id),
  related_customer_id uuid references customers(id),
  related_quote_id uuid references rental_quotes(id),
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
  owner_type text not null check (owner_type in ('finance_entry', 'customer', 'quote', 'staff_doc', 'vehicle')),
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
  document_type text not null check (document_type in ('iqama', 'work_permit', 'insurance', 'contract', 'other')),
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
create index if not exists idx_finance_entries_entry_date on finance_entries(entry_date);
create index if not exists idx_staff_documents_expires_on on staff_documents(expires_on);
create index if not exists idx_vehicle_tasks_due_on on vehicle_tasks(due_on);
create index if not exists idx_general_alerts_due_on on general_alerts(due_on);
create index if not exists idx_tenders_due_on on tenders(due_on);
create unique index if not exists idx_tenders_external_key on tenders(external_key) where external_key is not null;
