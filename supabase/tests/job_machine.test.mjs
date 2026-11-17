// Each planned job belongs to one machine: Job Details, bulk upload, the Production Entry
// order list and the entry save rule.
// Embedded Postgres (PGlite). Usage: node job_machine.test.mjs <all migrations in order>
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
const S = '00000000-0000-0000-0000-00000000000a'
const last = migrations.pop()
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal', null);
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, name, sort_order) values ('K729','Komori 729',1),('K629','Komori 629',2),('K100','Old press',3);
  update public.machines set active = false where code = 'K100';
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
// A job planned before the change (no machine).
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const paper = (await one("insert into public.paper_types (name) values ('CFBB') returning id")).id
const uv = (await one("insert into public.coatings (name) values ('UV') returning id")).id
await as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb)', [JSON.stringify({ plan_date: '2026-11-10', order_no: 'PO-OLD', job_name: 'Old', category: 'Carton',
  ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 1000, cso_no: 'C', coating_id: uv }), JSON.stringify([{ print_side: 'O/S', colours: ['C', 'M'] }])])
await db.exec(last)
console.log('All migrations applied.')
let r = await one("select machine_id from public.production_jobs where order_no = 'PO-OLD'")
ok('older job kept, without a machine', r && r.machine_id === null, r)

const m = Object.fromEntries((await db.query('select code, id from public.machines')).rows.map((x) => [x.code, x.id]))
const job = (over) => as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify({ plan_date: '2026-11-10', job_name: 'Box', category: 'Carton',
  ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 1000, cso_no: 'CSO-1', coating_id: uv, ...over }), JSON.stringify([{ print_side: 'O/S', colours: ['C', 'M'] }])]).then((x) => x.rows?.[0]?.r ?? x)
r = await job({ order_no: 'PO-1' })
ok('job without a machine refused', r.ok === false && r.errors.some((e) => e.field === 'machine_id' && /Select the Machine/.test(e.message)), r)
r = await job({ order_no: 'PO-1', machine_id: m.K100 })
ok('inactive machine refused', r.ok === false && r.errors.some((e) => e.field === 'machine_id' && /inactive/.test(e.message)), r)
r = await job({ order_no: 'PO-1', machine_id: m.K729 })
ok('job saved on K729', r.ok, r)
r = await one("select machine_id from public.production_jobs where order_no = 'PO-1'")
ok('machine stored', r.machine_id === m.K729)
r = await job({ order_no: 'PO-2', machine_id: m.K629 })
ok('job saved on K629', r.ok, r)

// Bulk upload: Machine by Machine ID or name.
const row = (n, over = {}) => ({ row: n, plan_date: '2026-11-16', order_no: `PO-${100 + n}`, job_name: 'J', category: 'Carton', ups: '2', job_type: 'NEW',
  paper_type: 'cfbb', cso_no: 'CSO-9', coating: 'uv', machine: 'k729', quantity: '100', print_side: 'O/S', colours: 'C', bs_colours: '', ...over })
r = (await as(S, 'select public.import_production_jobs($1::jsonb, true) r', [JSON.stringify([row(2), row(3, { machine: 'Komori 629' }), row(4, { machine: 'X1' }),
  row(5, { machine: 'K100' }), row(6, { machine: '' })])])).rows[0].r
const by = (n) => r.errors.filter((e) => e.row === n)
ok('import: Machine ID and machine name both accepted', by(2).length === 0 && by(3).length === 0, r)
ok('import: unknown machine named', by(4).length === 1 && /Machine "X1" is not in the Machines master/.test(by(4)[0].message), by(4))
ok('import: inactive machine named', by(5).length === 1 && /inactive/.test(by(5)[0].message), by(5))
ok('import: machine required', by(6).length === 1 && by(6)[0].field === 'machine_id', by(6))
r = (await as(S, 'select public.import_production_jobs($1::jsonb) r', [JSON.stringify([row(7, { machine: 'K629' })])])).rows[0].r
ok('import saved', r.ok, r)
r = await one("select m.code from public.production_jobs j join public.machines m on m.id = j.machine_id where j.order_no = 'PO-107'")
ok('imported job on K629', r?.code === 'K629', r)

// Production Entry order list.
r = (await as(S, 'select order_no, machine_ids from public.production_order_options()')).rows
const opt = Object.fromEntries(r.map((x) => [x.order_no, x.machine_ids]))
ok('options carry the planned machine', opt['PO-1']?.join() === m.K729 && opt['PO-2']?.join() === m.K629, opt)
ok('older job without a machine: empty list (offered on every machine)', Array.isArray(opt['PO-OLD']) && opt['PO-OLD'].length === 0, opt)
r = await as(S, "select public.production_order_status('PO-1', $1, null) s", [m.K729])
ok('order status gives the planned machine', r.rows[0].s.job.machine_id === m.K729 && r.rows[0].s.job.machine_code === 'K729', r.rows[0].s.job)

// Entry on the wrong machine is refused; the right machine is fine.
const op = (await one("insert into public.operators (name) values ('Ravi') returning id")).id
const sup = (await one("insert into public.supervisors (name) values ('Kumar') returning id")).id
const qc = (await one("insert into public.qc_executives (name) values ('Asha') returning id")).id
const today = (await one("select (now() at time zone 'Asia/Kolkata')::date::text d")).d
const D = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10)
const ts = (hm) => `${D}T${hm}:00+05:30`
const entry = (order, machine, h) => ({
  machine_id: machine, production_date: D, shift: 'A', order_no: order, cso_no: 'x', job_name: 'Box', category: 'Carton', ups: 4, job_type: 'NEW',
  paper_type_id: paper, planned_quantity: 1000, print_side: 'O/S', operator_id: op, supervisor_id: sup, qc_executive_id: qc, helpers: 2,
  unit_colours: ['C', 'M', null, null, null, null, null], coating_id: uv, planned_colours: ['C', 'M'],
  make_ready_start: ts(`${h}:00`), make_ready_end: ts(`${h}:05`), registration_start: ts(`${h}:05`), registration_end: ts(`${h}:10`),
  colour_matching_start: ts(`${h}:10`), colour_matching_end: ts(`${h}:15`), run_start: ts(`${h}:15`), run_end: ts(`${h}:50`),
  machine_speed: 12000, total_sheets: 1000, ok_sheets: 1000, separate_sheets: 0, remarks: '',
})
const save = async (e, submit = true) => {
  const res = await as(S, "select public.save_production_entry(gen_random_uuid(), gen_random_uuid(), $2, $1::jsonb, '[]'::jsonb, null, false, '[]'::jsonb) r", [JSON.stringify(e), submit])
  return res.error ? res : res.rows[0].r
}
r = await save(entry('PO-1', m.K629, '08'))
ok('planned order on another machine refused', r.ok === false && r.errors.some((e) => e.field === 'order_no' && /planned for machine K729/.test(e.message)), r)
r = await save(entry('PO-1', m.K629, '08'), false)
ok('…also when saving a draft', r.ok === false && r.errors.some((e) => /planned for machine K729/.test(e.message)), r)
r = await save(entry('PO-1', m.K729, '08'))
ok('planned order on its machine saved', r.ok, r)
r = await save(entry('PO-OLD', m.K629, '09'))
ok('older job without a machine can run on any machine', r.ok, r)
r = await save(entry('PO-NEW', m.K629, '10'))
ok('unplanned order still allowed', r.ok, r)
r = (await as(S, 'select order_no, machine_ids from public.production_order_options()')).rows
ok('unplanned order listed for the machine it ran on', r.find((x) => x.order_no === 'PO-NEW')?.machine_ids?.join() === m.K629, r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
