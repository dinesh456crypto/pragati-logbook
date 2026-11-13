// Phase 9 database rule tests: ink formulas skip C/M/Y/K and keep the paper type;
// Wastage Management. Embedded Postgres (PGlite).
// Usage: node wastage.test.mjs <all migrations in order, ending with phase9>
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
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`)
const S = '00000000-0000-0000-0000-00000000000a' // super admin
const I = '00000000-0000-0000-0000-00000000000b' // ink + wastage user: view + create only
const V = '00000000-0000-0000-0000-00000000000c' // production entry only, no ink rights
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${I}','inku@pragati.internal'),('${V}','ravi@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
console.log('All migrations applied.')
await as(S, "select public.admin_save_user($1,'inku','Ink Person','office_user',true,true,'{}',$2::jsonb)", [I, JSON.stringify([
  { resource: 'ink_formula', view: true, create: true }, { resource: 'wastage', view: true, create: true }])])
await as(S, "select public.admin_save_user($1,'ravi','Ravi','operator',true,true,'{}',$2::jsonb)", [V, JSON.stringify([{ resource: 'production_entry', view: true, create: true }])])
const one = async (sql) => (await db.query(sql)).rows[0].id
const paper = await one("insert into public.paper_types (name) values ('Art Card 300') returning id")
const job = (order, sides) => as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify({ plan_date: '2026-11-10', order_no: order,
  job_name: 'Carton ' + order, category: 'Carton', ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 1000 }), JSON.stringify(sides)])
await job('PO-1', [{ print_side: 'F/S', colours: ['C', 'M', 'Y', 'K', 'PMS 185'] }, { print_side: 'B/S', colours: ['k', 'Gold'] }])
await job('PO-2', [{ print_side: 'O/S', colours: ['C', 'M', 'Y', 'K'] }])

// ---- Ink formulas: C, M, Y, K need no formula ---------------------------------------
let r = await as(I, "select public.order_plan_colours(id) c from public.production_jobs where order_no = 'PO-1'")
const plan = r.rows[0].c
ok('plan colours flag C, M, Y, K as standard', plan.filter((x) => x.standard).map((x) => x.colour.toUpperCase()).sort().join() === 'C,K,M,Y'
  && plan.filter((x) => !x.standard).length === 2, plan)
const save = async (user, id, order, colours, expected = null) => {
  const res = await as(user, 'select public.save_ink_formula($1,$2,$3::jsonb,null,$4) r', [id, order, JSON.stringify(colours), expected])
  return res.error ? res : res.rows[0].r
}
r = await save(I, null, 'PO-2', [{ colour: 'C', formula: 'x' }])
ok('order with only C, M, Y, K needs no formula record', /only the standard colours/.test(JSON.stringify(r)), r)
r = await save(I, null, 'PO-1', [{ colour: 'C', formula: 'should be ignored' }, { colour: 'PMS 185', formula: 'Base 80% + Rubine 20%' }, { colour: 'Gold', formula: '' }])
ok('formula saved', r.ok, r)
r = await db.query('select colour from public.ink_formula_colours where record_id = $1 order by line', [r.id])
ok('standard colours left off the record', r.rows.map((x) => x.colour).join() === 'PMS 185,Gold', r.rows)
r = await db.query("select paper_type from public.ink_formula_records where order_no = 'PO-1'")
ok('record keeps the Type of Paper', r.rows[0].paper_type === 'Art Card 300', r.rows)

// ---- Wastage Management -----------------------------------------------------------
const m = (await db.query("select id from public.machines where code = 'K729'")).rows[0].id
const op = await one("insert into public.operators (name) values ('Ravi') returning id")
const sup = await one("insert into public.supervisors (name) values ('Kumar') returning id")
const qc = await one("insert into public.qc_executives (name) values ('Asha') returning id")
const coat = await one("insert into public.coatings (name) values ('UV') returning id")
const wr = await one("select id from public.wastage_reasons limit 1")
const today = (await db.query("select (now() at time zone 'Asia/Kolkata')::date::text d")).rows[0].d
const D = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10)
const ts = (hm) => `${D}T${hm}:00+05:30`
const entry = (side, start, end, given, okq, sep, waste, colours) => ({
  machine_id: m, production_date: D, shift: 'A', order_no: 'PO-1', job_name: 'Carton PO-1', category: 'Carton', ups: 4, job_type: 'NEW',
  paper_type_id: paper, planned_quantity: 1000, print_side: side, operator_id: op, supervisor_id: sup, qc_executive_id: qc, helpers: 2,
  unit_colours: [...colours, ...Array(7 - colours.length).fill(null)], coating_id: coat, colour_changes: 2, coating_changed: false,
  make_ready_start: ts(start[0]), make_ready_end: ts(start[1]), registration_start: ts(start[1]), registration_end: ts(start[2]),
  colour_matching_start: ts(start[2]), colour_matching_end: ts(start[3]), run_start: ts(start[3]), run_end: ts(end),
  machine_speed: 12000, total_sheets: given, ok_sheets: okq, separate_sheets: sep, _w: waste,
})
const submit = async (e) => {
  const w = [{ quantity: e._w, reason_id: wr }]
  delete e._w
  const res = await as(S, "select public.save_production_entry(gen_random_uuid(), gen_random_uuid(), true, $1::jsonb, $2::jsonb, null, false, '[]'::jsonb) r", [JSON.stringify(e), JSON.stringify(w)])
  return res.error ? res : res.rows[0].r
}
r = await as(I, 'select order_no from public.wastage_order_options()')
ok('no order is offered before production is submitted', r.rows?.length === 0, r)
r = await submit(entry('F/S', ['08:00', '08:30', '08:45', '09:00'], '11:00', 5000, 4700, 100, 200, ['C', 'M']))
ok('F/S production entry submitted', r.ok, r)
r = await submit(entry('B/S', ['11:00', '11:20', '11:30', '11:40'], '13:00', 4700, 4600, 20, 80, ['K', 'Gold']))
ok('B/S production entry submitted', r.ok, r)
r = await as(I, 'select order_no, job_name, record_id from public.wastage_order_options()')
ok('order now offered for wastage entry', r.rows?.length === 1 && r.rows[0].order_no === 'PO-1' && r.rows[0].record_id === null, r)
r = await as(I, "select public.order_production_totals('po-1') t")
const t = r.rows?.[0].t
ok('production totals: OK 9300, production wastage = given - OK - separate = 280, UPS 4',
  t.ok_sheets === 9300 && t.production_wastage === 9700 - 9300 - 120 && t.ups === 4 && t.sides.length === 2 && t.entries === 2, t)
r = await as(V, "select public.order_production_totals('PO-1') t")
ok('users without wastage rights get nothing', r.rows?.[0].t === null, r)

const saveW = async (user, id, order, rec, lines, expected = null) => {
  const res = await as(user, 'select public.save_wastage_record($1,$2,$3::jsonb,$4::jsonb,$5) r', [id, order, JSON.stringify(rec), JSON.stringify(lines), expected])
  return res.error ? res : res.rows[0].r
}
r = await saveW(I, null, 'PO-1', { order_qty: '', packed_qty: '' }, [{ process: '', defect: 'x', quantity: 0, unit: 'boxes' }])
ok('all problems listed together', r.code === 'INVALID' && r.errors.length >= 5, r)
r = await saveW(I, null, 'PO-9', { order_qty: 10, packed_qty: 5 }, [{ process: 'Die cutting', defect: 'Torn', quantity: 2, unit: 'cartons' }])
ok('order without production refused', /submitted production entries/.test(JSON.stringify(r)), r)
r = await saveW(I, null, 'PO-1', { order_qty: 36000, packed_qty: 35000 }, [])
ok('at least one wastage line needed', /at least one wastage line/.test(JSON.stringify(r)), r)
r = await saveW(V, null, 'PO-1', { order_qty: 36000, packed_qty: 35000 }, [{ process: 'Die cutting', defect: 'Torn', quantity: 2, unit: 'cartons' }])
ok('user without wastage rights cannot save', r.code === '42501', r)
r = await saveW(I, null, 'po-1', { order_qty: 36000, packed_qty: 35000, remarks: 'Rush order' }, [
  { process: 'Die cutting', defect: 'Torn edges', reason: 'Blunt blade', quantity: 120, unit: 'cartons' },
  { process: '', defect: '', reason: '', quantity: '' },
  { process: 'Pasting', defect: 'Glue spill', reason: '', quantity: 40, unit: 'sheets' },
])
ok('wastage record saved (empty line skipped)', r.ok && r.record_no === 1, r)
const wid = r.id
let rec = (await db.query('select * from public.wastage_records where id = $1', [wid])).rows[0]
ok('snapshot from production stored', rec.job_name === 'Carton PO-1' && rec.ups === 4 && rec.ok_sheets === 9300 && rec.production_wastage === 280
  && rec.order_qty === 36000 && rec.packed_qty === 35000 && rec.created_by_name === 'Ink Person', rec)
r = await db.query('select line, process, unit, quantity from public.wastage_lines where record_id = $1 order by line', [wid])
ok('lines numbered 1, 2', r.rows.length === 2 && r.rows[1].line === 2 && r.rows[1].unit === 'sheets', r.rows)
r = await saveW(I, null, 'PO-1', { order_qty: 1, packed_qty: 1 }, [{ process: 'x', defect: 'y', quantity: 1, unit: 'cartons' }])
ok('second record for the order refused (EXISTS)', r.code === 'EXISTS' && r.id === wid, r)
r = await saveW(I, wid, null, { order_qty: 36000, packed_qty: 35500 }, [{ process: 'Die cutting', defect: 'Torn edges', quantity: 100, unit: 'cartons' }], rec.updated_at)
ok('user without edit right cannot change', r.code === '42501', r)
r = await saveW(S, wid, null, { order_qty: 36000, packed_qty: 35500 }, [{ process: 'Die cutting', defect: 'Torn edges', quantity: 100, unit: 'cartons' }], '2020-01-01T00:00:00Z')
ok('out-of-date edit refused', r.code === 'STALE', r)
r = await saveW(S, wid, null, { order_qty: 36000, packed_qty: 35500 }, [{ process: 'Die cutting', defect: 'Torn edges', quantity: 100, unit: 'cartons' }], rec.updated_at)
ok('admin edits the record', r.ok, r)
rec = (await db.query('select * from public.wastage_records where id = $1', [wid])).rows[0]
ok('edit saved: packed 35500, 1 line, updated by admin', rec.packed_qty === 35500 && rec.updated_by_name === 'Dinesh Kumar P'
  && (await db.query('select count(*)::int n from public.wastage_lines where record_id = $1', [wid])).rows[0].n === 1, rec)
r = await as(V, 'select count(*)::int n from public.wastage_records')
ok('users without wastage rights see no records', r.rows?.[0].n === 0, r)
r = await as(I, 'delete from public.wastage_records where id = $1 returning id', [wid])
ok('user without delete right cannot delete', r.rows?.length === 0, r)
r = await as(S, 'delete from public.wastage_records where id = $1 returning id', [wid])
ok('admin deletes the record (lines go with it)', r.rows?.length === 1 && (await db.query('select count(*)::int n from public.wastage_lines')).rows[0].n === 0, r)
r = await as(S, 'select resource, can_view from public.my_permissions() where resource = $1', ['wastage'])
ok('wastage appears in the permission list', r.rows?.length === 1 && r.rows[0].can_view, r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
