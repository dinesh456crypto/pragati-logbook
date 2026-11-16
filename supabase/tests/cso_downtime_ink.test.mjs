// CSO Number + coating per job, automatic colour / coating changes, one Downtime with
// reason groups, ink formulas reused by colour + paper + category, wastage in Pcs.
// Embedded Postgres (PGlite). Usage: node cso_downtime_ink.test.mjs <all migrations in order>
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
const B = '00000000-0000-0000-0000-00000000000b' // had BDT view/create only
const N = '00000000-0000-0000-0000-00000000000c' // no downtime rights
const last = migrations.pop()
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal', null),('${B}','b@pragati.internal', null),('${N}','n@pragati.internal', null);
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1),('K629',2);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
// Before the change: a user with BDT rights, a BDT reason used by a record between jobs.
await as(S, "select public.admin_save_user($1,'bdtuser','BDT User','operator',true,true,'{}',$2::jsonb)", [B, JSON.stringify([
  { resource: 'bdt', view: true, create: true }, { resource: 'production_entry', view: true, create: true }])])
await as(S, "select public.admin_save_user($1,'nouser','No Rights','operator',true,true,'{}',$2::jsonb)", [N, JSON.stringify([{ resource: 'production_entry', view: true }])])
const m1 = (await db.query("select id from public.machines where code = 'K729'")).rows[0].id
const m2 = (await db.query("select id from public.machines where code = 'K629'")).rows[0].id
const oldReason = (await db.query("insert into public.bdt_reasons (name) values ('Motor fault') returning id")).rows[0].id
await db.query("insert into public.downtime_events (kind, machine_id, start_at, end_at, bdt_reason_id, production_date, shift) values ('BDT', $1, '2026-11-01T05:00:00Z', '2026-11-01T05:30:00Z', $2, '2026-11-01', 'A')", [m1, oldReason])
await db.exec(last)
console.log('All migrations applied.')

const one = async (sql, p) => (await db.query(sql, p)).rows[0]
let r

// ---- Downtime migration ----------------------------------------------------------------
r = await db.query('select category, count(*)::int n from public.downtime_reasons group by 1 order by 1')
ok('four reason groups with 4 starting reasons each (+ the migrated BDT reason)', r.rows.map((x) => `${x.category}:${x.n}`).sort().join() === 'Machine:5,Man:4,Material:4,Others:4', r.rows)
r = await one("select d.kind, r.name from public.downtime_events d join public.downtime_reasons r on r.id = d.reason_id")
ok('old BDT record became Machine with its reason', r.kind === 'Machine' && r.name === 'Motor fault', r)
r = await db.query("select key from public.permission_resources where key in ('bdt','odt','downtime')")
ok('BDT and ODT permissions replaced by Downtime', r.rows.map((x) => x.key).join() === 'downtime', r.rows)
r = await one("select can_view, can_create, can_edit from public.user_permissions where profile_id = $1 and resource = 'downtime'", [B])
ok('BDT user keeps view + create as Downtime rights', r.can_view && r.can_create && !r.can_edit, r)
r = await db.query("select to_regclass('public.bdt_reasons') b, to_regclass('public.odt_reasons') o")
ok('old BDT / ODT reason lists removed', r.rows[0].b === null && r.rows[0].o === null)

// ---- Jobs: CSO + coating ------------------------------------------------------------------
const paper = (await one("insert into public.paper_types (name) values ('CFBB') returning id")).id
const paper2 = (await one("insert into public.paper_types (name) values ('SBS') returning id")).id
const uv = (await one("insert into public.coatings (name) values ('UV') returning id")).id
const aq = (await one("insert into public.coatings (name) values ('Aqueous') returning id")).id
const job = (over, sides = [{ print_side: 'O/S', colours: ['C', 'M', 'PMS 185'] }]) => as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify({
  plan_date: '2026-11-10', job_name: 'Box', category: 'Carton', ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 1000, ...over }), JSON.stringify(sides)])
r = await job({ order_no: 'PO-1' })
ok('job without CSO and coating refused, both named', r.rows[0].r.errors.some((e) => e.field === 'cso_no') && r.rows[0].r.errors.some((e) => e.field === 'coating_id'), r.rows[0].r)
r = await job({ order_no: 'PO-1', cso_no: 'CSO-100', coating_id: uv })
ok('job saved with CSO and coating', r.rows[0].r.ok, r.rows[0].r)
r = await job({ order_no: 'PO-2', cso_no: 'CSO-100', coating_id: uv, category: ' carton ' }, [{ print_side: 'O/S', colours: ['c', 'pms185', 'Y'] }])
ok('same CSO on a second job is fine', r.rows[0].r.ok, r.rows[0].r)
r = await job({ order_no: 'po-1', cso_no: 'CSO-200', coating_id: uv })
ok('Production Order Number stays unique', /Production Order Number PO-1 already exists|Production Order Number po-1 already exists/i.test(JSON.stringify(r.rows[0].r)), r.rows[0].r)
r = await as(S, 'select public.import_production_jobs($1::jsonb, true) r', [JSON.stringify([
  { row: 2, plan_date: '2026-11-16', order_no: 'PO-50', cso_no: 'CSO-9', job_name: 'J', category: 'Carton', ups: '2', job_type: 'NEW', paper_type: 'cfbb', coating: 'uv', quantity: '100', print_side: 'O/S', colours: 'C', bs_colours: '' },
  { row: 3, plan_date: '2026-11-16', order_no: 'PO-51', cso_no: '', job_name: 'J', category: 'Carton', ups: '2', job_type: 'NEW', paper_type: 'cfbb', coating: 'Gloss', quantity: '100', print_side: 'O/S', colours: 'C', bs_colours: '' }])])
const imp = r.rows[0].r
ok('import: coating by name, CSO required, unknown coating named', imp.ok === false && imp.errors.length === 2
  && imp.errors.some((e) => e.row === 3 && e.field === 'cso_no') && imp.errors.some((e) => e.row === 3 && /Coating "Gloss" is not in the Coating master/.test(e.message)), imp)

// ---- Production entry: CSO + coating from the plan, automatic changes ------------------------
const op = (await one("insert into public.operators (name) values ('Ravi') returning id")).id
const sup = (await one("insert into public.supervisors (name) values ('Kumar') returning id")).id
const qc = (await one("insert into public.qc_executives (name) values ('Asha') returning id")).id
const wr = (await one('select id from public.wastage_reasons limit 1')).id
const today = (await one("select (now() at time zone 'Asia/Kolkata')::date::text d")).d
const D = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86400000).toISOString().slice(0, 10)
const ts = (hm) => `${D}T${hm}:00+05:30`
const plus = (hm, min) => { const [h, m] = hm.split(':').map(Number); const t = h * 60 + m + min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
const reasons = Object.fromEntries((await db.query('select name, id from public.downtime_reasons')).rows.map((x) => [x.name, x.id]))
const entry = (order, units, start, end, over = {}) => ({
  machine_id: m1, production_date: D, shift: 'A', order_no: order, cso_no: 'typed', job_name: 'Box', category: 'Carton', ups: 4, job_type: 'NEW',
  paper_type_id: paper, planned_quantity: 1000, print_side: 'O/S', operator_id: op, supervisor_id: sup, qc_executive_id: qc, helpers: 2,
  unit_colours: [...units, ...Array(7 - units.length).fill(null)], coating_id: aq, colour_changes: 5, coating_changed: false,
  planned_colours: units.filter(Boolean),
  make_ready_start: ts(start), make_ready_end: ts(plus(start, 5)), registration_start: ts(plus(start, 5)), registration_end: ts(plus(start, 10)),
  colour_matching_start: ts(plus(start, 10)), colour_matching_end: ts(plus(start, 15)), run_start: ts(plus(start, 15)), run_end: ts(end),
  machine_speed: 12000, total_sheets: 1000, ok_sheets: 1000, separate_sheets: 0, remarks: '', ...over,
})
const save = async (e, down = [], user = S) => {
  const res = await as(user, "select public.save_production_entry(gen_random_uuid(), gen_random_uuid(), true, $1::jsonb, '[]'::jsonb, null, false, $2::jsonb) r", [JSON.stringify(e), JSON.stringify(down)])
  if (res.error) return res
  const out = res.rows[0].r
  if (out.ok) out.row = await one('select * from public.production_entries where id = $1', [out.id])
  return out
}
r = await save(entry('PO-1', ['C', 'PMS 185'], '08:00', '09:00'))
ok('first entry on the machine saved', r.ok, r)
ok('CSO and coating come from the plan, not the form', r.row?.cso_no === 'CSO-100' && r.row?.coating_id === uv, r.row)
ok('first job on a machine: every used unit counts, coating changed = yes', r.row?.colour_changes === 2 && r.row?.coating_changed === true, r.row)
r = await save(entry('PO-2', ['c', 'pms185', 'Y'], '09:30', '10:30'))
ok('same colours (case and spaces ignored) + new unit: 1 change, same coating = no', r.row?.colour_changes === 1 && r.row?.coating_changed === false, r.row)
r = await save(entry('PO-9', ['M', null, 'Y', 'Gold'], '11:00', '12:00', { cso_no: 'CSO-X', coating_id: aq }))
ok('unplanned order keeps typed CSO and coating', r.ok && r.row.cso_no === 'CSO-X' && r.row.coating_id === aq, r)
ok('units changed: 1 (c→M), 2 (pms185→empty), 4 (empty→Gold); coating changed', r.row?.colour_changes === 3 && r.row?.coating_changed === true, r.row)
r = await save(entry('PO-10', ['M'], '13:00', '14:00', { cso_no: '' }))
ok('unplanned order without CSO refused', r.ok === false && r.errors.some((e) => e.field === 'cso_no'), r)
r = await save(entry('PO-10', ['M'], '13:00', '14:00', { cso_no: 'C1', make_ready_start: ts('13:00'), make_ready_end: ts('12:00') }))
ok('messages say Job Changeover', r.ok === false && r.errors.some((e) => /^Job Changeover/.test(e.message)), r)

// ---- Downtime in an entry and between jobs ----------------------------------------------------
r = await save(entry('PO-11', ['M'], '15:00', '17:00', { cso_no: 'C2' }), [
  { reason_id: reasons['Mechanical breakdown'], start_at: ts('15:10'), end_at: ts('15:40') },
  { reason_id: reasons['Waiting for ink'], start_at: ts('16:00'), end_at: ts('16:15') },
  { reason_id: reasons['Shift handover'], start_at: ts('16:20'), end_at: ts('16:25') }])
ok('entry with three downtimes saved', r.ok, r)
ok('minutes per group on the entry', r.row?.machine_minutes === 30 && r.row?.material_minutes === 15 && r.row?.man_minutes === 5 && r.row?.other_minutes === 0 && r.row?.downtime_minutes === 50, r.row)
r = await db.query('select kind from public.downtime_events where entry_id = (select id from public.production_entries where order_no = $1) order by line', ['PO-11'])
ok('each downtime takes its reason group', r.rows.map((x) => x.kind).join() === 'Machine,Material,Man', r.rows)
r = await save(entry('PO-12', ['M'], '18:00', '19:00', { cso_no: 'C3' }), [{ reason_id: null, start_at: ts('18:10'), end_at: ts('18:20') }])
ok('downtime without a reason refused', r.ok === false && r.errors.some((e) => /reason for each downtime/.test(e.message)), r)
const outside = (user, ev) => as(user, 'select public.save_outside_downtime(null,$1::jsonb,null) r', [JSON.stringify(ev)])
r = await outside(B, { machine_id: m2, reason_id: reasons['Power cut'], start_at: ts('10:00'), end_at: ts('10:20') })
ok('downtime between jobs saved with the Downtime right', r.rows?.[0].r.ok, r)
r = await one("select kind from public.downtime_events where machine_id = $1 and start_at = $2", [m2, ts('10:00')])
ok('between-jobs downtime takes the reason group', r.kind === 'Others', r)
r = await outside(N, { machine_id: m2, reason_id: reasons['Power cut'], start_at: ts('11:00'), end_at: ts('11:20') })
ok('no Downtime right: refused', /Not allowed/.test(r.error || ''), r)
r = await outside(B, { machine_id: m2, reason_id: reasons['Cleaning'], start_at: ts('10:10'), end_at: ts('10:30') })
ok('overlap on the same machine refused', /only one downtime at a time/.test(JSON.stringify(r.rows?.[0].r)), r)
r = await as(S, 'select public.dashboard_figures($1::date, $1::date) f', [D])
const tot = r.rows[0].f.totals
ok('dashboard: downtime total and per group', tot.downtime === 70 && tot.machine === 30 && tot.material === 15 && tot.man === 5 && tot.others === 20 && tot.bdt === undefined, tot)
r = await as(S, 'select public.machine_timeline($1) t', [m1])
ok('timeline gives the previous job unit colours and coating', r.rows[0].t.previous.unit_colours[0] === 'M' && r.rows[0].t.previous.coating === 'Aqueous', r.rows[0].t.previous)
r = await as(S, "select public.production_order_status('PO-1', $1) s", [m1])
ok('order status gives CSO and coating', r.rows[0].s.job.cso_no === 'CSO-100' && r.rows[0].s.job.coating_id === uv, r.rows[0].s.job)
r = await as(S, 'select order_no, cso_no from public.production_order_options() where order_no = $1', ['PO-2'])
ok('order list gives CSO', r.rows[0]?.cso_no === 'CSO-100', r.rows)

// ---- Ink formulas reused -------------------------------------------------------------------
const jobId = async (o) => (await one('select id from public.production_jobs where order_no = $1', [o])).id
const ink = async (order, colours, id = null, exp = null) => {
  const res = await as(S, 'select public.save_ink_formula($1,$2,$3::jsonb,null,$4) r', [id, order, JSON.stringify(colours), exp])
  return res.error ? res : res.rows[0].r
}
r = await as(S, 'select order_no from public.ink_order_options() order by order_no')
ok('both orders need a formula at first', r.rows.map((x) => x.order_no).join() === 'PO-1,PO-2', r.rows)
r = await ink('PO-1', [{ colour: 'PMS 185', formula: 'Base 80% + Rubine 20%' }])
ok('PO-1 formula saved', r.ok, r)
r = await as(S, 'select public.order_plan_colours($1) c', [await jobId('PO-2')])
const pms = r.rows[0].c.find((x) => x.colour.toLowerCase().replace(/\s/g, '') === 'pms185')
ok('PO-2: pms185 (no space, small letters, category " carton ") is known from PO-1', pms?.known?.order_no === 'PO-1' && /Rubine/.test(pms.known.formula), r.rows[0].c)
r = await as(S, 'select order_no, record_no from public.ink_order_options() order by order_no')
ok('PO-2 needs no formula (C, Y standard, pms185 known): left out of the list; PO-1 listed with its record', r.rows.map((x) => x.order_no).join() === 'PO-1' && r.rows[0].record_no, r.rows)
r = await ink('PO-2', [{ colour: 'pms185', formula: 'other' }])
ok('saving PO-2 is refused: nothing new to enter', r.ok === false && /needs no new ink formula/.test(JSON.stringify(r)), r)
await job({ order_no: 'PO-3', cso_no: 'CSO-3', coating_id: uv, paper_type_id: paper2 }, [{ print_side: 'O/S', colours: ['PMS 185', 'Gold'] }])
await job({ order_no: 'PO-4', cso_no: 'CSO-4', coating_id: uv }, [{ print_side: 'O/S', colours: ['PMS 185', 'Gold'] }])
r = await as(S, 'select order_no from public.ink_order_options() order by order_no')
ok('other paper type (PO-3) and a new colour (PO-4) are listed', r.rows.map((x) => x.order_no).join() === 'PO-1,PO-3,PO-4', r.rows)
r = await ink('PO-4', [{ colour: 'PMS 185', formula: 'changed' }, { colour: 'Gold', formula: 'Gold 100%' }])
ok('PO-4 saved', r.ok, r)
r = await db.query('select colour from public.ink_formula_colours where record_id = $1', [r.id])
ok('PO-4 stores only Gold (PMS 185 already known)', r.rows.map((x) => x.colour).join() === 'Gold', r.rows)
const rec1 = await one("select id, updated_at from public.ink_formula_records where order_no = 'PO-1'")
r = await ink(null, [{ colour: 'PMS 185', formula: 'Base 75% + Rubine 25%' }], rec1.id, rec1.updated_at)
r = await ink(null, [{ colour: 'PMS 185', formula: 'Base 75% + Rubine 25%' }], rec1.id, rec1.updated_at)
ok('the first record still edits its own formula', r.ok || /changed by someone else/.test(JSON.stringify(r)), r)
r = await as(S, 'select public.order_plan_colours($1) c', [await jobId('PO-4')])
ok('PO-4 now sees the updated PO-1 formula', /75%/.test(JSON.stringify(r.rows[0].c)), r.rows[0].c)

// ---- Wastage in Pcs ------------------------------------------------------------------------
r = await db.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'wastage_lines_unit_check'")
ok('wastage units are pcs and sheets', /'pcs'/.test(r.rows[0]?.d) && !/cartons/.test(r.rows[0]?.d), r.rows)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
