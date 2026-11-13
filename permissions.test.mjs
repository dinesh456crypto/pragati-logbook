// Database rule tests: applies the migrations to embedded Postgres (PGlite) with
// Supabase-like auth stubs and checks permissions, RLS and audit behaviour.
// Usage: node permissions.test.mjs <foundation.sql> <phase1.sql>   (needs @electric-sql/pglite)
// Applies foundation + phase 1 migrations on embedded Postgres with Supabase-like
// stubs, replays the live data (one admin + 3 machines), then checks the rules.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const [foundation, phase1] = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'))
const db = new PGlite()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}
async function as(user, sql, params) {
  await db.exec('reset role')
  if (user === 'anon') {
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
    await db.exec('set role anon')
  } else if (user) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user])
    await db.exec('set role authenticated')
  } else {
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
  }
  try { return { rows: (await db.query(sql, params)).rows } }
  catch (e) { return { error: e.message } }
  finally { await db.exec('reset role') }
}

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`)
await db.exec(foundation)

const S = '00000000-0000-0000-0000-00000000000a' // dinesh (super admin)
const M = '00000000-0000-0000-0000-00000000000b' // manager with users perms
const O = '00000000-0000-0000-0000-00000000000c' // operator
const X = '00000000-0000-0000-0000-00000000000d' // spare
// Live state before phase 1: dinesh admin + 3 machines.
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${M}','meena@pragati.internal'),
    ('${O}','ravi@pragati.internal'),('${X}','x@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password)
    values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1),('K629',2),('KBA105',3);
`)
await db.exec(phase1)
console.log('Both migrations applied.')

let r = await db.query("select role, all_machines from public.profiles where username='dinesh'")
ok('dinesh became super_admin with all machines', r.rows[0].role === 'super_admin' && r.rows[0].all_machines)
r = await db.query('select code, name, default_speed from public.machines order by sort_order')
ok('machines got names and 13500 default speed', r.rows.every((x) => x.name === x.code && x.default_speed === 13500), JSON.stringify(r.rows))
r = await db.query('select count(*)::int n from public.units')
ok('units seeded (11)', r.rows[0].n === 11)
const m = Object.fromEntries((await db.query('select code, id from public.machines')).rows.map((x) => [x.code, x.id]))

// Super admin
r = await as(S, 'select * from public.my_permissions()')
ok('super admin has all 9 resources with full rights', r.rows?.length === 9 && r.rows.every((x) => x.can_view && x.can_create && x.can_edit && x.can_delete), JSON.stringify(r))

const perms = (list) => JSON.stringify(list)
r = await as(S, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [M, 'meena', 'Meena', 'manager', true, true, [],
  perms([{ resource: 'users', view: true, create: true, edit: true }, { resource: 'masters', view: true }, { resource: 'dashboard', view: true }])])
ok('super admin creates manager with permissions', !r.error, r.error)
r = await as(S, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [O, 'ravi', 'Ravi', 'operator', true, false, [m.K729],
  perms([{ resource: 'production_entry', view: true, create: true, edit: true }])])
ok('super admin creates operator on K729', !r.error, r.error)
r = await as(S, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [X, 'xavier', 'X', 'operator', true, false, [],
  perms([{ resource: 'masters', create: true }])])
ok('create without view is rejected', /view_first/.test(r.error || ''), r.error)
r = await as(S, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7)', [X, 'xavier', 'X', 'super_admin', true, true, []])
ok('second super admin rejected', /only one Super Admin/.test(r.error || ''), r.error)
r = await as(S, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7)', [S, 'dinesh', 'Dinesh Kumar P', 'manager', true, true, []])
ok('super admin cannot demote self', /cannot remove their own/.test(r.error || ''), r.error)

// Manager with users create/edit (not super admin)
r = await as(M, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7)', [X, 'xavier', 'Xavier', 'office_user', true, false, []])
ok('manager with Users:create can create a user', !r.error, r.error)
r = await as(M, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [X, 'xavier', 'Xavier', 'office_user', true, false, [], perms([{ resource: 'users', view: true }])])
ok('manager cannot change permissions', /Only the Super Admin can change permissions/.test(r.error || ''), r.error)
r = await as(M, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7)', [S, 'dinesh', 'Hacked', 'super_admin', true, true, []])
ok('manager cannot edit the super admin', /only be changed by the Super Admin/.test(r.error || ''), r.error)
r = await as(M, 'select username from public.profiles order by username')
ok('manager with Users:view sees all users', r.rows?.length === 4, JSON.stringify(r))

// Operator
r = await as(O, 'select code from public.machines')
ok('operator sees only K729', r.rows?.map((x) => x.code).join() === 'K729', JSON.stringify(r))
r = await as(O, 'select username from public.profiles')
ok('operator sees only own profile', r.rows?.length === 1, JSON.stringify(r))
r = await as(O, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7)', [X, 'xavier', 'X', 'operator', true, true, []])
ok('operator cannot manage users', /do not have permission/.test(r.error || ''), r.error)
r = await as(O, "insert into public.coatings (name) values ('Gloss')")
ok('operator cannot add master data', !!r.error, JSON.stringify(r))
r = await as(O, 'select count(*)::int n from public.odt_reasons')
ok('operator can read master lists for dropdowns', r.rows?.[0]?.n === 4, JSON.stringify(r))
r = await as(O, "select resource from public.my_permissions() where can_view")
ok('operator effective permissions = production_entry only', r.rows?.map((x) => x.resource).join() === 'production_entry', JSON.stringify(r))
r = await as(O, "update public.user_permissions set can_delete=true, can_view=true where profile_id=$1 returning 1", [O])
ok('operator cannot edit own permissions', !r.error && r.rows.length === 0, JSON.stringify(r))

// Manager has masters:view only
r = await as(M, "insert into public.coatings (name) values ('Gloss')")
ok('masters view-only user cannot add', !!r.error, JSON.stringify(r))
r = await as(M, 'select count(*)::int n from public.machines')
ok('masters viewer sees all machines', r.rows?.[0]?.n === 3, JSON.stringify(r))

// Super admin master CRUD + audit fields + audit log
r = await as(S, "insert into public.coatings (name) values ('Gloss') returning created_by, updated_by")
ok('super admin adds coating with created_by set', r.rows?.[0]?.created_by === S && r.rows[0].updated_by === S, JSON.stringify(r))
r = await as(S, "insert into public.coatings (name) values (' gloss ')")
ok('duplicate master name rejected (case/space)', !!r.error, JSON.stringify(r))
r = await as(S, "update public.coatings set name='Gloss UV', created_by=$1 where name='Gloss' returning created_by", [O])
ok('created_by cannot be rewritten on update', r.rows?.[0]?.created_by === S, JSON.stringify(r))
r = await as(S, "insert into public.machines (code, name) values ('k729', 'Duplicate')")
ok('duplicate machine ID rejected', !!r.error, JSON.stringify(r))
r = await as(S, "select action, table_name from public.audit_logs where table_name='coatings' order by id")
ok('audit log captured coating insert + update', r.rows?.map((x) => x.action).join() === 'INSERT,UPDATE', JSON.stringify(r))
r = await as(M, 'select count(*)::int n from public.audit_logs')
ok('non super admin cannot read audit log', r.rows?.[0]?.n === 0, JSON.stringify(r))
r = await as(S, "select count(*)::int n from public.audit_logs where table_name='user_permissions'")
ok('permission changes are audited', r.rows?.[0]?.n >= 1, JSON.stringify(r))

// Disable operator
r = await as(S, 'select public.admin_save_user($1,$2,$3,$4,$5,$6,$7)', [O, 'ravi', 'Ravi', 'operator', false, false, [m.K729]])
ok('super admin disables operator', !r.error, r.error)
r = await as(O, 'select count(*)::int n from public.my_permissions()')
ok('disabled operator has no permissions', r.rows?.[0]?.n === 0, JSON.stringify(r))
r = await as(O, 'select count(*)::int n from public.units')
ok('disabled operator cannot read masters', r.rows?.[0]?.n === 0, JSON.stringify(r))

r = await as('anon', 'select * from public.coatings')
ok('anonymous denied on masters', /permission denied/.test(r.error || ''), JSON.stringify(r))
r = await as('anon', 'select public.has_perm($1,$2)', ['masters', 'view'])
ok('anonymous cannot call has_perm', /permission denied/.test(r.error || ''), JSON.stringify(r))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
