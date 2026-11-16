// Job Details: Category required, and the all-or-nothing bulk import. Embedded Postgres (PGlite).
// Usage: node job_import.test.mjs <all migrations in order>
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
const V = '00000000-0000-0000-0000-00000000000b' // production plan view only
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal', null),('${V}','v@pragati.internal', null);
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, sort_order) values ('K729',1);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
console.log('All migrations applied.')
await as(S, "select public.admin_save_user($1,'viewer','Viewer','office_user',true,true,'{}',$2::jsonb)", [V, JSON.stringify([{ resource: 'production_plan', view: true }])])
const paper = (await db.query("insert into public.paper_types (name) values ('CFBB') returning id")).rows[0].id
await db.query("insert into public.paper_types (name, active) values ('Old Board', false)")
const coat = (await db.query("insert into public.coatings (name) values ('UV') returning id")).rows[0].id

// ---- Category required in the form ----------------------------------------------
const job = (over = {}) => ({ plan_date: '2026-11-16', order_no: 'PO-1', job_name: 'Box', category: 'Carton', ups: 4, job_type: 'NEW', paper_type_id: paper, quantity: 1000, cso_no: 'CSO-1', coating_id: coat, ...over })
let r = await as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify(job({ category: '  ' })), JSON.stringify([{ print_side: 'O/S', colours: ['C'] }])])
ok('form: category required', r.rows?.[0]?.r?.errors?.some((e) => e.field === 'category' && /required/.test(e.message)), r)
r = await as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify(job()), JSON.stringify([{ print_side: 'O/S', colours: ['C'] }])])
ok('form: job with category saved', r.rows?.[0]?.r?.ok, r)

// ---- Bulk import -------------------------------------------------------------------
const row = (n, over = {}) => ({ row: n, plan_date: '2026-11-16', order_no: `PO-${100 + n}`, job_name: `Job ${n}`, category: 'Carton', ups: '6', job_type: 'NEW',
  paper_type: 'cfbb', cso_no: 'CSO-7', coating: 'uv', quantity: '12000', print_side: 'O/S', colours: 'C, M, Y, K', bs_colours: '', ...over })
const imp = async (user, rows) => {
  const res = await as(user, 'select public.import_production_jobs($1::jsonb) r', [JSON.stringify(rows)])
  return res.error ? res : res.rows[0].r
}
const count = async () => (await db.query('select count(*)::int n from public.production_jobs')).rows[0].n

r = await imp(V, [row(2)])
ok('import needs Production Plan create', /permission to create jobs/.test(r.error || ''), r)

const bad = [
  row(2),
  row(3, { order_no: 'po-1' }),                            // already planned
  row(4, { order_no: 'PO-DUP' }), row(5, { order_no: 'po-dup ' }), // repeated in file
  row(6, { plan_date: '2026-02-30' }),                      // invalid date
  row(7, { ups: '2.5', quantity: 'abc' }),
  row(8, { category: '', job_name: '' }),
  row(9, { paper_type: 'Art 300' }),
  row(10, { paper_type: 'Old Board' }),
  row(11, { print_side: 'Front' }),
  row(12, { print_side: 'F/S + B/S', bs_colours: '' }),
  row(13, { print_side: 'O/S', bs_colours: 'K' }),
  row(14, { colours: 'C, c, M' }),
  row(15, { job_type: 'Repeat', colours: '' }),
  row(16, { ups: '0' }),
]
const before = await count()
r = await imp(S, bad)
ok('invalid file: not ok', r.ok === false && r.code === 'INVALID', r)
ok('nothing imported (row 2 was valid)', (await count()) === before)
const by = (n) => (r.errors ?? []).filter((e) => e.row === n)
ok('row 2 has no errors', by(2).length === 0, by(2))
ok('row 3: already planned', by(3).some((e) => /already exists/.test(e.message)), by(3))
ok('rows 4+5: repeated in file, no "already exists"', by(4).some((e) => /more than once in the file/.test(e.message)) && by(5).length === 1, [by(4), by(5)])
ok('row 6: invalid date', by(6).length === 1 && /not a valid date/.test(by(6)[0].message), by(6))
ok('row 7: UPS and quantity', by(7).some((e) => e.field === 'ups') && by(7).some((e) => e.field === 'quantity') && by(7).length === 2, by(7))
ok('row 8: job name and category', by(8).some((e) => e.field === 'job_name') && by(8).some((e) => e.field === 'category'), by(8))
ok('row 9: paper not in master', by(9).length === 1 && /not in the Paper Type master/.test(by(9)[0].message), by(9))
ok('row 10: paper inactive', by(10).length === 1 && /inactive/.test(by(10)[0].message), by(10))
ok('row 11: bad print side (one message)', by(11).length === 1 && /not allowed/.test(by(11)[0].message), by(11))
ok('row 12: B/S colours required', by(12).length === 1 && by(12)[0].field === 'bs_colours', by(12))
ok('row 13: B/S colours only for F/S + B/S', by(13).length === 1 && /only for Print Side/.test(by(13)[0].message), by(13))
ok('row 14: repeated colour', by(14).some((e) => /each colour once/.test(e.message)), by(14))
ok('row 15: job type and colours', by(15).some((e) => e.field === 'job_type') && by(15).some((e) => e.field === 'colours') && by(15).length === 2, by(15))
ok('row 16: UPS zero', by(16).length === 1 && by(16)[0].field === 'ups', by(16))

const good = [
  row(2, { print_side: 'F/S + B/S', colours: 'C, M, Y, K, PMS 185', bs_colours: 'K, PMS 286', category: ' Carton  Box ' }),
  row(3, { print_side: 'B/B', colours: 'K, Gold' }),
  row(4, { print_side: 'B/S', colours: 'K', job_type: 'Re-Print' }),
]
let dry = await as(S, 'select public.import_production_jobs($1::jsonb, true) r', [JSON.stringify(good)])
ok('dry run: ok, nothing saved', dry.rows?.[0]?.r?.ok === true && dry.rows[0].r.dry_run === true && dry.rows[0].r.count === 3 && (await count()) === before, dry)
dry = await as(S, 'select public.import_production_jobs($1::jsonb, true) r', [JSON.stringify(bad)])
ok('dry run with errors: same errors', dry.rows?.[0]?.r?.ok === false && dry.rows[0].r.errors.length === r.errors.length, dry)
r = await imp(S, good)
ok('valid file imported', r.ok === true && r.count === 3, r)
r = await db.query("select j.order_no, j.category, j.created_by, array_agg(s.print_side || ':' || array_to_string(s.colours, '|') order by s.line) sides from public.production_jobs j join public.production_job_sides s on s.job_id = j.id where j.order_no in ('PO-102','PO-103','PO-104') group by 1,2,3 order by 1")
ok('F/S + B/S became two slots', r.rows[0].sides.join() === 'F/S:C|M|Y|K|PMS 185,B/S:K|PMS 286' && r.rows[0].category === 'Carton Box', r.rows[0])
ok('B/B became B/B F + B/B B', r.rows[1].sides.join() === 'B/B F:K|Gold,B/B B:K|Gold', r.rows[1])
ok('created by the importing user', r.rows.every((x) => x.created_by === S), r.rows)
r = await imp(S, [row(2)])
ok('same file again: already exists', r.ok === false && /already exists/.test(r.errors[0].message), r)
r = await imp(S, Array.from({ length: 501 }, (_, i) => row(i + 2)))
ok('more than 500 rows refused', r.ok === false && /at most 500/.test(r.errors[0].message), r)
r = await imp(S, [])
ok('empty file refused', r.ok === false && /no jobs/.test(r.errors[0].message), r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
