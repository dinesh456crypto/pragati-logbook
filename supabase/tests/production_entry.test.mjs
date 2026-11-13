// Phase 4 database rule tests (Production Entry) on embedded Postgres.
// Usage: node production_entry.test.mjs <foundation.sql> <phase1.sql> <phase3.sql> <phase4.sql>   (needs @electric-sql/pglite)
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID as uid } from 'node:crypto'

const [foundation, phase1, phase3, phase4] = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'))
const db = new PGlite()
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, typeof extra === 'string' ? extra : JSON.stringify(extra)) }
}
async function as(user, sql, params) {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user === 'anon' ? '' : user])
  await db.exec(`set role ${user === 'anon' ? 'anon' : 'authenticated'}`)
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
await db.exec(foundation)
const S = '00000000-0000-0000-0000-00000000000a' // super admin
const O = '00000000-0000-0000-0000-00000000000b' // operator: entry view/create, K729 only
const E = '00000000-0000-0000-0000-00000000000c' // editor: entry view/create/edit/delete, all machines
const V = '00000000-0000-0000-0000-00000000000d' // dashboard viewer, all machines
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${O}','ravi@pragati.internal'),
    ('${E}','meena@pragati.internal'),('${V}','vik@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password)
    values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1),('K629',2),('KBA105',3);
`)
await db.exec(phase1)
await db.exec(phase3)
await db.exec(phase4)
console.log('All migrations applied.')

const m = Object.fromEntries((await db.query('select code, id from public.machines')).rows.map((x) => [x.code, x.id]))
const saveUser = (id, name, role, all, machines, perms) =>
  as(S, 'select public.admin_save_user($1,$2,$3,$4,true,$5,$6,$7::jsonb)', [id, name, name, role, all, machines, JSON.stringify(perms)])
ok('operator created', !(await saveUser(O, 'ravi', 'operator', false, [m.K729], [{ resource: 'production_entry', view: true, create: true }])).error)
ok('editor created', !(await saveUser(E, 'meena', 'supervisor', true, [], [{ resource: 'production_entry', view: true, create: true, edit: true, delete: true }])).error)
ok('viewer created', !(await saveUser(V, 'vik', 'manager', true, [], [{ resource: 'dashboard', view: true }])).error)

const one = async (sql) => (await db.query(sql)).rows[0].id
const paper = await one("insert into public.paper_types (name) values ('Art Card 300') returning id")
const op = await one("insert into public.operators (name) values ('Ravi') returning id")
const sup = await one("insert into public.supervisors (name) values ('Kumar') returning id")
const qc = await one("insert into public.qc_executives (name) values ('Asha') returning id")
const coat = await one("insert into public.coatings (name) values ('Aqueous') returning id")
const setup = await one("select id from public.wastage_reasons where name = 'Setup'")
for (const o of ['PO-1', 'PO-2', 'PO-3', 'PO-4']) {
  await db.query(`insert into public.production_jobs (plan_date, order_no, job_name, category, ups, job_type, paper_type_id, quantity, colours)
                  values (current_date, $1, 'Carton ' || $1, 'Carton', 4, 'NEW', $2, 5000, '{C,M,Y,K}')`, [o, paper])
}

// Dates in plant time: D1 = yesterday, D2 = two days ago.
const today = (await db.query("select (now() at time zone 'Asia/Kolkata')::date::text d")).rows[0].d
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const D1 = shift(today, -1), D2 = shift(today, -2), D3 = shift(today, -3)
const ts = (d, hm) => `${d}T${hm}:00+05:30`

const full = (over = {}) => ({
  machine_id: m.K729, production_date: D1, shift: 'A', order_no: 'PO-1', job_name: 'Carton PO-1', category: 'Carton',
  ups: 4, job_type: 'NEW', paper_type_id: paper, planned_quantity: 5000, planned_colours: ['C', 'M', 'Y', 'K'],
  print_side: 'F/S', continuing: false, operator_id: op, supervisor_id: sup, qc_executive_id: qc, helpers: 2,
  unit_colours: ['C', 'M', 'Y', 'K', null, null, null], coating_id: coat, colour_changes: 4, coating_changed: false,
  make_ready_start: ts(D1, '09:00'), make_ready_end: ts(D1, '09:30'),
  registration_start: ts(D1, '09:30'), registration_end: ts(D1, '09:50'),
  colour_matching_start: ts(D1, '09:40'), colour_matching_end: ts(D1, '10:00'),
  run_start: ts(D1, '10:00'), run_end: ts(D1, '12:00'),
  machine_speed: 13500, total_sheets: 5000, ok_sheets: 4800, separate_sheets: 100, ...over,
})
const noChangeover = { make_ready_start: null, make_ready_end: null, registration_start: null, registration_end: null, colour_matching_start: null, colour_matching_end: null }
const W = [{ quantity: 100, reason_id: setup }]
async function save(user, id, submit, entry, wastage = W, expected = null, close = false, saveId = uid()) {
  const r = await as(user, 'select public.save_production_entry($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) r',
    [id, saveId, submit, JSON.stringify(entry), JSON.stringify(wastage), expected, close])
  return r.error ? r : r.rows[0].r
}
const fields = (r) => (r.errors || []).map((e) => e.field)
const row = async (id) => (await db.query('select * from public.production_entries where id = $1', [id])).rows[0]

// Drafts
const d1 = uid(), d1save = uid()
let r = await save(O, d1, false, { machine_id: m.K729, production_date: D1, order_no: 'PO-1' }, [], null, false, d1save)
ok('operator saves a partial draft', r.ok && r.status === 'draft' && r.entry_no === 1, r)
r = await save(O, d1, false, { machine_id: m.K729, production_date: D1, order_no: 'PO-1' }, [], null, false, d1save)
ok('same save id retried is applied once', r.ok && r.repeat === true, r)
let d1row = await row(d1)
r = await save(O, uid(), false, { machine_id: m.K729, production_date: D1 }, [])
ok('second draft on same machine refused with DRAFT_EXISTS', r.code === 'DRAFT_EXISTS' && r.draft.id === d1, r)
r = await save(O, uid(), true, full({ order_no: 'PO-2' }))
ok('new submitted entry on a machine with a draft refused', r.code === 'DRAFT_EXISTS', r)
r = await save(O, uid(), false, { machine_id: m.K629, production_date: D1 }, [])
ok('operator cannot use another machine', r.code === '42501', r)
r = await save(O, d1, false, { machine_id: m.K729, production_date: D1 }, [], '2020-01-01T00:00:00Z')
ok('out-of-date edit refused (STALE)', r.code === 'STALE', r)
r = await save(O, d1, false, { machine_id: m.K729, production_date: D1, unit_colours: ['C', 'c', null, null, null, null, null], ups: 0 }, [], d1row.updated_at)
ok('draft still checks duplicate unit colours and UPS', fields(r).includes('unit_colours') && fields(r).includes('ups'), r)

// Submit the draft
r = await save(O, d1, true, full({ total_sheets: 5001 }), W, d1row.updated_at)
ok('reconciliation must be exact', fields(r).includes('total_sheets') && /Difference: 1/.test(JSON.stringify(r)), r)
r = await save(O, d1, true, full(), [{ quantity: 100 }], d1row.updated_at)
ok('wastage row needs a reason', fields(r).includes('wastage'), r)
r = await save(O, d1, true, full({ unit_colours: ['C', 'Gold', null, null, null, null, null] }), W, d1row.updated_at)
ok('unit colour must be a job colour', fields(r).includes('unit_colours'), r)
r = await save(O, d1, true, full({ ...noChangeover }), W, d1row.updated_at)
ok('first entry needs changeover', ['make_ready', 'registration', 'colour_matching'].every((f) => fields(r).includes(f)), r)
r = await save(O, d1, true, full({ run_start: ts(D1, '09:55') }), W, d1row.updated_at)
ok('run cannot start before changeover ends', fields(r).includes('run'), r)
r = await save(O, d1, true, full({ production_date: shift(today, 1) }), W, d1row.updated_at)
ok('future production date refused', fields(r).includes('production_date'), r)
r = await save(O, d1, true, full({ operator_id: null, helpers: null, machine_speed: null }), W, d1row.updated_at)
ok('required fields reported', ['operator_id', 'helpers', 'machine_speed'].every((f) => fields(r).includes(f)), r)
r = await save(O, d1, true, full(), W, d1row.updated_at)
ok('draft submitted', r.ok && r.status === 'submitted', r)
d1row = await row(d1)
ok('job linked, durations and wastage stored', d1row.job_id && d1row.changeover_minutes === 60 && d1row.run_minutes === 120
  && d1row.make_ready_minutes === 30 && d1row.wastage_sheets === 100 && d1row.submitted_by === O, d1row)
r = await as(O, 'select count(*)::int n from public.production_entry_wastage where entry_id = $1', [d1])
ok('operator can read wastage rows', r.rows?.[0].n === 1, r)

// Same side again, continuation, overlap
r = await save(O, uid(), true, full({ ...noChangeover, run_start: ts(D1, '12:00'), run_end: ts(D1, '14:00') }))
ok('second F/S entry must be marked continuing', fields(r).includes('continuing'), r)
const c1 = uid()
r = await save(O, c1, true, full({ ...noChangeover, continuing: true, run_start: ts(D1, '12:00'), run_end: ts(D1, '14:00') }))
ok('continuing entry without changeover saved', r.ok, r)
ok('continuation linked to first entry', (await row(c1)).continues_entry_id === d1)
r = await save(O, uid(), true, full({ print_side: 'B/S', make_ready_start: ts(D1, '13:00'), make_ready_end: ts(D1, '13:20'),
  registration_start: ts(D1, '13:20'), registration_end: ts(D1, '13:30'), colour_matching_start: ts(D1, '13:30'), colour_matching_end: ts(D1, '13:40'),
  run_start: ts(D1, '13:40'), run_end: ts(D1, '15:00') }))
ok('overlapping times on the machine refused', fields(r).includes('run') && /overlap/.test(JSON.stringify(r)), r)
r = await save(O, uid(), true, full({ order_no: 'PO-2', continuing: true, run_start: ts(D2, '10:00'), run_end: ts(D2, '11:00'),
  make_ready_start: ts(D2, '09:00'), make_ready_end: ts(D2, '09:30'), registration_start: ts(D2, '09:30'), registration_end: ts(D2, '09:50'),
  colour_matching_start: ts(D2, '09:40'), colour_matching_end: ts(D2, '10:00'), production_date: D2 }))
ok('continuing with no earlier entry refused', fields(r).includes('continuing'), r)

// Close sides
let st = (await as(O, 'select public.production_order_status($1,$2,null) s', ['PO-1', m.K729])).rows[0].s
ok('order status: F/S has 2 entries, not first, previous on machine', st.sides.length === 1 && st.sides[0].entries === 2 && !st.is_first && st.previous_on_machine.id === c1, st)
r = await as(O, 'select public.close_order_side($1)', [c1])
ok('operator closes F/S', !r.error, r.error)
r = await save(O, uid(), true, full({ ...noChangeover, continuing: true, run_start: ts(D1, '14:00'), run_end: ts(D1, '14:30') }))
ok('closed side takes no more entries', fields(r).includes('print_side') && /closed/.test(JSON.stringify(r)), r)
const bs = uid()
r = await save(O, bs, true, full({ print_side: 'B/S', make_ready_start: ts(D1, '14:00'), make_ready_end: ts(D1, '14:20'),
  registration_start: ts(D1, '14:20'), registration_end: ts(D1, '14:30'), colour_matching_start: ts(D1, '14:20'), colour_matching_end: ts(D1, '14:40'),
  run_start: ts(D1, '14:40'), run_end: ts(D1, '16:00') }), W, null, true)
ok('B/S saved and closed in one step', r.ok, r)
st = (await as(O, 'select public.production_order_status($1,$2,null) s', ['PO-1', m.K729])).rows[0].s
ok('order PO-1 fully closed', st.fully_closed === true && st.closed_sides.length === 2, st)
r = await as(O, 'select order_no from public.production_order_options()')
ok('closed order left out of the order list', r.rows && !r.rows.some((x) => x.order_no === 'PO-1') && r.rows.some((x) => x.order_no === 'PO-2'), r)
r = await save(E, uid(), true, full({ machine_id: m.K629, print_side: 'O/S' }))
ok('fully closed order takes no entries', fields(r).includes('order_no'), r)
r = await as(O, 'select public.reopen_order_side($1)', [bs])
ok('operator (no edit right) cannot reopen a side', r.code === '42501', r)
r = await as(E, 'select public.reopen_order_side($1)', [bs])
ok('editor reopens B/S', !r.error && !(await as(O, 'select public.production_order_status($1,$2,null) s', ['PO-1', m.K729])).rows[0].s.fully_closed, r)

// Side families and B/B sequence
const bb = (over) => full({ machine_id: m.K629, production_date: D2, order_no: 'PO-3', print_side: 'B/B F',
  make_ready_start: ts(D2, '09:00'), make_ready_end: ts(D2, '09:30'), registration_start: ts(D2, '09:30'), registration_end: ts(D2, '09:50'),
  colour_matching_start: ts(D2, '09:40'), colour_matching_end: ts(D2, '10:00'), run_start: ts(D2, '10:00'), run_end: ts(D2, '12:00'), ...over })
r = await save(E, uid(), true, bb({ ...noChangeover }))
ok('first B/B entry needs changeover', fields(r).includes('make_ready'), r)
r = await save(E, uid(), true, bb())
ok('first B/B F entry saved', r.ok, r)
r = await save(E, uid(), true, bb({ print_side: 'B/B B', ...noChangeover, run_start: ts(D2, '12:00'), run_end: ts(D2, '13:00') }))
ok('later B/B B entry saved without changeover', r.ok, r)
r = await save(E, uid(), true, bb({ print_side: 'F/S', run_start: ts(D2, '14:00'), run_end: ts(D2, '15:00'),
  make_ready_start: ts(D2, '13:00'), make_ready_end: ts(D2, '13:20'), registration_start: ts(D2, '13:20'), registration_end: ts(D2, '13:40'),
  colour_matching_start: ts(D2, '13:40'), colour_matching_end: ts(D2, '14:00') }))
ok('mixing F/S into a B/B order refused', fields(r).includes('print_side'), r)

// Shift / production date rule: B shift after midnight belongs to the previous day.
const night = (date) => full({ machine_id: m.KBA105, order_no: 'PO-4', shift: 'B', production_date: date, ...noChangeover,
  make_ready_start: ts(shift(D3, 1), '00:30'), make_ready_end: ts(shift(D3, 1), '00:50'),
  registration_start: ts(shift(D3, 1), '00:50'), registration_end: ts(shift(D3, 1), '01:00'),
  colour_matching_start: ts(shift(D3, 1), '00:50'), colour_matching_end: ts(shift(D3, 1), '01:00'),
  run_start: ts(shift(D3, 1), '01:00'), run_end: ts(shift(D3, 1), '03:00') })
r = await save(E, uid(), true, night(shift(D3, 1)))
ok('B shift 1 AM run on the calendar date refused', fields(r).includes('production_date'), r)
r = await save(E, uid(), true, night(D3))
ok('B shift 1 AM run on the previous production date saved', r.ok, r)

// Editing submitted entries
d1row = await row(d1)
r = await save(O, d1, true, full({ remarks: 'late paper' }), W, d1row.updated_at)
ok('operator without edit right cannot change a submitted entry', r.code === '42501', r)
r = await save(E, d1, true, full({ remarks: 'late paper' }), W, d1row.updated_at)
ok('editor changes a submitted entry (rules re-checked, own times ignored)', r.ok, r)
ok('submitted_by kept on edit', (await row(d1)).submitted_by === O)

// Visibility and deleting
const d2 = uid()
r = await save(O, d2, false, { machine_id: m.K729, production_date: D1, order_no: 'PO-2' }, [])
ok('operator starts another draft on K729', r.ok, r)
r = await as(V, 'select status from public.production_entries')
ok('dashboard viewer sees submitted entries only', r.rows?.length > 0 && r.rows.every((x) => x.status === 'submitted'), r)
r = await as(O, "select count(*)::int n from public.production_entries where machine_id <> $1", [m.K729])
ok('operator sees only own machine entries', r.rows?.[0].n === 0, r)
r = await as(O, 'insert into public.production_entries (machine_id, production_date) values ($1, current_date)', [m.K729])
ok('direct insert blocked', /permission denied/.test(r.error || ''), r)
r = await as(O, 'update public.production_entries set ok_sheets = 1 where id = $1', [d1])
ok('direct update blocked', /permission denied/.test(r.error || ''), r)
r = await as(O, 'delete from public.production_entries where id = $1 returning id', [d1])
ok('operator cannot delete a submitted entry', r.rows?.length === 0, r)
r = await as(O, 'delete from public.production_entries where id = $1 returning id', [d2])
ok('operator deletes own draft', r.rows?.length === 1, r)
r = await as(E, 'delete from public.production_entries where id = $1', [d1])
ok('entry continued by another cannot be deleted', /foreign key/.test(r.error || ''), r)
r = await as(E, 'delete from public.production_entries where id = $1 returning id', [bs])
ok('editor deletes a submitted entry', r.rows?.length === 1, r)
r = await as('anon', "select public.save_production_entry(gen_random_uuid(), gen_random_uuid(), false, '{}'::jsonb)")
ok('anonymous cannot save', !!r.error, r)
r = await db.query("select count(*)::int n from public.audit_logs where table_name = 'production_entries'")
ok('entry changes are audited', r.rows[0].n > 5)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
