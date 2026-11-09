-- =====================================================================
-- Clinic Token & Appointment System — Supabase schema v1
-- Token + estimated time (no fixed slots), advance booking,
-- WhatsApp click-to-chat linking, doctor queue actions.
--
-- RUN THIS ON A NEW, SEPARATE SUPABASE PROJECT (patient data should not
-- share a database with your other apps).
-- Patient-facing functions are callable ONLY by service_role, i.e. through
-- your Edge Functions (where you add captcha / rate limiting).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- enums ----------------------------------------------------
create type public.session_status as enum ('scheduled', 'open', 'closed', 'cancelled');
create type public.booking_status as enum ('waiting', 'serving', 'done', 'cancelled', 'skipped');
create type public.booking_source as enum ('online', 'walkin');
create type public.staff_role     as enum ('doctor', 'receptionist');

-- ---------- tables ---------------------------------------------------
create table public.clinics (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  address                   text,
  whatsapp_number           text,           -- number patients message (click-to-chat target)
  wa_phone_number_id        text,           -- WhatsApp Cloud API phone-number id
  default_minutes_per_patient int not null default 8  check (default_minutes_per_patient between 1 and 120),
  notify_before             int not null default 5    check (notify_before between 1 and 20),
  advance_days              int not null default 7    check (advance_days between 0 and 60),
  created_at                timestamptz not null default now()
);

-- Doctors / receptionists. Login by username: your Edge Function maps
-- username -> internal email (e.g. username@clinic.local) for Supabase Auth.
create table public.staff (
  id          uuid primary key references auth.users(id) on delete cascade,
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9_.]{3,30}$'),
  full_name   text not null,
  role        public.staff_role not null default 'doctor',
  created_at  timestamptz not null default now()
);
create index staff_clinic_idx on public.staff (clinic_id);

-- One session = one doctor's OPD time on one date (e.g. Tue 5-8 PM).
create table public.sessions (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          uuid not null references public.clinics(id) on delete cascade,
  doctor_id          uuid not null references public.staff(id) on delete cascade,
  session_date       date not null,
  start_time         time not null,
  end_time           time not null,
  max_tokens         int  not null default 40 check (max_tokens > 0),
  online_quota       int  not null default 28 check (online_quota >= 0),
  minutes_per_patient int check (minutes_per_patient between 1 and 120), -- null = clinic default
  last_token         int  not null default 0,   -- token counter (never reused)
  status             public.session_status not null default 'scheduled',
  timing_changed_at  timestamptz,
  created_at         timestamptz not null default now(),
  check (end_time > start_time),
  check (online_quota <= max_tokens),
  unique (doctor_id, session_date, start_time)
);
create index sessions_clinic_date_idx on public.sessions (clinic_id, session_date);

create table public.bookings (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.sessions(id) on delete cascade,
  clinic_id       uuid not null references public.clinics(id) on delete cascade,
  token_no        int  not null,
  queue_order     numeric not null,             -- = token_no, changes only when a skipped patient is re-queued
  booking_code    text not null unique,         -- e.g. BK-7K2F9A1C (used in click-to-chat + status link)
  patient_name    text not null check (char_length(patient_name) between 1 and 100),
  phone           text not null check (phone ~ '^[0-9]{10}$'),            -- normalise to 10 digits in Edge Function
  whatsapp_number text check (whatsapp_number is null or whatsapp_number ~ '^[0-9]{10}$'),
  address         text check (address is null or char_length(address) <= 300),
  source          public.booking_source not null default 'online',
  status          public.booking_status not null default 'waiting',
  wa_id           text,                         -- WhatsApp id captured when patient sends the code
  wa_linked_at    timestamptz,
  notified_ahead  boolean not null default false, -- "N patients left" alert already handled
  created_at      timestamptz not null default now(),
  called_at       timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  unique (session_id, token_no)
);
create index bookings_queue_idx on public.bookings (session_id, status, queue_order);
create index bookings_phone_idx on public.bookings (clinic_id, phone);
create index bookings_wa_idx    on public.bookings (wa_id);

-- Tracks when each patient last messaged the clinic number (WhatsApp reply window).
create table public.wa_contacts (
  clinic_id       uuid not null references public.clinics(id) on delete cascade,
  wa_id           text not null,
  last_inbound_at timestamptz not null default now(),
  primary key (clinic_id, wa_id)
);

create table public.message_log (
  id                   bigint generated always as identity primary key,
  clinic_id            uuid not null references public.clinics(id) on delete cascade,
  booking_id           uuid references public.bookings(id) on delete set null,
  kind                 text not null,   -- confirmation | day_reminder | n_left | timing_change | cancelled
  status               text not null default 'queued',  -- queued | sent | failed
  provider_message_id  text,
  error                text,
  created_at           timestamptz not null default now()
);
create index message_log_booking_idx on public.message_log (booking_id);

-- Stamp when a doctor changes session timing (Edge Function / DB webhook
-- can then notify waiting patients).
create or replace function public.touch_timing_changed()
returns trigger language plpgsql as $$
begin
  if new.start_time is distinct from old.start_time
     or new.end_time is distinct from old.end_time then
    new.timing_changed_at := now();
  end if;
  return new;
end $$;

create trigger sessions_timing_changed
  before update on public.sessions
  for each row execute function public.touch_timing_changed();

-- ---------- row level security --------------------------------------
create or replace function public.current_clinic_id()
returns uuid language sql stable security definer set search_path = public as $$
  select clinic_id from public.staff where id = auth.uid()
$$;

alter table public.clinics      enable row level security;
alter table public.staff        enable row level security;
alter table public.sessions     enable row level security;
alter table public.bookings     enable row level security;
alter table public.wa_contacts  enable row level security;
alter table public.message_log  enable row level security;

create policy clinics_select on public.clinics for select to authenticated
  using (id = public.current_clinic_id());
create policy clinics_update on public.clinics for update to authenticated
  using (id = public.current_clinic_id()) with check (id = public.current_clinic_id());

create policy staff_select on public.staff for select to authenticated
  using (clinic_id = public.current_clinic_id());

create policy sessions_all on public.sessions for all to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

-- Staff can read and update bookings of their own clinic. Inserts only via
-- create_booking / add_walkin. No deletes.
create policy bookings_select on public.bookings for select to authenticated
  using (clinic_id = public.current_clinic_id());
create policy bookings_update on public.bookings for update to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());

create policy wa_contacts_select on public.wa_contacts for select to authenticated
  using (clinic_id = public.current_clinic_id());
create policy message_log_select on public.message_log for select to authenticated
  using (clinic_id = public.current_clinic_id());

-- Live dashboard updates for the doctor screen (RLS still applies).
alter publication supabase_realtime add table public.bookings, public.sessions;

-- ---------- estimate helper -----------------------------------------
-- Minutes per patient: real average of today's completed visits once
-- 3+ are done, otherwise session/clinic default. Clamped to 2..60.
create or replace function public.effective_minutes(p_session_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select least(60, greatest(2, coalesce(
    (select case when count(*) >= 3
              then avg(extract(epoch from (b.completed_at - b.called_at)) / 60.0) end
       from public.bookings b
      where b.session_id = p_session_id
        and b.status = 'done'
        and b.called_at is not null
        and b.completed_at is not null),
    (select coalesce(s.minutes_per_patient, c.default_minutes_per_patient)
       from public.sessions s
       join public.clinics c on c.id = s.clinic_id
      where s.id = p_session_id)
  )))
$$;

-- ---------- 1. AUTO-ASSIGN TOKEN (patient side, via Edge Function) ---
-- Row lock on the session makes token numbers safe under simultaneous
-- bookings. Errors are raised as short codes your Edge Function maps to
-- friendly messages: session_not_found, session_closed, session_in_past,
-- session_over, too_far_ahead, session_full, online_quota_full,
-- too_many_for_phone.
create or replace function public.create_booking(
  p_session_id uuid,
  p_name       text,
  p_phone      text,
  p_whatsapp   text default null,
  p_address    text default null,
  p_source     public.booking_source default 'online'
)
returns table (
  out_booking_code    text,
  out_token_no        int,
  out_session_date    date,
  out_start_time      time,
  out_end_time        time,
  out_est_wait_minutes int
)
language plpgsql security definer set search_path = public as $$
declare
  s            public.sessions%rowtype;
  c            public.clinics%rowtype;
  v_today      date := (now() at time zone 'Asia/Kolkata')::date;
  v_now_time   time := (now() at time zone 'Asia/Kolkata')::time;
  v_active     int;
  v_online     int;
  v_same_phone int;
  v_ahead      int;
  v_token      int;
  v_code       text;
  v_tries      int := 0;
begin
  select * into s from public.sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  select * into c from public.clinics where id = s.clinic_id;

  if s.status not in ('scheduled', 'open') then raise exception 'session_closed'; end if;
  if s.session_date < v_today then raise exception 'session_in_past'; end if;
  if s.session_date = v_today and v_now_time > s.end_time then raise exception 'session_over'; end if;
  if p_source = 'online' and s.session_date > v_today + c.advance_days then
    raise exception 'too_far_ahead';
  end if;

  select count(*) into v_active
    from public.bookings where session_id = s.id and status <> 'cancelled';
  if v_active >= s.max_tokens then raise exception 'session_full'; end if;

  if p_source = 'online' then
    select count(*) into v_online
      from public.bookings
     where session_id = s.id and source = 'online' and status <> 'cancelled';
    if v_online >= s.online_quota then raise exception 'online_quota_full'; end if;
  end if;

  select count(*) into v_same_phone
    from public.bookings
   where session_id = s.id and phone = p_phone
     and status in ('waiting', 'serving', 'skipped');
  if v_same_phone >= 3 then raise exception 'too_many_for_phone'; end if;

  -- patients ahead of the new booking (it goes to the end of the queue)
  select count(*) into v_ahead
    from public.bookings
   where session_id = s.id and status in ('waiting', 'serving');

  v_token := s.last_token + 1;
  update public.sessions set last_token = v_token where id = s.id;

  loop
    v_code := 'BK-' || upper(encode(gen_random_bytes(4), 'hex'));
    begin
      insert into public.bookings
        (session_id, clinic_id, token_no, queue_order, booking_code,
         patient_name, phone, whatsapp_number, address, source, notified_ahead)
      values
        (s.id, s.clinic_id, v_token, v_token, v_code,
         trim(p_name), p_phone, p_whatsapp, nullif(trim(p_address), ''), p_source,
         v_ahead <= c.notify_before);   -- late bookers don't get an instant "N left" alert
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 5 then raise; end if;
    end;
  end loop;

  return query
    select v_code, v_token, s.session_date, s.start_time, s.end_time,
           round(v_ahead * public.effective_minutes(s.id))::int;
end $$;

-- ---------- 2. LIVE STATUS for the patient (token, seen, wait) -------
create or replace function public.get_booking_status(p_code text)
returns table (
  out_token_no         int,
  out_status           public.booking_status,
  out_patient_name     text,
  out_session_date     date,
  out_start_time       time,
  out_end_time         time,
  out_session_status   public.session_status,
  out_now_serving      int,
  out_patients_seen    int,
  out_patients_ahead   int,
  out_est_wait_minutes int
)
language plpgsql stable security definer set search_path = public as $$
declare
  b         public.bookings%rowtype;
  s         public.sessions%rowtype;
  v_ahead   int := 0;
  v_seen    int;
  v_serving int;
begin
  select * into b from public.bookings where booking_code = upper(trim(p_code));
  if not found then return; end if;
  select * into s from public.sessions where id = b.session_id;

  select count(*)::int into v_seen
    from public.bookings where session_id = b.session_id and status = 'done';

  select token_no into v_serving
    from public.bookings
   where session_id = b.session_id and status = 'serving'
   order by queue_order limit 1;
  if v_serving is null then
    select max(token_no) into v_serving
      from public.bookings where session_id = b.session_id and status = 'done';
  end if;

  if b.status = 'waiting' then
    select count(*)::int into v_ahead
      from public.bookings
     where session_id = b.session_id
       and status in ('waiting', 'serving')
       and (queue_order < b.queue_order
            or (queue_order = b.queue_order and token_no < b.token_no));
  end if;

  return query
    select b.token_no, b.status, b.patient_name, s.session_date, s.start_time,
           s.end_time, s.status, v_serving, v_seen, v_ahead,
           round(v_ahead * public.effective_minutes(b.session_id))::int;
end $$;

create or replace function public.cancel_booking_by_code(p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.bookings
     set status = 'cancelled', cancelled_at = now()
   where booking_code = upper(trim(p_code)) and status = 'waiting';
  return found;
end $$;

-- ---------- 3. WHATSAPP click-to-chat linking ------------------------
-- Webhook receives "BK-XXXXXXXX" from the patient -> link_whatsapp().
create or replace function public.link_whatsapp(p_code text, p_wa_id text)
returns table (
  out_booking_id uuid,
  out_clinic_id  uuid,
  out_token_no   int,
  out_status     public.booking_status
)
language plpgsql security definer set search_path = public as $$
declare
  b public.bookings%rowtype;
begin
  select * into b
    from public.bookings
   where booking_code = upper(trim(p_code))
     and status in ('waiting', 'serving', 'skipped')
     and (wa_id is null or wa_id = p_wa_id)     -- code is single-use per WhatsApp id
   for update;
  if not found then return; end if;

  update public.bookings set wa_id = p_wa_id, wa_linked_at = now() where id = b.id;

  insert into public.wa_contacts (clinic_id, wa_id, last_inbound_at)
  values (b.clinic_id, p_wa_id, now())
  on conflict (clinic_id, wa_id) do update set last_inbound_at = excluded.last_inbound_at;

  return query select b.id, b.clinic_id, b.token_no, b.status;
end $$;

-- Call for ANY inbound message (e.g. patient taps the morning template button)
-- so the reply window is tracked.
create or replace function public.record_inbound(p_clinic_id uuid, p_wa_id text)
returns void language sql security definer set search_path = public as $$
  insert into public.wa_contacts (clinic_id, wa_id, last_inbound_at)
  values (p_clinic_id, p_wa_id, now())
  on conflict (clinic_id, wa_id) do update set last_inbound_at = excluded.last_inbound_at
$$;

-- True if free-form replies are likely allowed. Uses 23h as a safety margin;
-- confirm the current WhatsApp rule before relying on this.
create or replace function public.wa_window_open(p_clinic_id uuid, p_wa_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select last_inbound_at > now() - interval '23 hours'
       from public.wa_contacts
      where clinic_id = p_clinic_id and wa_id = p_wa_id),
    false)
$$;

-- ---------- 4. "N PATIENTS LEFT" alerts ------------------------------
-- Call after every call_next / skip / cancel. Returns patients who just
-- reached the clinic's notify_before threshold and haven't been alerted.
create or replace function public.pending_ahead_alerts(p_session_id uuid)
returns table (
  out_booking_id       uuid,
  out_clinic_id        uuid,
  out_token_no         int,
  out_patient_name     text,
  out_wa_id            text,
  out_whatsapp_number  text,
  out_patients_ahead   int,
  out_est_wait_minutes int
)
language sql stable security definer set search_path = public as $$
  with q as (
    select b.*,
           row_number() over (order by b.queue_order, b.token_no) - 1 as ahead
      from public.bookings b
     where b.session_id = p_session_id
       and b.status in ('waiting', 'serving')
  )
  select q.id, q.clinic_id, q.token_no, q.patient_name, q.wa_id, q.whatsapp_number,
         q.ahead::int,
         round(q.ahead * public.effective_minutes(p_session_id))::int
    from q
    join public.clinics c on c.id = q.clinic_id
   where q.status = 'waiting'
     and q.notified_ahead = false
     and q.ahead <= c.notify_before
$$;

create or replace function public.mark_alert_sent(p_booking_ids uuid[])
returns void language sql security definer set search_path = public as $$
  update public.bookings set notified_ahead = true where id = any(p_booking_ids)
$$;

-- ---------- 5. DOCTOR / RECEPTIONIST ACTIONS (RLS applies) -----------
-- Dashboard counts: waiting / completed / cancelled (+ serving, skipped).
create or replace function public.session_counts(p_session_id uuid)
returns table (
  out_waiting   int,
  out_serving   int,
  out_done      int,
  out_cancelled int,
  out_skipped   int,
  out_total     int
)
language sql stable security invoker set search_path = public as $$
  select count(*) filter (where status = 'waiting')::int,
         count(*) filter (where status = 'serving')::int,
         count(*) filter (where status = 'done')::int,
         count(*) filter (where status = 'cancelled')::int,
         count(*) filter (where status = 'skipped')::int,
         count(*)::int
    from public.bookings
   where session_id = p_session_id
$$;

-- "Next" button: finish the current patient, call the next one.
create or replace function public.call_next(p_session_id uuid)
returns public.bookings
language plpgsql security invoker set search_path = public as $$
declare
  v_next public.bookings;
begin
  perform 1 from public.sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;

  update public.sessions set status = 'open'
   where id = p_session_id and status = 'scheduled';

  update public.bookings
     set status = 'done', completed_at = now()
   where session_id = p_session_id and status = 'serving';

  select * into v_next
    from public.bookings
   where session_id = p_session_id and status = 'waiting'
   order by queue_order, token_no
   limit 1
   for update skip locked;
  if not found then return null; end if;

  update public.bookings
     set status = 'serving', called_at = now()
   where id = v_next.id
   returning * into v_next;
  return v_next;
end $$;

-- "Done" without calling anyone (end of session).
create or replace function public.complete_current(p_session_id uuid)
returns void language sql security invoker set search_path = public as $$
  update public.bookings
     set status = 'done', completed_at = now()
   where session_id = p_session_id and status = 'serving'
$$;

-- Patient not present when called.
create or replace function public.skip_booking(p_booking_id uuid)
returns void language sql security invoker set search_path = public as $$
  update public.bookings
     set status = 'skipped'
   where id = p_booking_id and status in ('waiting', 'serving')
$$;

-- Skipped patient arrived: place them after the next p_after waiting
-- patients (ties are broken by token number).
create or replace function public.requeue_skipped(p_booking_id uuid, p_after int default 3)
returns void language plpgsql security invoker set search_path = public as $$
declare
  b        public.bookings%rowtype;
  v_target numeric;
begin
  select * into b from public.bookings
   where id = p_booking_id and status = 'skipped' for update;
  if not found then raise exception 'not_skipped'; end if;

  select t.queue_order into v_target
    from (
      select queue_order,
             row_number() over (order by queue_order, token_no) as rn
        from public.bookings
       where session_id = b.session_id and status = 'waiting'
    ) t
   where t.rn = p_after;

  if v_target is null then
    select coalesce(max(queue_order), 0) + 1 into v_target
      from public.bookings where session_id = b.session_id;
  else
    v_target := v_target + 0.5;
  end if;

  update public.bookings
     set status = 'waiting', queue_order = v_target, notified_ahead = false
   where id = b.id;
end $$;

-- Receptionist adds a walk-in from the dashboard.
create or replace function public.add_walkin(
  p_session_id uuid,
  p_name       text,
  p_phone      text,
  p_whatsapp   text default null
)
returns table (
  out_booking_code     text,
  out_token_no         int,
  out_est_wait_minutes int
)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.sessions
     where id = p_session_id and clinic_id = public.current_clinic_id()
  ) then
    raise exception 'not_allowed';
  end if;

  return query
    select r.out_booking_code, r.out_token_no, r.out_est_wait_minutes
      from public.create_booking(p_session_id, p_name, p_phone, p_whatsapp, null, 'walkin') r;
end $$;

-- ---------- permissions ----------------------------------------------
-- Patient-facing / server-only functions: service_role only.
revoke execute on function public.create_booking(uuid, text, text, text, text, public.booking_source) from public, anon, authenticated;
revoke execute on function public.get_booking_status(text)          from public, anon, authenticated;
revoke execute on function public.cancel_booking_by_code(text)      from public, anon, authenticated;
revoke execute on function public.link_whatsapp(text, text)         from public, anon, authenticated;
revoke execute on function public.record_inbound(uuid, text)        from public, anon, authenticated;
revoke execute on function public.wa_window_open(uuid, text)        from public, anon, authenticated;
revoke execute on function public.pending_ahead_alerts(uuid)        from public, anon, authenticated;
revoke execute on function public.mark_alert_sent(uuid[])           from public, anon, authenticated;

grant execute on function public.create_booking(uuid, text, text, text, text, public.booking_source) to service_role;
grant execute on function public.get_booking_status(text)           to service_role;
grant execute on function public.cancel_booking_by_code(text)       to service_role;
grant execute on function public.link_whatsapp(text, text)          to service_role;
grant execute on function public.record_inbound(uuid, text)         to service_role;
grant execute on function public.wa_window_open(uuid, text)         to service_role;
grant execute on function public.pending_ahead_alerts(uuid)         to service_role;
grant execute on function public.mark_alert_sent(uuid[])            to service_role;

-- Staff (logged-in) functions.
revoke execute on function public.current_clinic_id()               from public, anon;
revoke execute on function public.effective_minutes(uuid)           from public, anon;
revoke execute on function public.session_counts(uuid)              from public, anon;
revoke execute on function public.call_next(uuid)                   from public, anon;
revoke execute on function public.complete_current(uuid)            from public, anon;
revoke execute on function public.skip_booking(uuid)                from public, anon;
revoke execute on function public.requeue_skipped(uuid, int)       from public, anon;
revoke execute on function public.add_walkin(uuid, text, text, text) from public, anon;

grant execute on function public.current_clinic_id()                to authenticated, service_role;
grant execute on function public.effective_minutes(uuid)            to authenticated, service_role;
grant execute on function public.session_counts(uuid)               to authenticated, service_role;
grant execute on function public.call_next(uuid)                    to authenticated, service_role;
grant execute on function public.complete_current(uuid)             to authenticated, service_role;
grant execute on function public.skip_booking(uuid)                 to authenticated, service_role;
grant execute on function public.requeue_skipped(uuid, int)        to authenticated, service_role;
grant execute on function public.add_walkin(uuid, text, text, text) to authenticated, service_role;

-- =====================================================================
-- QUICK TEST (run in SQL editor as postgres, after creating one clinic,
-- an auth user, and a staff row). Replace the UUIDs.
--
-- insert into clinics (name) values ('Test Clinic') returning id;
-- insert into sessions (clinic_id, doctor_id, session_date, start_time, end_time)
--   values ('<clinic_id>', '<staff_id>', current_date, '00:00', '23:59') returning id;
-- select * from create_booking('<session_id>', 'Ramesh', '9876543210');
-- select * from create_booking('<session_id>', 'Sita',   '9876543211');
-- select * from get_booking_status('<booking_code>');
-- =====================================================================
