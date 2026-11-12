-- Foundation: user profiles, roles, machine access and master lists.
-- Production jobs, activities and downtime come in later migrations.
--
-- Security model
--   * Browsers use the publishable key; every table below has Row Level Security.
--   * Admins see and manage everything; operators only see machines assigned to them.
--   * Auth users are created by the admin-users Edge Function (service role),
--     which then calls admin_upsert_user() as the signed-in admin.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles: one row per auth user
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique
    check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  full_name text not null check (length(btrim(full_name)) between 1 and 100),
  role text not null default 'operator' check (role in ('admin', 'operator')),
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Machines and which operators may use them
-- ---------------------------------------------------------------------------

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  code text not null check (length(btrim(code)) between 1 and 40),
  name text check (name is null or length(name) <= 100),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Machine codes are unique regardless of case (the old system had K729 and k629).
create unique index machines_code_unique on public.machines (lower(btrim(code)));

create trigger machines_updated_at
before update on public.machines
for each row execute function public.set_updated_at();

create table public.profile_machines (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  machine_id uuid not null references public.machines (id) on delete restrict,
  primary key (profile_id, machine_id)
);

create index profile_machines_machine_idx on public.profile_machines (machine_id);

-- ---------------------------------------------------------------------------
-- Master lists (operators, supervisors, QC, units, papers, coatings, reasons)
-- ---------------------------------------------------------------------------

create table public.master_options (
  id uuid primary key default gen_random_uuid(),
  list_key text not null check (list_key in (
    'operators', 'supervisors', 'qc', 'units', 'papers', 'coatings',
    'wastage_reasons', 'odt_reasons'
  )),
  value text not null check (length(btrim(value)) between 1 and 100),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index master_options_value_unique
  on public.master_options (list_key, lower(btrim(value)));

create trigger master_options_updated_at
before update on public.master_options
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Access helpers used by RLS policies (security definer avoids policy recursion)
-- ---------------------------------------------------------------------------

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'admin'
  );
$$;

create or replace function public.can_use_machine(p_machine_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.profile_machines pm
    join public.profiles p on p.id = pm.profile_id
    where pm.profile_id = auth.uid()
      and pm.machine_id = p_machine_id
      and p.active
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.machines enable row level security;
alter table public.profile_machines enable row level security;
alter table public.master_options enable row level security;

-- Signed-out visitors get nothing, even before policies are checked.
revoke all on public.profiles, public.machines, public.profile_machines, public.master_options from anon;

-- Profiles: read your own row; admins read all. Writes only via admin_upsert_user().
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- Machines: admins see all (including inactive); operators see their active machines.
create policy machines_select on public.machines
  for select to authenticated
  using ((select public.is_admin()) or (active and public.can_use_machine(id)));

create policy machines_insert on public.machines
  for insert to authenticated
  with check ((select public.is_admin()));

-- Machines are deactivated, never deleted, so job history keeps its references.
create policy machines_update on public.machines
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Machine assignments: read your own; admins read all. Writes only via admin_upsert_user().
create policy profile_machines_select on public.profile_machines
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_admin()));

-- Master options: any active user reads them and may "Add new" on the shop floor;
-- only admins rename, reorder or deactivate.
create policy master_options_select on public.master_options
  for select to authenticated
  using ((select public.is_active_user()));

create policy master_options_insert on public.master_options
  for insert to authenticated
  with check ((select public.is_active_user()) and created_by = (select auth.uid()));

create policy master_options_update on public.master_options
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Called by a signed-in user after changing their own password in Supabase Auth.
create or replace function public.mark_password_changed()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles
  set must_change_password = false
  where id = auth.uid();
$$;

-- Creates or updates a user's profile and machine access in one transaction.
-- Only an active admin may call it. The auth user itself is created by the
-- admin-users Edge Function before this runs.
create or replace function public.admin_upsert_user(
  p_id uuid,
  p_username text,
  p_full_name text,
  p_role text,
  p_active boolean,
  p_machine_ids uuid[],
  p_must_change_password boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_machines uuid[] := coalesce(p_machine_ids, '{}');
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_id) then
    raise exception 'Auth user % does not exist.', p_id;
  end if;

  if p_role not in ('admin', 'operator') then
    raise exception 'Select Operator or Administrator.';
  end if;

  if p_id = auth.uid() and (p_role <> 'admin' or not p_active) then
    raise exception 'You cannot remove your own administrator access.';
  end if;

  if p_role = 'operator' and cardinality(v_machines) = 0 then
    raise exception 'Select at least one machine for an operator.';
  end if;

  if exists (
    select 1 from unnest(v_machines) as m(id)
    where not exists (select 1 from public.machines x where x.id = m.id and x.active)
  ) then
    raise exception 'Select only active machines.';
  end if;

  insert into public.profiles as p (id, username, full_name, role, active, must_change_password)
  values (
    p_id,
    lower(btrim(p_username)),
    btrim(p_full_name),
    p_role,
    p_active,
    coalesce(p_must_change_password, true)
  )
  on conflict (id) do update
  set full_name = excluded.full_name,
      role = excluded.role,
      active = excluded.active,
      must_change_password = coalesce(p_must_change_password, p.must_change_password)
  returning * into v_profile;

  if v_profile.username <> lower(btrim(p_username)) then
    raise exception 'Usernames cannot be changed.';
  end if;

  -- Admins have every machine implicitly; store explicit access for operators only.
  delete from public.profile_machines where profile_id = p_id;
  if p_role = 'operator' then
    insert into public.profile_machines (profile_id, machine_id)
    select p_id, m.id from unnest(v_machines) as m(id)
    on conflict do nothing;
  end if;

  if not exists (select 1 from public.profiles where role = 'admin' and active) then
    raise exception 'At least one active administrator is required.';
  end if;

  return v_profile;
end;
$$;

-- Lock down function execution: helpers are for policies and signed-in users only.
revoke execute on function public.is_active_user(), public.is_admin(), public.can_use_machine(uuid),
  public.mark_password_changed(),
  public.admin_upsert_user(uuid, text, text, text, boolean, uuid[], boolean)
  from public, anon;

grant execute on function public.is_active_user(), public.is_admin(), public.can_use_machine(uuid),
  public.mark_password_changed(),
  public.admin_upsert_user(uuid, text, text, text, boolean, uuid[], boolean)
  to authenticated;
