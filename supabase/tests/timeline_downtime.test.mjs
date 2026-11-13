// Phase 4b database rule tests: print-side colour slots, sequential timeline,
// BDT / ODT events, gross / net changeover. Embedded Postgres (PGlite).
// Usage: node timeline_downtime.test.mjs <foundation> <phase1> <phase3> <phase4> <phase4b>
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID as uid } from 'node:crypto'

const migrations = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'))
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
const S = '00000000-0000-0000-0000-00000000000a' // super admin
const O = '00000000-0000-0000-0000-00000000000b' // operator: entry + BDT create, K729 only
const P = '00000000-0000-0000-0000-00000000000c' // planner: production_plan create/edit
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${O}','ravi@pragati.internal'),('${P}','priya@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1),('K629',2),('KBA105',3);
`)
await db.exec(migrations[1])
await db.exec(migrations[2])
// A job planned before this phase, with the old single colour list.
await db.exec(`insert into public.paper_types (name) values ('Art Card 300');
  insert into public.production_jobs (plan_date, order_no, job_name, ups, job_type, paper_type_id, quantity, colours)
  select current_date, 'OLD-1', 'Old job', 1, 'NEW', id, 100, '{C,M}' from public.paper_types`)
await db.exec(migrations[3])
await db.exec(migrations[4])
console.log('All migrations applied.')

let r = await db.query("select s.print_side, s.colours from public.production_job_sides s join public.production_jobs j on j.id = s.job_id where j.order_no = 'OLD-1'")
ok('old job colours moved into an O/S slot', r.rows.length === 1 && r.rows[0].print_side === 'O/S' && r.rows[0].colours.join() === 'C,M', r.rows)

const m = Object.fromEntries((await db.query('select code, id from public.machines')).rows.map((x) => [x.code, x.id]))
const saveUser = (id, name, role, all, machines, perms) =>
  as(S, 'select public.admin_save_user($1,$2,$3,$4,true,$5,$6,$7::jsonb)', [id, name, name, role, all, machines, JSON.stringify(perms)])
ok('operator created', !(await saveUser(O, 'ravi', 'operator', false, [m.K729],
  [{ resource: 'production_entry', view: true, create: true }, { resource: 'bdt', view: true, create: true }])).error)
ok('planner created', !(await saveUser(P, 'priya', 'supervisor', true, [], [{ resource: 'production_plan', view: true, create: true, edit: true }])).error)

const one = async (sql) => (await db.query(sql)).rows[0].id
const paper = await one("select id from public.paper_types limit 1")
const op = await one("insert into public.operators (name) values ('Ravi') returning id")
const sup = await one("insert into public.supervisors (name) values ('Kumar') returning id")
const qc = await one("insert into public.qc_executives (name) values ('Asha') returning id")
const coat = await one("insert into public.coatings (name) values ('Aqueous') returning id")
const setup = await one("select id from public.wastage_reasons where name = 'Setup'")
const bdtReason = await one("insert into public.bdt_reasons (name) values ('Motor fault') returning id")
const odtReason = await one("select id from public.odt_reasons where name = 'Meeting'")

// ---- Production Plan with print-side slots ---------------------------------------
const job = (over = {}) => ({ plan_date: '2026-11-10', order_no: 'PO-1', job_name: 'Carton', category: 'Carton', ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 5000, ...over })
const saveJob = async (user, id, j, sides, expected = null) => {
  const res = await as(user, 'select public.save_production_job($1,$2::jsonb,$3::jsonb,$4) r', [id, JSON.stringify(j), JSON.stringify(sides), expected])
  return res.error ? res : res.rows[0].r
}
const fields = (x) => (x.errors || []).map((e) => e.field)
const msgs = (x) => JSON.stringify(x.errors || x)
const many = Array.from({ length: 12 }, (_, i) => `Colour ${i + 1}`)
r = await saveJob(P, null, job(), [
  { print_side: 'F/S', colours: ['C', 'M', 'Y', 'K', 'PMS 185', 'Varnish', 'Gold', ...many] },
  { print_side: 'B/S', colours: ['K', 'PMS 286'] },
])
ok('planner saves job with F/S (19 colours) and B/S slots', r.ok, r)
const job1 = r.id
r = await saveJob(P, null, job({ order_no: 'po-1 ' }), [{ print_side: 'O/S', colours: ['C'] }])
ok('duplicate order number refused', fields(r).includes('order_no'), r)
r = await saveJob(P, null, job({ order_no: 'PO-2' }), [{ print_side: 'F/S', colours: ['C'] }, { print_side: 'B/B F', colours: ['M'] }])
ok('mixed side families refused', /cannot be mixed/.test(msgs(r)), r)
r = await saveJob(P, null, job({ order_no: 'PO-2' }), [{ print_side: 'F/S', colours: ['C'] }, { print_side: 'F/S', colours: ['M'] }])
ok('same side twice refused', /more than once/.test(msgs(r)), r)
r = await saveJob(P, null, job({ order_no: 'PO-2' }), [{ print_side: 'F/S', colours: [' ', ''] }])
ok('slot without colours refused', /at least one colour/.test(msgs(r)), r)
r = await saveJob(P, null, job({ order_no: 'PO-2' }), [{ print_side: 'F/S', colours: ['C', 'c'] }])
ok('repeated colour in a slot refused', /each colour once/.test(msgs(r)), r)
r = await saveJob(P, null, job({ order_no: 'PO-2' }), [])
ok('job needs a print side', fields(r).includes('sides'), r)
r = await saveJob(O, null, job({ order_no: 'PO-3' }), [{ print_side: 'O/S', colours: ['C'] }])
ok('operator without plan rights cannot save jobs', r.code === '42501', r)
r = await as(P, 'select print_side, colours from public.production_job_sides where job_id = $1 order by line', [job1])
ok('slots stored in order', r.rows?.length === 2 && r.rows[0].print_side === 'F/S' && r.rows[0].colours.length === 19, r)
r = await as(O, 'select count(*)::int n from public.production_job_sides')
ok('entry users can read slots', r.rows?.[0].n >= 2, r)
let st = (await as(O, 'select public.production_order_status($1,$2,null) s', ['PO-1', m.K729])).rows[0].s
ok('order status returns side slots', st.job.sides.length === 2 && st.job.sides[1].print_side === 'B/S', st)

// ---- Entry: side colours, sequence, downtime, net ------------------------------
const today = (await db.query("select (now() at time zone 'Asia/Kolkata')::date::text d")).rows[0].d
const D = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10)
const ts = (hm, d = D) => `${d}T${hm}:00+05:30`
const entry = (over = {}) => ({
  machine_id: m.K729, production_date: D, shift: 'A', order_no: 'PO-1', job_name: 'Carton', category: 'Carton', ups: 4,
  job_type: 'NEW', paper_type_id: paper, planned_quantity: 5000, planned_colours: ['ignored'], print_side: 'F/S',
  operator_id: op, supervisor_id: sup, qc_executive_id: qc, helpers: 2, unit_colours: ['C', 'M', 'Y', 'K', 'Gold', null, null],
  coating_id: coat, colour_changes: 4, coating_changed: false,
  make_ready_start: ts('08:00'), make_ready_end: ts('09:00'), registration_start: ts('09:00'), registration_end: ts('09:30'),
  colour_matching_start: ts('09:30'), colour_matching_end: ts('10:00'), run_start: ts('10:00'), run_end: ts('12:00'),
  machine_speed: 13500, total_sheets: 5000, ok_sheets: 4900, separate_sheets: 0, manual_starts: ['make_ready'], ...over,
})
const W = [{ quantity: 100, reason_id: setup }]
const bdt = (s, e, over = {}) => ({ kind: 'BDT', start_at: ts(s), end_at: ts(e), reason_id: bdtReason, ...over })
async function save(user, id, submit, e, downtime = [], expected = null) {
  const res = await as(user, 'select public.save_production_entry($1,$2,$3,$4::jsonb,$5::jsonb,$6,false,$7::jsonb) r',
    [id, uid(), submit, JSON.stringify(e), JSON.stringify(W), expected, JSON.stringify(downtime)])
  return res.error ? res : res.rows[0].r
}
const row = async (id) => (await db.query('select * from public.production_entries where id = $1', [id])).rows[0]

r = await save(O, uid(), true, entry({ unit_colours: ['C', 'PMS 286', null, null, null, null, null] }))
ok('B/S-only colour refused on F/S', fields(r).includes('unit_colours') && /PMS 286/.test(msgs(r)), r)
r = await save(O, uid(), true, entry({ print_side: 'O/S' }))
ok('unplanned side of a planned order refused', fields(r).includes('print_side') && /no colours planned/.test(msgs(r)), r)
r = await save(O, uid(), true, entry({ registration_start: ts('08:50') }))
ok('registration cannot start before make ready ends', fields(r).includes('registration'), r)
r = await save(O, uid(), true, entry({ run_start: ts('09:55') }))
ok('production cannot start before colour matching ends', fields(r).includes('run'), r)
r = await save(O, uid(), true, entry(), [bdt('07:30', '07:50')])
ok('downtime outside the job window refused', fields(r).includes('downtime') && /outside this job/.test(msgs(r)), r)
r = await save(O, uid(), true, entry(), [{ kind: 'BDT', start_at: ts('08:15'), end_at: ts('08:30'), reason_id: odtReason }])
ok('reason of the wrong type refused', /does not match/.test(msgs(r)), r)
r = await save(O, uid(), true, entry(), [bdt('08:15', null, { end_at: null })])
ok('downtime row needs an end on submit', /Start and End/.test(msgs(r)), r)

const e1 = uid()
r = await save(O, e1, true, entry(), [bdt('08:15', '08:30')])
ok('entry with BDT saved', r.ok, r)
let e = await row(e1)
ok('planned colours = F/S slot', e.planned_colours.length === 19 && e.planned_colours.includes('Gold') && !e.planned_colours.includes('PMS 286'))
ok('spec example: gross 120, net 105, make ready net 45', e.changeover_gross_minutes === 120 && e.changeover_net_minutes === 105
  && e.make_ready_net_minutes === 45 && e.registration_net_minutes === 30 && e.run_net_minutes === 120 && e.downtime_minutes === 15, e)
ok('manual start flags kept', e.manual_starts.join() === 'make_ready')
r = await as(O, 'select kind, production_date::text, shift, minutes from public.downtime_events where entry_id = $1', [e1])
ok('job downtime stored with machine, date, shift', r.rows?.length === 1 && r.rows[0].minutes === 15 && r.rows[0].shift === 'A', r)

// Overlapping rows are merged, a row across two steps is split between them.
e = await row(e1)
r = await as(S, 'select public.save_production_entry($1,$2,true,$3::jsonb,$4::jsonb,$5,false,$6::jsonb) r', [e1, uid(), JSON.stringify(entry()), JSON.stringify(W), e.updated_at,
  JSON.stringify([bdt('08:15', '08:30'), { kind: 'ODT', start_at: ts('08:20'), end_at: ts('08:40'), reason_id: odtReason }, bdt('08:50', '09:10'), bdt('11:00', '11:30')])])
ok('edit with overlapping downtime saved', r.rows?.[0].r.ok, r)
e = await row(e1)
ok('overlaps merged (25 min), split across steps (10 + 10), production net', e.make_ready_net_minutes === 25 && e.registration_net_minutes === 20
  && e.colour_matching_net_minutes === 30 && e.changeover_net_minutes === 75 && e.changeover_gross_minutes === 120
  && e.run_net_minutes === 90 && e.downtime_minutes === 75, e)

// ---- Downtime between jobs and the machine timeline -------------------------------
const outside = async (user, id, ev, expected = null) => {
  const res = await as(user, 'select public.save_outside_downtime($1,$2::jsonb,$3) r', [id, JSON.stringify(ev), expected])
  return res.error ? res : res.rows[0].r
}
r = await outside(O, null, { kind: 'BDT', machine_id: m.K729, start_at: ts('11:00'), end_at: ts('11:20'), reason_id: bdtReason })
ok('downtime between jobs cannot fall inside a job', fields(r).includes('start'), r)
r = await outside(O, null, { kind: 'ODT', machine_id: m.K729, start_at: ts('12:00'), end_at: ts('12:30'), reason_id: odtReason })
ok('operator without ODT rights cannot record ODT', r.code === '42501', r)
r = await outside(O, null, { kind: 'BDT', machine_id: m.K629, start_at: ts('12:00'), end_at: ts('12:30'), reason_id: bdtReason })
ok('operator cannot record on another machine', r.code === '42501', r)
r = await outside(O, null, { kind: 'BDT', machine_id: m.K729, start_at: ts('12:10'), end_at: ts('12:40'), reason_id: bdtReason })
ok('BDT between jobs saved', r.ok, r)
const out1 = r.id
let tl = (await as(O, 'select public.machine_timeline($1, null) t', [m.K729])).rows[0].t
ok('timeline: previous job end 12:00, ready after downtime 12:40', tl.previous.id === e1
  && new Date(tl.previous.run_end).getTime() === Date.parse(ts('12:00')) && new Date(tl.ready_at).getTime() === Date.parse(ts('12:40'))
  && tl.downtime.length === 1, tl)
tl = (await as(S, 'select public.machine_timeline($1, null) t', [m.K629])).rows[0].t
ok('timeline is per machine (K629 has none)', tl.previous === null && tl.ready_at === null, tl)

const e2 = uid()
r = await save(O, e2, true, entry({ print_side: 'B/S', unit_colours: ['K', 'PMS 286', null, null, null, null, null],
  make_ready_start: ts('12:30'), make_ready_end: ts('13:00'), registration_start: ts('13:00'), registration_end: ts('13:10'),
  colour_matching_start: ts('13:10'), colour_matching_end: ts('13:20'), run_start: ts('13:20'), run_end: ts('14:00') }))
ok('next job overlapping downtime between jobs refused', fields(r).includes('run') && /between jobs/.test(msgs(r)), r)
r = await save(O, e2, true, entry({ print_side: 'B/S', unit_colours: ['K', 'PMS 286', null, null, null, null, null], manual_starts: [],
  make_ready_start: ts('12:40'), make_ready_end: ts('13:00'), registration_start: ts('13:00'), registration_end: ts('13:10'),
  colour_matching_start: ts('13:10'), colour_matching_end: ts('13:20'), run_start: ts('13:20'), run_end: ts('14:00') }))
ok('next job from machine-ready time saved', r.ok, r)
e = await row(e2)
ok('timeline reference stored (previous entry, ready at 12:40)', e.previous_entry_id === e1 && new Date(e.machine_ready_at).getTime() === Date.parse(ts('12:40')), e)

const night = await outside(S, null, { kind: 'ODT', machine_id: m.KBA105, start_at: ts('02:00'), end_at: ts('02:30'), reason_id: odtReason })
ok('night ODT saved', night.ok, night)
r = await db.query('select production_date::text d, shift from public.downtime_events where id = $1', [night.id])
const yesterday = new Date(Date.parse(D + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
ok('02:00 downtime belongs to B shift of the previous day', r.rows[0].shift === 'B' && r.rows[0].d === yesterday, r.rows)
r = await outside(S, null, { kind: 'ODT', machine_id: m.KBA105, start_at: ts('03:00'), end_at: ts('02:50'), reason_id: odtReason })
ok('end before start refused', fields(r).includes('end'), r)
r = await outside(S, null, { kind: 'BDT', machine_id: m.KBA105, start_at: ts('03:00'), reason_id: bdtReason })
ok('open breakdown (no end yet) saved', r.ok, r)
tl = (await as(S, 'select public.machine_timeline($1, null) t', [m.KBA105])).rows[0].t
ok('open breakdown reported on the timeline', tl.open_downtime.length === 1, tl)

// Deleting
r = await as(O, 'delete from public.downtime_events where id = $1 returning id', [out1])
ok('operator without BDT delete right cannot delete', r.rows?.length === 0, r)
r = await as(S, 'delete from public.downtime_events where entry_id is not null returning id')
ok('job downtime cannot be deleted directly', r.rows?.length === 0, r)
r = await as(S, 'delete from public.downtime_events where id = $1 returning id', [out1])
ok('super admin deletes downtime between jobs', r.rows?.length === 1, r)
r = await as(O, 'insert into public.downtime_events (kind, machine_id) values ($1, $2)', ['BDT', m.K729])
ok('direct insert blocked', /permission denied/.test(r.error || ''), r)

// Plan edits once entries exist
r = await saveJob(P, job1, job({ order_no: 'PO-1X' }), [{ print_side: 'F/S', colours: ['C'] }, { print_side: 'B/S', colours: ['K'] }],
  (await db.query('select updated_at from public.production_jobs where id = $1', [job1])).rows[0].updated_at)
ok('order number in use cannot change', fields(r).includes('order_no'), r)
r = await saveJob(P, job1, job(), [{ print_side: 'F/S', colours: ['C'] }],
  (await db.query('select updated_at from public.production_jobs where id = $1', [job1])).rows[0].updated_at)
ok('side with entries cannot be removed', /B\/S already has production entries/.test(msgs(r)), r)
r = await saveJob(P, job1, job(), [{ print_side: 'F/S', colours: ['C'] }], '2020-01-01T00:00:00Z')
ok('stale job edit refused', r.code === 'STALE', r)
r = await saveJob(P, job1, job({ job_name: 'Carton v2' }), [{ print_side: 'F/S', colours: ['C', 'M', 'New'] }, { print_side: 'B/S', colours: ['K', 'PMS 286'] }],
  (await db.query('select updated_at from public.production_jobs where id = $1', [job1])).rows[0].updated_at)
ok('job edit with new colours saved', r.ok, r)
ok('entry snapshot unchanged by plan edit', (await row(e1)).planned_colours.length === 19)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
