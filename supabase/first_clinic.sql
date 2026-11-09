-- Run ONCE in the Supabase SQL editor (not a migration; it creates real data).
-- Before running: Dashboard > Authentication > Users > Add user
--   email: drsharma@staff.clinicq.local   (username + @staff.clinicq.local)
--   password: choose one, tick "Auto Confirm User".
with c as (
  insert into public.clinics (name, address, whatsapp_number, wa_phone_number_id)
  values ('Sharma Clinic', 'Rewa, Madhya Pradesh', null, null)   -- fill WhatsApp values later
  returning id
)
insert into public.staff (id, clinic_id, username, full_name, role)
select u.id, c.id, 'drsharma', 'Dr. Sharma', 'doctor'
from c, auth.users u where u.email = 'drsharma@staff.clinicq.local';

-- Copy this value into web/config.js as CLINIC_ID:
select id as clinic_id from public.clinics order by created_at desc limit 1;
