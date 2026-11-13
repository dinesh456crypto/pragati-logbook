// Phase 7 database rule tests: List of Users, activate/deactivate, password reset
// checks, and deleting only users without records. Embedded Postgres (PGlite).
// Usage: node users.test.mjs <all migrations in order>
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { readFileSync } from 'node:fs'

const migrations = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'))
const db = new PGlite({ extensions: { btree_gist } })
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, typeof extra === 'string' ? extra : JSON.stringify(extra)) }
}
async function as(user, sql, params) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user])
  await db.exec('set role authenticated')
  try { return { rows: (await db.query(sql, params)).rows } }
  catch (e) { return { error: e.message, code: e.code } }
  finally { await db.exec('reset role') }
}
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`)
const S = '00000000-0000-0000-0000-00000000000a' // super admin
const M = '00000000-0000-0000-0000-00000000000b' // manager: users view/create/edit (no delete)
const O = '00000000-0000-0000-0000-00000000000c' // operator who made a production plan
const N = '00000000-0000-0000-0000-00000000000d' // new user, no records
const D = '00000000-0000-0000-0000-00000000000e' // user with users delete right
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal', '2026-11-13T05:00:00Z'),('${M}','meena@pragati.internal', null),
    ('${O}','ravi@pragati.internal', null),('${N}','nila@pragati.internal', null),('${D}','dev@pragati.internal', null);
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1),('K629',2);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
console.log('All migrations applied.')
const k729 = (await db.query("select id from public.machines where code='K729'")).rows[0].id
const save = (who, id, username, name, role, perms, machines = []) =>
  as(who, 'select public.admin_save_user($1,$2,$3,$4,true,$5,$6,$7::jsonb)', [id, username, name, role, machines.length === 0, machines, perms ? JSON.stringify(perms) : null])
let r = await save(S, M, 'meena', 'Meena', 'manager', [{ resource: 'users', view: true, create: true, edit: true }])
ok('manager created', !r.error, r.error)
r = await save(S, O, 'ravi', 'Ravi', 'operator', [{ resource: 'production_plan', view: true, create: true }], [k729])
ok('operator created on K729', !r.error, r.error)
r = await save(S, N, 'nila', 'Nila', 'office_user', [{ resource: 'dashboard', view: true }])
ok('new user created', !r.error, r.error)
r = await save(S, D, 'dev', 'Dev', 'manager', [{ resource: 'users', view: true, delete: true }])
ok('user with delete right created', !r.error, r.error)

// The operator changes their own temporary password (own-account audit rows don't count) and makes a job.
await as(O, 'select public.mark_password_changed()')
const paper = (await db.query("insert into public.paper_types (name) values ('Art Card') returning id")).rows[0].id
r = await as(O, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify({ plan_date: '2026-11-10', order_no: 'PO-1',
  job_name: 'Box', category: 'Carton', ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 1000 }), JSON.stringify([{ print_side: 'O/S', colours: ['C'] }])])
ok('operator saved a job', r.rows?.[0]?.r?.ok, r)
await as(N, 'select public.mark_password_changed()')

// ---- List of Users -----------------------------------------------------------------
r = await as(M, 'select * from public.user_directory()')
ok('manager sees all 5 users', r.rows?.length === 5, r)
ok('super admin listed first, with last sign-in', r.rows?.[0]?.username === 'dinesh' && r.rows[0].last_sign_in_at !== null, r.rows?.[0])
const ravi = r.rows?.find((x) => x.username === 'ravi')
ok('machine codes and permission count', ravi?.machine_codes?.join() === 'K729' && ravi.permission_count === 1, ravi)
r = await as(O, 'select * from public.user_directory()')
ok('operator cannot list users', /permission to view users/.test(r.error || ''), r)

// ---- Record counts ---------------------------------------------------------------
r = await as(M, 'select public.user_record_count($1) c', [O])
ok('operator has records (job + audit)', r.rows?.[0]?.c?.total > 0 && r.rows[0].c.items.some((x) => x.table === 'production_jobs'), r.rows?.[0]?.c)
r = await as(M, 'select public.user_record_count($1) c', [N])
ok('changing own password is not a record', r.rows?.[0]?.c?.total === 0, r.rows?.[0]?.c)

// ---- Activate / deactivate ---------------------------------------------------------
r = await as(M, 'select (public.admin_set_user_active($1, false)).active a', [N])
ok('manager deactivates a user', r.rows?.[0]?.a === false, r)
r = await as(N, 'select public.has_perm($1,$2) p', ['dashboard', 'view'])
ok('deactivated user loses access at once', r.rows?.[0]?.p === false, r)
r = await as(M, 'select (public.admin_set_user_active($1, true)).active a', [N])
ok('and reactivates', r.rows?.[0]?.a === true, r)
r = await as(M, 'select public.admin_set_user_active($1, false)', [S])
ok('super admin cannot be deactivated', /Super Admin account cannot be deactivated/.test(r.error || ''), r)
r = await as(M, 'select public.admin_set_user_active($1, false)', [M])
ok('cannot deactivate yourself', /your own account/.test(r.error || ''), r)
r = await as(O, 'select public.admin_set_user_active($1, false)', [N])
ok('operator cannot deactivate', /permission to edit users/.test(r.error || ''), r)

// ---- Password reset ----------------------------------------------------------------
r = await as(M, 'select (public.admin_mark_password_reset($1)).must_change_password m', [O])
ok('reset marks must change password', r.rows?.[0]?.m === true, r)
r = await as(M, 'select public.admin_mark_password_reset($1)', [S])
ok('only the super admin changes their own password', /Only the Super Admin/.test(r.error || ''), r)
r = await as(S, 'select public.admin_mark_password_reset($1)', [S])
ok('own password goes through Change Password', /Change Password/.test(r.error || ''), r)

// ---- Delete ------------------------------------------------------------------------
r = await as(M, 'select public.admin_delete_user($1)', [N])
ok('no delete right: refused', /permission to delete users/.test(r.error || ''), r)
r = await as(D, 'select public.admin_delete_user($1)', [O])
ok('user with records cannot be deleted', /record\(s\) in the logbook.*Deactivate/.test(r.error || ''), r)
r = await as(D, 'select public.admin_delete_user($1)', [S])
ok('super admin cannot be deleted', /cannot be deleted/.test(r.error || ''), r)
r = await as(D, 'select public.admin_delete_user($1)', [D])
ok('cannot delete yourself', /your own account/.test(r.error || ''), r)
// Nila was deactivated/reactivated by the manager: those audit rows are the manager's, not hers.
r = await as(D, 'select public.admin_delete_user($1) r', [N])
ok('user without records deleted', r.rows?.[0]?.r?.ok === true, r)
r = await db.query('select (select count(*)::int from public.profiles where id = $1) p, (select count(*)::int from public.user_permissions where profile_id = $1) u', [N])
ok('profile and permissions removed', r.rows[0].p === 0 && r.rows[0].u === 0, r.rows)
r = await db.query("select count(*)::int n from public.audit_logs where table_name = 'profiles' and record_id = $1 and action = 'DELETE' and actor = $2", [N, D])
ok('deletion is in the audit trail with who did it', r.rows[0].n === 1, r.rows)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
