// Phase 4c: B/B F and B/B B share one colour slot in the Production Plan.
// Usage: node plan_bb.test.mjs <foundation> <phase1> <phase3> <phase4> <phase4b> <phase4c>
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
// A B/B job planned with only one B/B side before this phase.
await db.exec(migrations[4])
await db.exec(`insert into public.production_jobs (plan_date, order_no, job_name, ups, job_type, paper_type_id, quantity)
  select current_date, 'BB-OLD', 'Old B/B', 1, 'NEW', id, 100 from public.paper_types limit 1;
  insert into public.production_job_sides (job_id, print_side, colours)
  select id, 'B/B F', '{C,M}' from public.production_jobs where order_no = 'BB-OLD'`)
await db.exec(migrations[5])
console.log('All migrations applied.')
const sidesOf = async (order) => (await db.query(`select s.print_side, s.colours from public.production_job_sides s
  join public.production_jobs j on j.id = s.job_id where j.order_no = $1 order by s.print_side`, [order])).rows
let rows = await sidesOf('BB-OLD')
ok('existing B/B F slot got its B/B B partner', rows.length === 2 && rows[1].print_side === 'B/B F' && rows[0].print_side === 'B/B B' && rows[0].colours.join() === 'C,M', rows)

const paper = (await db.query('select id from public.paper_types limit 1')).rows[0].id
const job = (order) => ({ plan_date: '2026-11-10', order_no: order, job_name: 'B/B carton', ups: 2, job_type: 'NEW', paper_type_id: paper, quantity: 1000 })
const saveJob = async (j, sides, id = null, expected = null) =>
  (await as(S, 'select public.save_production_job($1,$2::jsonb,$3::jsonb,$4) r', [id, JSON.stringify(j), JSON.stringify(sides), expected])).rows?.[0]?.r
let r = await saveJob(job('BB-1'), [{ print_side: 'B/B B', colours: ['C', 'M', 'Gold'] }])
ok('planning B/B B alone saves', r?.ok, r)
rows = await sidesOf('BB-1')
ok('B/B F added automatically with the same colours', rows.length === 2 && rows.every((x) => x.colours.join() === 'C,M,Gold'), rows)
r = await saveJob(job('BB-2'), [{ print_side: 'B/B F', colours: ['C'] }, { print_side: 'B/B B', colours: ['K'] }])
rows = await sidesOf('BB-2')
ok('two B/B slots: the first one decides both', r?.ok && rows.every((x) => x.colours.join() === 'C'), rows)
const upd = (await db.query("select id, updated_at from public.production_jobs where order_no = 'BB-1'")).rows[0]
r = await saveJob(job('BB-1'), [{ print_side: 'B/B F', colours: ['C', 'M', 'Silver'] }], upd.id, upd.updated_at)
rows = await sidesOf('BB-1')
ok('editing B/B colours updates both sides', r?.ok && rows.length === 2 && rows.every((x) => x.colours.join() === 'C,M,Silver'), rows)
r = await saveJob(job('BB-3'), [{ print_side: 'B/B F', colours: ['C'] }, { print_side: 'F/S', colours: ['K'] }])
ok('B/B still cannot mix with F/S', r?.ok === false && /cannot be mixed/.test(JSON.stringify(r)), r)
r = await saveJob({ ...job('BB-1'), ups: 0, job_name: '' }, [{ print_side: '', colours: [] }])
ok('all problems reported together', r?.ok === false && r.errors.length >= 4, r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
