-- Phase 7: User Management screens.
--
--   * user_directory()          List of Users, with last sign-in and machine access.
--   * user_record_count()       How many records a user created or changed.
--   * admin_set_user_active()   Activate / deactivate (the Edge Function also bans the login).
--   * admin_mark_password_reset()  Before a password reset: checks, then "must change password".
--   * admin_delete_user()       Delete only a user who never created or changed any record;
--                               everyone else is deactivated, so the audit trail keeps their name.
--
-- Creating logins, setting passwords and banning stay in the admin-users Edge Function
-- (they need the secret key); these functions run as the signed-in caller, so the
-- database checks the caller's Users permission and the Super Admin rules.

-- ---------------------------------------------------------------------------
-- 1. List of Users
-- ---------------------------------------------------------------------------

create or replace function public.user_directory()
returns table (
  id uuid,
  username text,
  full_name text,
  role text,
  active boolean,
  all_machines boolean,
  must_change_password boolean,
  created_at timestamptz,
  updated_at timestamptz,
  last_sign_in_at timestamptz,
  machine_codes text[],
  permission_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_perm('users', 'view') then
    raise exception 'You do not have permission to view users.' using errcode = '42501';
  end if;
  return query
  select p.id, p.username, p.full_name, p.role, p.active, p.all_machines, p.must_change_password,
         p.created_at, p.updated_at, u.last_sign_in_at,
         coalesce((select array_agg(m.code order by m.sort_order, m.code)
                   from public.profile_machines pm join public.machines m on m.id = pm.machine_id
                   where pm.profile_id = p.id), '{}'),
         (select count(*)::integer from public.user_permissions up where up.profile_id = p.id and up.can_view)
  from public.profiles p
  left join auth.users u on u.id = p.id
  order by p.role = 'super_admin' desc, p.active desc, lower(p.full_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Records a user created or changed (every column that points at profiles,
--    plus their entries in the audit trail other than changes to their own account)
-- ---------------------------------------------------------------------------

create or replace function public.user_record_count_unchecked(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  n bigint;
  v_total bigint := 0;
  v_items jsonb := '[]';
begin
  for r in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
      and c.conrelid not in ('public.profile_machines'::regclass, 'public.user_permissions'::regclass)
    order by 1, 2
  loop
    execute format('select count(*) from %s where %I = $1', r.tbl, r.col) into n using p_id;
    if n > 0 then
      v_total := v_total + n;
      v_items := v_items || jsonb_build_object('table', replace(r.tbl::text, 'public.', ''), 'column', r.col, 'count', n);
    end if;
  end loop;

  select count(*) into n
  from public.audit_logs l
  where l.actor = p_id
    and not (l.table_name in ('profiles', 'profile_machines', 'user_permissions') and l.record_id = p_id::text);
  if n > 0 then
    v_total := v_total + n;
    v_items := v_items || jsonb_build_object('table', 'audit_logs', 'column', 'actor', 'count', n);
  end if;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

create or replace function public.user_record_count(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_perm('users', 'view') then
    raise exception 'You do not have permission to view users.' using errcode = '42501';
  end if;
  return public.user_record_count_unchecked(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Activate / deactivate
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_user_active(p_id uuid, p_active boolean)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  if not public.has_perm('users', 'edit') then
    raise exception 'You do not have permission to edit users.' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_id;
  if v_target.id is null then
    raise exception 'User not found.';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'The Super Admin account cannot be deactivated.';
  end if;
  if p_id = auth.uid() then
    raise exception 'You cannot deactivate your own account.';
  end if;
  update public.profiles set active = coalesce(p_active, false) where id = p_id returning * into v_target;
  return v_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Password reset (the Edge Function sets the new password after this succeeds)
-- ---------------------------------------------------------------------------

create or replace function public.admin_mark_password_reset(p_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  if not public.has_perm('users', 'edit') then
    raise exception 'You do not have permission to edit users.' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_id;
  if v_target.id is null then
    raise exception 'User not found.';
  end if;
  if p_id = auth.uid() then
    raise exception 'Use Change Password to change your own password.';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'Only the Super Admin can change the Super Admin password.';
  end if;
  update public.profiles set must_change_password = true where id = p_id returning * into v_target;
  return v_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Delete (only users with no records; the Edge Function then removes the login)
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_user(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
  v_refs jsonb;
begin
  if not public.has_perm('users', 'delete') then
    raise exception 'You do not have permission to delete users.' using errcode = '42501';
  end if;
  select * into v_target from public.profiles where id = p_id for update;
  if v_target.id is null then
    raise exception 'User not found.';
  end if;
  if v_target.role = 'super_admin' then
    raise exception 'The Super Admin account cannot be deleted.';
  end if;
  if p_id = auth.uid() then
    raise exception 'You cannot delete your own account.';
  end if;
  v_refs := public.user_record_count_unchecked(p_id);
  if (v_refs ->> 'total')::bigint > 0 then
    raise exception '% has % record(s) in the logbook, so the account cannot be deleted. Deactivate it instead: the user cannot sign in, and the records keep their name.',
      v_target.full_name, v_refs ->> 'total';
  end if;
  delete from public.profiles where id = p_id;  -- machine access and permissions go with it
  return jsonb_build_object('ok', true, 'username', v_target.username);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Execution rights
-- ---------------------------------------------------------------------------

revoke execute on function
  public.user_directory(), public.user_record_count(uuid), public.user_record_count_unchecked(uuid),
  public.admin_set_user_active(uuid, boolean), public.admin_mark_password_reset(uuid), public.admin_delete_user(uuid)
from public, anon;

grant execute on function
  public.user_directory(), public.user_record_count(uuid),
  public.admin_set_user_active(uuid, boolean), public.admin_mark_password_reset(uuid), public.admin_delete_user(uuid)
to authenticated;
