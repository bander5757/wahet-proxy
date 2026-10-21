-- محلل مراقب لصندوق الواتساب — تخزين مستقل لمقترحات التحليل.
-- مراجعة فقط: لم تُطبَّق بعد. التطبيق يدوي بعد موافقتك.
--   psql "$DATABASE_URL" -f migrations/2026-10-21_intake_analysis.sql
--
-- مبادئ ملزمة يعكسها هذا المخطط:
--  • لا يلمس whatsapp_intake.parsed_data ولا final_data ولا status — التحليل في جدول منفصل.
--  • لا ينشئ أي حركة مالية: لا مفتاح إلى finance_entries ولا مبالغ تُرحَّل.
--  • بنود تفريغ العهدة تُحفظ كمصفوفة داخل الصف نفسه، فلا تتضاعف الإجماليات بجدول حركات.
--  • نتيجة واحدة لكل (سجل + محلل + إصدار) — إعادة المحاولة تُحدِّث المحاولة الفاشلة ولا تُضيف صفاً.

create table if not exists intake_analysis (
  id                 uuid primary key default gen_random_uuid(),
  intake_id          uuid not null references whatsapp_intake(id) on delete cascade,

  analyzer           text not null,                 -- 'eve' مثلاً
  analyzer_version   text not null,                 -- إصدار المحلل كما يعلنه هو
  status             text not null default 'completed'
                     check (status in ('completed','failed','skipped')),

  fields             jsonb not null default '{}'::jsonb,   -- الحقول المستخرجة (اقتراح)
  suggested_classification text,                            -- اقتراح لا قرار
  missing_fields     text[] not null default '{}',
  questions          jsonb not null default '[]'::jsonb,    -- أسئلة للمراجع
  alerts             jsonb not null default '[]'::jsonb,    -- تنبيهات/تعارضات

  -- تفريغ العهدة: عدة بنود في صف واحد. أرقام للعرض والمطابقة فقط، لا ترحيل.
  items              jsonb not null default '[]'::jsonb,
  items_count        integer not null default 0,

  -- (أ) مطابقة المصروفات: مجموع البنود الصادرة مقابل الإجمالي المعلن في المستند.
  --     الحساب يتم بالهللات في طبقة التطبيق، بلا أي تسامح: التطابق تام أو فرق يُعرض.
  items_in_total       numeric(14,2),   -- مجموع الداخل (عهد مستلمة/تحصيل)
  items_spent_total    numeric(14,2),   -- مجموع الخارج عدا المُعاد
  items_returned_total numeric(14,2),   -- مجموع المُعاد (kind='return')
  reported_total       numeric(14,2),   -- الإجمالي كما يظهر في المستند
  expenses_diff        numeric(14,2),   -- مصروف البنود − إجمالي المستند (موجب/سالب كما هو)
  expenses_match       boolean,         -- true فقط عند التطابق التام، null إذا تعذّر الحساب

  -- (ب) تسوية العهدة: افتتاحي + مستلم − مصروف − مُعاد = متبقٍ
  opening_balance    numeric(14,2),
  closing_balance    numeric(14,2),
  expected_closing   numeric(14,2),
  settlement_diff    numeric(14,2),     -- المتبقي المعلن − المتبقي المحسوب
  settlement_status  text not null default 'not_computed'
                     check (settlement_status in ('balanced','mismatch','not_computed')),

  -- المرفق: نُسجّل نوعه وحاجته فقط (لا قارئ مرفقات في هذه المرحلة)
  attachment_kind    text check (attachment_kind in ('none','pdf_text','pdf_scan','image','excel','other')),
  needs_vision       boolean not null default false,
  needs_excel        boolean not null default false,

  error              text,                           -- سبب الفشل عند status='failed'
  attempts           integer not null default 1,
  analyzed_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- منع تكرار النتيجة لنفس السجل ونفس المحلل ونفس الإصدار
create unique index if not exists idx_intake_analysis_unique
  on intake_analysis(intake_id, analyzer, analyzer_version);
create index if not exists idx_intake_analysis_intake on intake_analysis(intake_id, created_at desc);
create index if not exists idx_intake_analysis_status on intake_analysis(analyzer, status);
