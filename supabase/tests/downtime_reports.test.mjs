// Phase 5 database rule tests: no overlapping downtime per machine, overnight
// window, report figures. Embedded Postgres (PGlite) with btree_gist.
// Usage: node downtime_reports.test.mjs <foundation> <phase1> <phase3> <phase4> <phase4b> <phase4c> <phase5>
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { readFileSync } from 'node:fs'
import { randomUUID as uid } from 'node:crypto'

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
const O = '00000000-0000-0000-0000-00000000000b' // operator on K729: entry + BDT + ODT create, dashboard view
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${O}','ravi@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1),('K629',2),('KBA105',3);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
console.log('All migrations applied.')

const m = Object.fromEntries((await db.query('select code, id from public.machines')).rows.map((x) => [x.code, x.id]))
await as(S, 'select public.admin_save_user($1,$2,$3,$4,true,false,$5,$6::jsonb)', [O, 'ravi', 'Ravi', 'operator', [m.K729], JSON.stringify([
  { resource: 'production_entry', view: true, create: true }, { resource: 'bdt', view: true, create: true },
  { resource: 'odt', view: true, create: true }, { resource: 'dashboard', view: true }])])

const one = async (sql) => (await db.query(sql)).rows[0].id
const paper = await one("insert into public.paper_types (name) values ('Art Card') returning id")
const op = await one("insert into public.operators (name) values ('Ravi') returning id")
const sup = await one("insert into public.supervisors (name) values ('Kumar') returning id")
const qc = await one("insert into public.qc_executives (name) values ('Asha') returning id")
const coat = await one("insert into public.coatings (name) values ('UV') returning id")
const bdtR = await one("insert into public.bdt_reasons (name) values ('Motor') returning id")
const odtR = await one("select id from public.odt_reasons where name = 'Meeting'")
await as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb)', [JSON.stringify({ plan_date: '2026-11-01', order_no: 'PO-1', job_name: 'Box', ups: 2,
  job_type: 'NEW', paper_type_id: paper, quantity: 1000 }), JSON.stringify([{ print_side: 'O/S', colours: ['C', 'M'] }])])
await as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb)', [JSON.stringify({ plan_date: '2026-11-01', order_no: 'PO-2', job_name: 'Lid', ups: 2,
  job_type: 'NEW', paper_type_id: paper, quantity: 1000 }), JSON.stringify([{ print_side: 'O/S', colours: ['K'] }])])

const today = (await db.query("select (now() at time zone 'Asia/Kolkata')::date::text d")).rows[0].d
const day = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const D = day(-3), N = day(-2) // production day and the next calendar day
const ts = (hm, d = D) => `${d}T${hm}:00+05:30`
const entry = (over = {}) => ({
  machine_id: m.K729, production_date: D, shift: 'B', order_no: 'PO-1', job_name: 'Box', category: 'Carton', ups: 2, job_type: 'NEW',
  paper_type_id: paper, planned_quantity: 1000, print_side: 'O/S', operator_id: op, supervisor_id: sup, qc_executive_id: qc, helpers: 2,
  unit_colours: ['C', 'M', null, null, null, null, null], coating_id: coat, colour_changes: 2, coating_changed: false,
  make_ready_start: ts('17:00'), make_ready_end: ts('18:00'), registration_start: ts('18:00'), registration_end: ts('18:30'),
  colour_matching_start: ts('18:30'), colour_matching_end: ts('19:00'), run_start: ts('19:00'), run_end: ts('23:00'),
  machine_speed: 12000, total_sheets: 1000, ok_sheets: 950, separate_sheets: 0, ...over,
})
const W = [{ quantity: 50, reason_id: (await db.query("select id from public.wastage_reasons limit 1")).rows[0].id }]
const dt = (kind, s, e, d = D) => ({ kind, start_at: ts(s, d), end_at: ts(e, d), reason_id: kind === 'BDT' ? bdtR : odtR })
async function save(user, id, e, downtime, expected = null) {
  const r = await as(user, 'select public.save_production_entry($1,$2,true,$3::jsonb,$4::jsonb,$5,false,$6::jsonb) r',
    [id, uid(), JSON.stringify(e), JSON.stringify(W), expected, JSON.stringify(downtime)])
  return r.error ? r : r.rows[0].r
}
const outside = async (user, ev, id = null, expected = null) => {
  const r = await as(user, 'select public.save_outside_downtime($1,$2::jsonb,$3) r', [id, JSON.stringify(ev), expected])
  return r.error ? r : r.rows[0].r
}
const msgs = (r) => JSON.stringify(r.errors || r)

// ---- One downtime at a time per machine -------------------------------------------
let r = await save(O, uid(), entry(), [dt('BDT', '17:15', '17:30'), dt('ODT', '17:20', '17:40')])
ok('two overlapping rows in one job refused', /only one BDT or ODT/.test(msgs(r)), r)
r = await save(O, uid(), entry(), [dt('BDT', '17:15', '17:30'), dt('ODT', '17:15', '17:30')])
ok('same date and time twice refused', /only one BDT or ODT/.test(msgs(r)), r)
const e1 = uid()
r = await save(O, e1, entry(), [dt('BDT', '17:15', '17:30'), dt('ODT', '17:30', '17:45'), dt('BDT', '20:00', '20:30')])
ok('back-to-back rows (one ends as the next starts) allowed', r.ok, r)
let row = (await db.query('select * from public.production_entries where id = $1', [e1])).rows[0]
ok('entry BDT / ODT minutes stored', row.bdt_minutes === 45 && row.odt_minutes === 15, row)
r = await save(S, e1, entry(), [dt('BDT', '17:15', '17:30'), dt('ODT', '17:30', '17:45'), dt('BDT', '20:00', '20:40')], row.updated_at)
ok('editing the same entry does not clash with its own downtime', r.ok, r)

r = await outside(O, { ...dt('ODT', '23:00', '23:30'), machine_id: m.K729 })
ok('downtime between jobs saved', r.ok, r)
r = await outside(O, { ...dt('BDT', '23:15', '23:45'), machine_id: m.K729 })
ok('overlapping downtime between jobs refused', /only one BDT or ODT/.test(msgs(r)) && /recorded between jobs/.test(msgs(r)), r)
r = await outside(O, { ...dt('BDT', '23:15', '23:45'), machine_id: m.K629 })
ok('same time on another machine is fine', r.code === '42501' || r.ok, r) // operator has no K629 access
r = await outside(S, { ...dt('BDT', '23:15', '23:45'), machine_id: m.K629 })
ok('same time on another machine allowed (admin)', r.ok, r)
r = await outside(O, { ...dt('BDT', '20:10', '20:20'), machine_id: m.K729 })
ok('between-jobs record over a job downtime refused', /only one BDT or ODT/.test(msgs(r)) && /PE-00/.test(msgs(r)), r)
r = await db.query("select count(*)::int n from public.downtime_events where machine_id = $1", [m.K729])
const before = r.rows[0].n
r = await db.query(`insert into public.downtime_events (kind, machine_id, start_at, end_at, odt_reason_id) values ('ODT', $1, $2, $3, $4)`,
  [m.K729, ts('23:10'), ts('23:20'), odtR]).catch((e) => ({ error: e.message, code: e.code }))
ok('database constraint blocks overlaps even outside the app', r.code === '23P01', r)
r = await outside(O, { kind: 'BDT', machine_id: m.K729, start_at: ts('02:00', N), reason_id: bdtR })
ok('open breakdown (no end) saved', r.ok, r)
const open1 = r.id
r = await outside(O, { ...dt('ODT', '04:00', '04:30', N), machine_id: m.K729 })
ok('nothing can start while a breakdown is still open', /still open/.test(msgs(r)), r)
let t = (await db.query('select updated_at from public.downtime_events where id = $1', [open1])).rows[0].updated_at
r = await outside(S, { kind: 'BDT', machine_id: m.K729, start_at: ts('02:00', N), end_at: ts('03:00', N), reason_id: bdtR }, open1, t)
ok('closing the breakdown saved', r.ok, r)

// ---- Overnight window ------------------------------------------------------------
const counted = async (user, from, to, machine = null) =>
  (await as(user, 'select kind, start_at, counted_minutes, minutes from public.downtime_counted($1,$2,$3) order by start_at', [from, to, machine])).rows
let rows = await counted(S, D, D, m.K729)
const find = (rs, hm, d = D) => rs.find((x) => new Date(x.start_at).getTime() === Date.parse(ts(hm, d)))
ok('job downtime counted in full', find(rows, '20:00').counted_minutes === 40)
ok('downtime after the last job end (23:00) is not counted', find(rows, '23:00').counted_minutes === 0, rows)
ok('2 AM breakdown (B shift, previous day) not counted', find(rows, '02:00', N).counted_minutes === 0, rows)
let nw = (await as(S, 'select source, starts_at from public.night_windows($1,$1) where machine_id = $2', [D, m.K729])).rows[0]
ok('B-shift end = last job end', nw.source === 'last job end' && new Date(nw.starts_at).getTime() === Date.parse(ts('23:00')), nw)
nw = (await as(S, 'select source, starts_at from public.night_windows($1,$1) where machine_id = $2', [D, m.KBA105])).rows[0]
ok('no job that day: default 1:00 AM', nw.source === 'default 1:00 AM' && new Date(nw.starts_at).getTime() === Date.parse(ts('01:00', N)), nw)

r = await as(O, 'select public.set_shift_end($1,$2,$3,$4) r', [m.K729, D, ts('02:30', N), 'Night overtime'])
ok('operator cannot set the B-shift end', r.code === '42501', r)
r = (await as(S, 'select public.set_shift_end($1,$2,$3,$4) r', [m.K729, D, ts('09:00', N), 'x x x'])).rows[0].r
ok('B-shift end after 8 AM refused', r.ok === false, r)
r = (await as(S, 'select public.set_shift_end($1,$2,$3,$4) r', [m.K729, D, ts('02:30', N), 'Night overtime'])).rows[0].r
ok('admin sets B-shift end 2:30 AM', r.ok, r)
rows = await counted(S, D, D, m.K729)
ok('with the override: 23:00-23:30 ODT counted, 2-3 AM BDT counts 30 min', find(rows, '23:00').counted_minutes === 30 && find(rows, '02:00', N).counted_minutes === 30, rows)

// ---- Dashboard figures -----------------------------------------------------------
let f = (await as(S, 'select public.dashboard_figures($1,$2,null) f', [D, D])).rows[0].f
ok('totals: 1 entry, 1 job, sheets', f.totals.entries === 1 && f.totals.jobs_ran === 1 && f.totals.given === 1000 && f.totals.ok === 950 && f.totals.wastage === 50, f.totals)
ok('totals: gross / net changeover and production', f.totals.changeover_gross === 120 && f.totals.changeover_net === 90 && f.totals.run_gross === 240 && f.totals.run_net === 200, f.totals)
// BDT: job 15 + 40, between jobs K729 2-3 AM: 30 counted, K629 23:15-23:45 not counted (default window 1 AM? no: 23:15 < 01:00 so counted 30)
ok('totals: BDT and ODT counted minutes', f.totals.bdt === 15 + 40 + 30 + 30 && f.totals.odt === 15 + 30, f.totals)
ok('machine table has every machine', f.machines.length === 3 && f.machines[0].code === 'K729' && f.machines[0].entries === 1, f.machines)
f = (await as(O, 'select public.dashboard_figures($1,$2,null) f', [D, D])).rows[0].f
ok('operator sees only K729 figures', f.machines.length === 1 && f.totals.bdt === 15 + 40 + 30, f)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
