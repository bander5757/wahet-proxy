-- Initial Wahet Al Khaima data

insert into app_users (name, phone, email, role)
values
  ('بندر', null, 'bander@wkaimah.local', 'owner'),
  ('ابو فايز', null, 'abufayez@wkaimah.local', 'viewer'),
  ('عمر', null, 'omar@wkaimah.local', 'supervisor'),
  ('صدام', null, 'saddam@wkaimah.local', 'accountant')
on conflict (email) do update set
  name = excluded.name,
  role = excluded.role,
  is_active = true;

update app_users set login_code_hash = encode(digest('1111', 'sha256'), 'hex') where email = 'bander@wkaimah.local';
update app_users set login_code_hash = encode(digest('2222', 'sha256'), 'hex') where email = 'abufayez@wkaimah.local';
update app_users set login_code_hash = encode(digest('3333', 'sha256'), 'hex') where email = 'omar@wkaimah.local';
update app_users set login_code_hash = encode(digest('4444', 'sha256'), 'hex') where email = 'saddam@wkaimah.local';

insert into bank_accounts (name, account_type)
values
  ('الحساب الرسمي', 'official'),
  ('الحساب الفرعي', 'secondary'),
  ('كاش', 'cash')
on conflict do nothing;

insert into staff_documents (employee_name, document_type, expires_on, notes)
values
  ('عمر', 'iqama', current_date + interval '45 days', 'بيان مبدئي قابل للتعديل'),
  ('عامل تركيب', 'work_permit', current_date + interval '75 days', 'بيان مبدئي قابل للتعديل')
on conflict do nothing;

insert into vehicles (name, plate_number, odometer, notes)
values
  ('سيارة التركيب', null, null, 'بيان مبدئي قابل للتعديل'),
  ('سيارة المؤسسة', null, null, 'بيان مبدئي قابل للتعديل')
on conflict do nothing;

insert into vehicle_tasks (vehicle_id, task_type, due_on, notes)
select id, 'oil_change', current_date + interval '20 days', 'تغيير زيت مبدئي'
from vehicles
where name = 'سيارة التركيب'
  and not exists (
    select 1 from vehicle_tasks where vehicle_tasks.vehicle_id = vehicles.id and task_type = 'oil_change'
  );

insert into vehicle_tasks (vehicle_id, task_type, due_on, notes)
select id, 'inspection', current_date + interval '90 days', 'فحص مبدئي'
from vehicles
where name = 'سيارة المؤسسة'
  and not exists (
    select 1 from vehicle_tasks where vehicle_tasks.vehicle_id = vehicles.id and task_type = 'inspection'
  );

insert into tenders (title, entity_name, source_name, source_url, matched_keyword, due_on, fit_status, fit_reason)
values
  ('تجهيز خيام وفعاليات موسمية', 'جهة حكومية', 'اعتماد', '#', 'خيام فعاليات', current_date + interval '20 days', 'review', 'تحتاج مراجعة لأنها تحتوي على خيام وتجهيز فعاليات'),
  ('توريد دورات مياه متنقلة للفعاليات', 'شركة فعاليات', 'فرص', '#', null, current_date + interval '12 days', 'fit', 'مرتبطة بمنتج مساند موجود لديكم')
on conflict do nothing;
