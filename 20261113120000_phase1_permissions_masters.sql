-- Phase 1: Super Admin + per-user permission matrix, separate master tables,
-- audit trail. Replaces the simple admin/operator model from the foundation.
--
--   * One Super Admin (role = 'super_admin') has every permission.
--   * Every other user gets View / Create / Edit / Delete per screen
--     (user_permissions). Create/Edit/Delete always require View.
--   * Machine access: all machines, or a chosen list (profile_machines).
--   * Ten master lists, each in its own table, with created/updated by + at.
--   * Important changes are written to audit_logs (Super Admin can read).

-- ---------------------------------------------------------------------------
-- 0. Remove foundation objects that this phase replaces
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select on public.profiles;
drop policy if exists machines_select on public.machines;
drop policy if exists machines_insert on public.machines;
drop policy if exists machines_update on public.machines;
drop policy if exists profile_machines_select on public.profile_machines;
drop table if exists public.master_options;   -- was empty; replaced by separate tables
drop function if exists public.admin_upsert_user(uuid, text, text, text, boolean, uuid[], boolean);
drop function if exists public.can_use_machine(uuid);
drop function if exists public.is_admin();

-- ---------------------------------------------------------------------------
-- 1. Profiles: role label, Super Admin, machine scope
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_role_check;
update public.profiles set role = case role when 'admin' then 'super_admin' else 'operator' end
where role in ('admin', 'operator');
alter table public.profiles
  alter column role set default 'operator',
  add constraint profiles_role_check
    check (role in ('super_admin', 'manager', 'supervisor', 'operator', 'office_user')),
  add column all_machines boolean not null default false;

-- Exactly one Super Admin can exist.
create unique index profiles_one_super_admin on public.profiles (role) where role = 'super_admin';

update public.profiles set all_machines = true where role = 'super_admin';

-- ---------------------------------------------------------------------------
-- 2. Shared audit-field trigger: who created / last changed a row, and when
-- ---------------------------------------------------------------------------

create or replace function public.set_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_at := old.created_at;   -- never rewritten
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Machines (Machine ID + mandatory name + default speed)
-- ---------------------------------------------------------------------------

update public.machines set name = code where name is null or btrim(name) = '';
alter table public.machines
  alter column name set not null,
  drop constraint if exists machines_name_check,
  add constraint machines_name_check check (length(btrim(name)) between 1 and 100),
  add column default_speed integer not null default 13500 check (default_speed > 0),
  add column created_by uuid references public.profiles (id) on delete set null,
  add column updated_by uuid references public.profiles (id) on delete set null;

drop trigger if exists machines_updated_at on public.machines;
create trigger machines_audit_fields
before insert or update on public.machines
for each row execute function public.set_audit_fields();

-- ---------------------------------------------------------------------------
-- 4. Nine name-only master lists, each in its own table
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'operators', 'supervisors', 'qc_executives', 'units', 'paper_types',
    'coatings', 'wastage_reasons', 'bdt_reasons', 'odt_reasons'
  ] loop
    execute format($f$
      create table public.%1$I (
        id uuid primary key default gen_random_uuid(),
        name text not null check (length(btrim(name)) between 1 and 100),
        active boolean not null default true,
        created_at timestamptz not null default now(),
        created_by uuid references public.profiles (id) on delete set null,
        updated_at timestamptz not null default now(),
        updated_by uuid references public.profiles (id) on delete set null
      );
      create unique index %1$s_name_unique on public.%1$I (lower(btrim(name)));
      create trigger %1$s_audit_fields
        before insert or update on public.%1$I
        for each row execute function public.set_audit_fields();
    $f$, t);
  end loop;
end;
$$;

-- Values the plant already uses (from the existing logbook). Others start empty.
insert into public.units (name) values
  ('Unit 1'), ('Unit 2'), ('Unit 3'), ('Unit 4'), ('Unit 5'), ('Unit 6'), ('Unit 7'),
  ('Coating'), ('Feeder'), ('Delivery'), ('Other');
insert into public.wastage_reasons (name) values ('Setup'), ('Shade Matching'), ('Others');
insert into public.odt_reasons (name) values
  ('Meeting'), ('Customer Approval'), ('Waiting for Sheets'), ('Others');

-- ---------------------------------------------------------------------------
-- 5. Permission matrix
-- ---------------------------------------------------------------------------

create table public.permission_resources (
  key text primary key,
  module text not null,
  label text not null,
  sort_order integer not null
);

insert into public.permission_resources (key, module, label, sort_order) values
  ('dashboard',        'Dashboard',              'Dashboard',              10),
  ('production_entry', 'Production',             'Production Entry',       20),
  ('bdt',              'Production',             'BDT – Breakdown Time',   21),
  ('odt',              'Production',             'ODT – Other Downtime',   22),
  ('production_log',   'Production',             'Production Log Summary', 23),
  ('production_plan',  'Production Plan',        'Job Details',            30),
  ('masters',          'Master',                 'Master data',            40),
  ('users',            'User Management',        'Users',                  50),
  ('ink_formula',      'Ink Formula Management', 'Ink Formulas',           60);

create table public.user_permissions (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  resource text not null references public.permission_resources (key),
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  primary key (profile_id, resource),
  -- Create, Edit and Delete are not allowed without View.
  constraint user_permissions_view_first
    check (can_view or not (can_create or can_edit or can_delete))
);

-- ---------------------------------------------------------------------------
-- 6. Access helpers (security definer so RLS policies can call them safely)
-- ---------------------------------------------------------------------------

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and p.role = 'super_admin'
  );
$$;

create or replace function public.has_perm(p_resource text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_super_admin() or exists (
    select 1
    from public.user_permissions up
    join public.profiles p on p.id = up.profile_id
    where up.profile_id = auth.uid()
      and p.active
      and up.resource = p_resource
      and case p_action
            when 'view' then up.can_view
            when 'create' then up.can_view and up.can_create
            when 'edit' then up.can_view and up.can_edit
            when 'delete' then up.can_view and up.can_delete
            else false
          end
  );
$$;

create or replace function public.can_use_machine(p_machine_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
      and (p.role = 'super_admin' or p.all_machines or exists (
        select 1 from public.profile_machines pm
        where pm.profile_id = p.id and pm.machine_id = p_machine_id
      ))
  );
$$;

-- The signed-in user's effective permissions (Super Admin: everything).
create or replace function public.my_permissions()
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select r.key,
         public.has_perm(r.key, 'view'),
         public.has_perm(r.key, 'create'),
         public.has_perm(r.key, 'edit'),
         public.has_perm(r.key, 'delete')
  from public.permission_resources r
  where public.is_active_user()
  order by r.sort_order;
$$;

-- ---------------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.permission_resources enable row level security;
alter table public.user_permissions enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.has_perm('users', 'view')));

create policy profile_machines_select on public.profile_machines
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_perm('users', 'view')));

create policy user_permissions_select on public.user_permissions
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.has_perm('users', 'view')));

create policy permission_resources_select on public.permission_resources
  for select to authenticated
  using ((select public.is_active_user()));

-- Machines: master-data viewers see all; everyone else sees machines they may use.
create policy machines_select on public.machines
  for select to authenticated
  using ((select public.has_perm('masters', 'view')) or (active and public.can_use_machine(id)));
create policy machines_insert on public.machines
  for insert to authenticated with check ((select public.has_perm('masters', 'create')));
create policy machines_update on public.machines
  for update to authenticated
  using ((select public.has_perm('masters', 'edit')))
  with check ((select public.has_perm('masters', 'edit')));
create policy machines_delete on public.machines
  for delete to authenticated using ((select public.has_perm('masters', 'delete')));

-- Name-only masters: every active user can read them (production dropdowns);
-- changes follow the Master permission. Rows referenced by production records
-- will be protected by foreign keys added with those tables (deactivate instead).
do $$
declare
  t text;
begin
  foreach t in array array[
    'operators', 'supervisors', 'qc_executives', 'units', 'paper_types',
    'coatings', 'wastage_reasons', 'bdt_reasons', 'odt_reasons'
  ] loop
    execute format($f$
      alter table public.%1$I enable row level security;
      revoke all on public.%1$I from anon;
      create policy %1$s_select on public.%1$I
        for select to authenticated using ((select public.is_active_user()));
      create policy %1$s_insert on public.%1$I
        for insert to authenticated with check ((select public.has_perm('masters', 'create')));
      create policy %1$s_update on public.%1$I
        for update to authenticated
        using ((select public.has_perm('masters', 'edit')))
        with check ((select public.has_perm('masters', 'edit')));
      create policy %1$s_delete on public.%1$I
        for delete to authenticated using ((select public.has_perm('masters', 'delete')));
    $f$, t);
  end loop;
end;
$$;

revoke all on public.permission_resources, public.user_permissions from anon;

-- ---------------------------------------------------------------------------
-- 8. Audit trail
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  table_name text not null,
  record_id text,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data jsonb,
  new_data jsonb
);
create index audit_logs_table_record_idx on public.audit_logs (table_name, record_id);
create index audit_logs_at_idx on public.audit_logs (at desc);

alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon;
-- Only the Super Admin reads the audit trail; nobody writes it directly.
create policy audit_logs_select on public.audit_logs
  for select to authenticated using ((select public.is_super_admin()));

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and v_old - 'updated_at' = v_new - 'updated_at' then
    return null;  -- nothing meaningful changed
  end if;
  insert into public.audit_logs (actor, table_name, record_id, action, old_data, new_data)
  values (
    auth.uid(),
    tg_table_name,
    coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'profile_id', v_old ->> 'profile_id'),
    tg_op,
    v_old,
    v_new
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'profile_machines', 'user_permissions', 'machines',
    'operators', 'supervisors', 'qc_executives', 'units', 'paper_types',
    'coatings', 'wastage_reasons', 'bdt_reasons', 'odt_reasons'
  ] loop
    execute format(
      'create trigger %1$s_audit after insert or update or delete on public.%1$I
         for each row execute function public.audit_row()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Save a user's profile, machine access and permissions in one transaction
-- ---------------------------------------------------------------------------
-- Called by the admin-users Edge Function as the signed-in caller.
--   * Needs the Users Create (new) or Edit (existing) permission.
--   * Only the Super Admin may change permissions or edit the Super Admin.
--   * The Super Admin role cannot be given to anyone else.

create or replace function public.admin_save_user(
  p_id uuid,
  p_username text,
  p_full_name text,
  p_role text,
  p_active boolean,
  p_all_machines boolean,
  p_machine_ids uuid[],
  p_permissions jsonb default null,
  p_must_change_password boolean default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.profiles;
  v_profile public.profiles;
  v_super boolean := public.is_super_admin();
  v_machines uuid[] := coalesce(p_machine_ids, '{}');
  v_item jsonb;
begin
  select * into v_old from public.profiles where id = p_id;

  if not public.has_perm('users', case when v_old.id is null then 'create' else 'edit' end) then
    raise exception 'You do not have permission to % users.',
      case when v_old.id is null then 'create' else 'edit' end using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_id) then
    raise exception 'Login account % does not exist.', p_id;
  end if;

  if p_role not in ('manager', 'supervisor', 'operator', 'office_user', 'super_admin') then
    raise exception 'Select a valid role.';
  end if;

  if v_old.role = 'super_admin' then
    if not v_super or p_id <> auth.uid() then
      raise exception 'The Super Admin account can only be changed by the Super Admin.';
    end if;
    if p_role <> 'super_admin' or not p_active then
      raise exception 'The Super Admin cannot remove their own access.';
    end if;
  elsif p_role = 'super_admin' then
    raise exception 'There can be only one Super Admin.';
  end if;

  if p_permissions is not null and not v_super then
    raise exception 'Only the Super Admin can change permissions.' using errcode = '42501';
  end if;

  if exists (
    select 1 from unnest(v_machines) as m(id)
    where not exists (select 1 from public.machines x where x.id = m.id and x.active)
  ) then
    raise exception 'Select only active machines.';
  end if;

  insert into public.profiles as p
    (id, username, full_name, role, active, all_machines, must_change_password)
  values (
    p_id, lower(btrim(p_username)), btrim(p_full_name), p_role, p_active,
    p_role = 'super_admin' or coalesce(p_all_machines, false),
    coalesce(p_must_change_password, true)
  )
  on conflict (id) do update
  set full_name = excluded.full_name,
      role = excluded.role,
      active = excluded.active,
      all_machines = excluded.all_machines,
      must_change_password = coalesce(p_must_change_password, p.must_change_password)
  returning * into v_profile;

  if v_profile.username <> lower(btrim(p_username)) then
    raise exception 'Usernames cannot be changed.';
  end if;

  -- Explicit machine list only matters when the user is not on all machines.
  delete from public.profile_machines where profile_id = p_id;
  if not v_profile.all_machines then
    insert into public.profile_machines (profile_id, machine_id)
    select p_id, m.id from unnest(v_machines) as m(id)
    on conflict do nothing;
  end if;

  if p_permissions is not null and p_role <> 'super_admin' then
    if jsonb_typeof(p_permissions) <> 'array' then
      raise exception 'Permissions must be a list.';
    end if;
    delete from public.user_permissions where profile_id = p_id;
    for v_item in select * from jsonb_array_elements(p_permissions) loop
      insert into public.user_permissions
        (profile_id, resource, can_view, can_create, can_edit, can_delete)
      values (
        p_id,
        v_item ->> 'resource',
        coalesce((v_item ->> 'view')::boolean, false),
        coalesce((v_item ->> 'create')::boolean, false),
        coalesce((v_item ->> 'edit')::boolean, false),
        coalesce((v_item ->> 'delete')::boolean, false)
      );
    end loop;
  end if;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Function execution rights
-- ---------------------------------------------------------------------------

revoke execute on function
  public.is_super_admin(), public.has_perm(text, text), public.can_use_machine(uuid),
  public.my_permissions(),
  public.admin_save_user(uuid, text, text, text, boolean, boolean, uuid[], jsonb, boolean),
  public.audit_row(), public.set_audit_fields()
from public, anon;

grant execute on function
  public.is_super_admin(), public.has_perm(text, text), public.can_use_machine(uuid),
  public.my_permissions(),
  public.admin_save_user(uuid, text, text, text, boolean, boolean, uuid[], jsonb, boolean)
to authenticated;
