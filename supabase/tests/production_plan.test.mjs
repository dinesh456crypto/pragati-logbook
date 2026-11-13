// Phase 3 database rule tests (Production Plan / Job Details) on embedded Postgres.
// Usage: node production_plan.test.mjs <foundation.sql> <phase1.sql> <phase3.sql>   (needs @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'

const [foundation, phase1, phase3] = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'))
const db = new PGlite()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}
async function as(user, sql, params) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user === 'anon' ? '' : user])
  await db.exec(`set role ${user === 'anon' ? 'anon' : 'authenticated'}`)
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
const S = '00000000-0000-0000-0000-00000000000a' // super admin
const P = '00000000-0000-0000-0000-00000000000b' // planner: production_plan view/create/edit
const O = '00000000-0000-0000-0000-00000000000c' // operator: production_entry view only
const N = '00000000-0000-0000-0000-00000000000d' // no relevant permission
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${P}','priya@pragati.internal'),
    ('${O}','ravi@pragati.internal'),('${N}','nila@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password)
    values ('${S}','dinesh','Dinesh Kumar P','admin', false);
`)
await db.exec(phase1)
await db.exec(phase3)
console.log('All migrations applied.')

const save = (id, name, role, perms) =>
  as(S, 'select public.admin_save_user($1,$2,$3,$4,true,true,$5,$6::jsonb)', [id, name, name, role, [], JSON.stringify(perms)])
ok('planner created', !(await save(P, 'priya', 'supervisor', [{ resource: 'production_plan', view: true, create: true, edit: true }])).error)
ok('operator created', !(await save(O, 'ravi', 'operator', [{ resource: 'production_entry', view: true, create: true }])).error)
ok('no-access user created', !(await save(N, 'nila', 'office_user', [{ resource: 'masters', view: true }])).error)

let r = await as(S, "insert into public.paper_types (name) values ('Art Card 300'), ('Maplitho 80') returning id")
const [art, map] = r.rows.map((x) => x.id)

const insert = (user, v) =>
  as(user, `insert into public.production_jobs (plan_date, order_no, job_name, category, ups, job_type, paper_type_id, quantity, colours)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, created_by, updated_by`,
     [v.date ?? '2026-11-13', v.order, v.name ?? 'Carton A', v.cat ?? 'Carton', v.ups ?? 4, v.type ?? 'NEW', 'paper' in v ? v.paper : art, v.qty ?? 5000, v.colours ?? ['C', 'M', 'Y', 'K']])

r = await insert(P, { order: 'PO-1001' })
ok('planner creates a job', r.rows?.length === 1, r.error)
ok('created_by/updated_by set to planner', r.rows?.[0].created_by === P && r.rows?.[0].updated_by === P)
const job1 = r.rows?.[0].id
ok('duplicate order number (case/space) rejected', /production_jobs_order_no_unique/.test((await insert(P, { order: '  po-1001 ' })).error || ''))
ok('UPS 0 rejected', /check/.test((await insert(P, { order: 'PO-2', ups: 0 })).error || ''))
ok('quantity negative rejected', /check/.test((await insert(P, { order: 'PO-3', qty: -5 })).error || ''))
ok('bad job type rejected', /check/.test((await insert(P, { order: 'PO-4', type: 'Reprint' })).error || ''))
ok('blank order number rejected', /check/.test((await insert(P, { order: '   ' })).error || ''))
ok('10 colours rejected', /check/.test((await insert(P, { order: 'PO-5', colours: ['1','2','3','4','5','6','7','8','9','10'] })).error || ''))
ok('duplicate colours (case) rejected', /check/.test((await insert(P, { order: 'PO-6', colours: ['PMS 185', 'pms 185'] })).error || ''))
ok('empty colour rejected', /check/.test((await insert(P, { order: 'PO-7', colours: ['C', ' '] })).error || ''))
ok('nine colours accepted', !(await insert(P, { order: 'PO-8', colours: ['C','M','Y','K','PMS 185','PMS 286','Varnish','Spot','Gold'] })).error)
ok('no colours accepted', !(await insert(P, { order: 'PO-9', colours: [] })).error)
ok('job without paper type rejected', /null value/.test((await insert(P, { order: 'PO-10', paper: null })).error || ''))

r = await as(P, "update public.production_jobs set quantity = 6000 where id = $1 returning quantity", [job1])
ok('planner edits a job', r.rows?.[0]?.quantity === 6000, r.error)
r = await as(P, 'delete from public.production_jobs where id = $1 returning id', [job1])
ok('planner without delete right cannot delete', r.rows?.length === 0, r.error)

r = await as(O, 'select order_no from public.production_jobs')
ok('operator (production entry) can read jobs', r.rows?.length === 3, JSON.stringify(r))
ok('operator cannot create', /row-level security/.test((await insert(O, { order: 'PO-11' })).error || ''))
r = await as(O, 'update public.production_jobs set ups = 9 returning id')
ok('operator cannot edit', r.rows?.length === 0)
r = await as(N, 'select * from public.production_jobs')
ok('user without plan/entry/ink rights sees nothing', r.rows?.length === 0)
ok('anonymous blocked', !!(await as('anon', 'select * from public.production_jobs')).error)

r = await as(S, 'delete from public.paper_types where id = $1', [art])
ok('paper type used by a job cannot be deleted', /foreign key/.test(r.error || ''), r.error)
ok('unused paper type can be deleted', !(await as(S, 'delete from public.paper_types where id = $1', [map])).error)

r = await as(S, 'delete from public.production_jobs where id = $1 returning id', [job1])
ok('super admin deletes a job', r.rows?.length === 1, r.error)
r = await db.query("select action from public.audit_logs where table_name = 'production_jobs' order by id")
ok('audit log has insert/update/delete', ['INSERT', 'UPDATE', 'DELETE'].every((a) => r.rows.some((x) => x.action === a)), JSON.stringify(r.rows))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
