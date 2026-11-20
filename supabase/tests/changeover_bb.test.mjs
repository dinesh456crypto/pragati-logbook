// Changeover is required on every side (B/B F and B/B B too) unless the job is continuing.
// Embedded Postgres (PGlite). Usage: node changeover_bb.test.mjs <migrations up to 20261127100000>
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
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal', null);
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, name, sort_order) values ('K729','Komori 729',1),('K629','Komori 629',2);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
const m = Object.fromEntries((await db.query('select code, id from public.machines')).rows.map((x) => [x.code, x.id]))
const paper = (await one("insert into public.paper_types (name) values ('CFBB') returning id")).id
const uv = (await one("insert into public.coatings (name) values ('UV') returning id")).id
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
const save = async (id, e, submit, expected = null, down = []) => {
  const res = await as(S, "select public.save_production_entry($1::uuid, gen_random_uuid(), $3, $2::jsonb, '[]'::jsonb, $4::timestamptz, false, $5::jsonb) r",
    [id, JSON.stringify(e), submit, expected, JSON.stringify(down)])
  return res.error ? res : res.rows[0].r
}
const uuid = async () => (await one('select gen_random_uuid() id')).id
const bb = (side, h, extra = {}) => ({ ...entry('PO-BB', m.K729, h), print_side: side, ...extra })
const none = { make_ready_start: null, make_ready_end: null, registration_start: null, registration_end: null, colour_matching_start: null, colour_matching_end: null }
const fields = (r) => (r.errors ?? []).map((e) => e.field)
let r = await save(await uuid(), bb('B/B F', '08', none), true)
ok('B/B F without changeover refused', !r.ok && fields(r).includes('make_ready'), r)
r = await save(await uuid(), bb('B/B F', '08'), true)
ok('B/B F with changeover saved', r.ok, r)
r = await save(await uuid(), bb('B/B B', '09', none), true)
ok('B/B B without changeover now refused', !r.ok && ['make_ready', 'registration', 'colour_matching'].every((f) => fields(r).includes(f)), r)
r = await save(await uuid(), bb('B/B B', '09'), true)
ok('B/B B with changeover saved', r.ok, r)
r = await save(await uuid(), bb('B/B F', '10', none), true)
ok('second B/B F (not continuing) also needs changeover', !r.ok && fields(r).includes('make_ready'), r)
r = await save(await uuid(), bb('B/B B', '10', { ...none, continuing: true }), true)
ok('continuing B/B B saved without changeover', r.ok, r)
r = await save(await uuid(), { ...entry('PO-7', m.K629, '08'), ...none }, true)
ok('O/S without changeover still refused', !r.ok && fields(r).includes('make_ready'), r)
await save(await uuid(), entry('PO-7', m.K629, '09'), true)
r = await save(await uuid(), { ...entry('PO-7', m.K629, '10'), ...none, continuing: true }, true)
ok('continuing O/S still optional', r.ok, r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
