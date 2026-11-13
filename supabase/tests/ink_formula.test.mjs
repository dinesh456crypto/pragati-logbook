// Phase 8 database rule tests: ink formulas with revisions. Embedded Postgres (PGlite).
// Usage: node ink_formula.test.mjs <all migrations in order, ending with phase8>
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
const I = '00000000-0000-0000-0000-00000000000b' // ink user: view + create only
const V = '00000000-0000-0000-0000-00000000000c' // production entry only, no ink rights
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal'),('${I}','inku@pragati.internal'),('${V}','ravi@pragati.internal');
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
console.log('All migrations applied.')
await as(S, "select public.admin_save_user($1,'inku','Ink Person','office_user',true,true,'{}',$2::jsonb)", [I, JSON.stringify([{ resource: 'ink_formula', view: true, create: true }])])
await as(S, "select public.admin_save_user($1,'ravi','Ravi','operator',true,true,'{}',$2::jsonb)", [V, JSON.stringify([{ resource: 'production_entry', view: true, create: true }])])

const paper = (await db.query("insert into public.paper_types (name) values ('Art Card') returning id")).rows[0].id
const job = (order, sides) => as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify({ plan_date: '2026-11-10', order_no: order,
  job_name: 'Carton ' + order, category: 'Carton', ups: 2, job_type: 'NEW', paper_type_id: paper, quantity: 1000 }), JSON.stringify(sides)])
await job('PO-1', [{ print_side: 'F/S', colours: ['C', 'M', 'PMS 185'] }, { print_side: 'B/S', colours: ['K', 'pms 185'] }])
await job('PO-2', [{ print_side: 'B/B F', colours: ['C', 'Gold'] }])

let r = await as(I, "select public.order_plan_colours(id) c from public.production_jobs where order_no = 'PO-1'")
const plan = r.rows?.[0].c
ok('plan colours: all sides together, shared colour once', plan?.length === 4 && plan.find((x) => x.colour.toLowerCase() === 'pms 185').sides.join() === 'B/S,F/S', plan)
r = await as(I, "select public.order_plan_colours(id) c from public.production_jobs where order_no = 'PO-2'")
ok('B/B pair shown as one side "B/B"', r.rows?.[0].c.every((x) => x.sides.join() === 'B/B'), r.rows?.[0].c)

const save = async (user, id, order, colours, note = null, expected = null) => {
  const res = await as(user, 'select public.save_ink_formula($1,$2,$3::jsonb,$4,$5) r', [id, order, JSON.stringify(colours), note, expected])
  return res.error ? res : res.rows[0].r
}
r = await save(V, null, 'PO-1', [{ colour: 'C', formula: 'x' }])
ok('user without ink rights cannot save', r.code === '42501', r)
r = await save(I, null, 'PO-9', [{ colour: 'C', formula: 'x' }])
ok('unknown order refused', r.code === 'INVALID', r)
r = await save(I, null, 'PO-1', [{ colour: 'C', formula: '' }, { colour: 'M', formula: ' ' }])
ok('at least one formula needed', /at least one colour/.test(JSON.stringify(r)), r)
r = await save(I, null, 'PO-1', [{ colour: 'C', formula: 'Cyan 70% + Trans White 30%' }, { colour: 'Gold', formula: 'x' }])
ok('colour from another order refused', /Gold is not one of this order/.test(JSON.stringify(r)), r)
const long = 'x'.repeat(4001)
r = await save(I, null, 'PO-1', [{ colour: 'C', formula: long }])
ok('formula longer than 4000 refused', /4000/.test(JSON.stringify(r)), r)
r = await save(I, null, 'po-1 ', [{ colour: 'C', formula: 'Cyan 70% + Trans White 30%' }, { colour: 'M', formula: 'Rubine 50%\nWarm Red 20%\nTrans White 30%' }, { colour: 'PMS 185', formula: '' }, { colour: 'K', formula: '' }])
ok('ink user creates a formula record', r.ok && r.revision === 1, r)
const rec = r.id
let row = (await db.query('select * from public.ink_formula_records where id = $1', [rec])).rows[0]
ok('job snapshot and creator name kept', row.order_no === 'PO-1' && row.job_name === 'Carton PO-1' && row.plan_date && row.created_by_name === 'Ink Person' && row.record_no === 1, row)
r = await db.query('select colour, sides, formula from public.ink_formula_colours where record_id = $1 order by line', [rec])
ok('colours stored in plan order with sides, multi-line formula kept', r.rows.length === 4 && r.rows[1].formula.includes('\n') && r.rows[2].sides.join() === 'B/S,F/S', r.rows)
r = await save(I, null, 'PO-1', [{ colour: 'C', formula: 'again' }])
ok('second record for the same order refused (EXISTS)', r.code === 'EXISTS' && r.id === rec, r)
r = await save(I, rec, null, [{ colour: 'C', formula: 'changed' }], null, row.updated_at)
ok('ink user without edit right cannot change', r.code === '42501', r)
r = await save(S, rec, null, [{ colour: 'C', formula: 'Cyan 65% + Trans White 35%' }, { colour: 'M', formula: 'Rubine 50%\nWarm Red 20%\nTrans White 30%' }], 'Shade too dark', '2020-01-01T00:00:00Z')
ok('out-of-date edit refused', r.code === 'STALE', r)
r = await save(S, rec, null, [{ colour: 'C', formula: 'Cyan 65% + Trans White 35%' }, { colour: 'M', formula: 'Rubine 50%\nWarm Red 20%\nTrans White 30%' }, { colour: 'PMS 185', formula: '' }, { colour: 'K', formula: '' }], 'Shade too dark', row.updated_at)
ok('edit saved as revision 2', r.ok && r.revision === 2, r)
row = (await db.query('select * from public.ink_formula_records where id = $1', [rec])).rows[0]
r = await save(S, rec, null, [{ colour: 'C', formula: 'Cyan 65% + Trans White 35%' }, { colour: 'M', formula: 'Rubine 50%\nWarm Red 20%\nTrans White 30%' }, { colour: 'PMS 185', formula: '' }, { colour: 'K', formula: '' }], null, row.updated_at)
ok('saving without changes keeps revision 2', r.ok && r.unchanged && r.revision === 2, r)
r = await db.query('select revision, note, changed_by_name, colours from public.ink_formula_revisions where record_id = $1 order by revision', [rec])
ok('history: revision 1 kept, revision 2 with note', r.rows.length === 2 && r.rows[0].colours[0].formula === 'Cyan 70% + Trans White 30%'
  && r.rows[1].note === 'Shade too dark' && r.rows[1].changed_by_name === 'Dinesh Kumar P', r.rows)

// Plan changes later
const jobRow = (await db.query("select id, updated_at from public.production_jobs where order_no = 'PO-1'")).rows[0]
await as(S, 'select public.save_production_job($1,$2::jsonb,$3::jsonb,$4) r', [jobRow.id, JSON.stringify({ plan_date: '2026-11-10', order_no: 'PO-1',
  job_name: 'Carton PO-1 v2', category: 'Carton', ups: 2, job_type: 'NEW', paper_type_id: paper, quantity: 1000 }),
  JSON.stringify([{ print_side: 'F/S', colours: ['C', 'Y'] }, { print_side: 'B/S', colours: ['K'] }]), jobRow.updated_at])
r = await db.query('select colour, formula from public.ink_formula_colours where record_id = $1 order by line', [rec])
ok('plan change does not touch saved formulas', r.rows.length === 4 && r.rows.some((x) => x.colour === 'M'), r.rows)
row = (await db.query('select * from public.ink_formula_records where id = $1', [rec])).rows[0]
r = await save(S, rec, null, [{ colour: 'C', formula: 'Cyan 65% + Trans White 35%' }, { colour: 'M', formula: 'old colour kept' }, { colour: 'Y', formula: 'Yellow 100%' }], 'New colour Y', row.updated_at)
ok('edit can use new plan colours and keep old record colours', r.ok && r.revision === 3, r)
row = (await db.query('select * from public.ink_formula_records where id = $1', [rec])).rows[0]
ok('job name snapshot refreshed on edit', row.job_name === 'Carton PO-1 v2', row)
r = await as(S, 'delete from public.production_jobs where id = $1', [jobRow.id])
ok('a job with formulas cannot be deleted', /foreign key/.test(r.error || ''), r)

// Access, archive
r = await as(V, 'select count(*)::int n from public.ink_formula_records')
ok('users without ink rights see no formulas', r.rows?.[0].n === 0, r)
r = await as(I, 'insert into public.ink_formula_records (order_no) values ($1)', ['X'])
ok('direct insert blocked', /permission denied/.test(r.error || ''), r)
r = await as(I, 'select public.archive_ink_formula($1, true) r', [rec])
ok('archive needs the delete right', r.code === '42501', r)
r = (await as(S, 'select public.archive_ink_formula($1, true) r', [rec])).rows[0].r
ok('super admin archives the record', r.ok, r)
r = await save(I, null, 'PO-1', [{ colour: 'C', formula: 'new start' }])
ok('a new record can start after archiving', r.ok && r.revision === 1, r)
r = (await as(S, 'select public.archive_ink_formula($1, false) r', [rec])).rows[0].r
ok('restoring is refused while another live record exists', r.ok === false, r)
r = await save(S, rec, null, [{ colour: 'C', formula: 'x' }], null, (await db.query('select updated_at from public.ink_formula_records where id = $1', [rec])).rows[0].updated_at)
ok('archived record cannot be edited', /archived/.test(JSON.stringify(r)), r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
