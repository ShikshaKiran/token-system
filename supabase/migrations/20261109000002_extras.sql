-- Doctor-owned medicine lists. Each doctor sees and edits only their own.
create table public.medicine_lists (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  doctor_id  uuid not null references public.staff(id) on delete cascade,
  condition  text not null check (char_length(condition) between 1 and 80),
  medicines  text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (doctor_id, condition)
);
alter table public.medicine_lists enable row level security;
create policy medicine_lists_own on public.medicine_lists for all to authenticated
  using (doctor_id = auth.uid())
  with check (doctor_id = auth.uid() and clinic_id = public.current_clinic_id());
