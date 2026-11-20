// Ink Formula Entry takes its orders and colours from saved production entries.
// Embedded Postgres (PGlite). Usage: node ink_entries.test.mjs <migrations, without 20261127110000 (Storage)>
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
const I = '00000000-0000-0000-0000-00000000000b' // ink user: view + create
const N = '00000000-0000-0000-0000-00000000000d' // no ink rights
await db.exec(`insert into auth.users values ('${I}','inku@pragati.internal', null), ('${N}','ravi@pragati.internal', null)`)
await as(S, "select public.admin_save_user($1,'ravi','Ravi','operator',true,true,'{}',$2::jsonb)", [N, JSON.stringify([{ resource: 'production_entry', view: true, create: true }])])
await as(S, "select public.admin_save_user($1,'inku','Ink Person','office_user',true,true,'{}',$2::jsonb)", [I, JSON.stringify([{ resource: 'ink_formula', view: true, create: true }])])
const art = (await one("insert into public.paper_types (name) values ('Art Card') returning id")).id
const job = (order, h, colours, over = {}) => ({ ...entry(order, m.K729, h), planned_colours: colours,
  unit_colours: [...colours, null, null, null, null, null, null, null].slice(0, 7), ...over })
const rpc = async (user, sql, p) => { const r = await as(user, sql, p); return r.error ? r : r.rows[0]?.r ?? r.rows }
// Saved entries: PO-A (two sides), PO-B CMYK only, PO-C draft only, PO-D same colour/paper/category as PO-A.
let r = await save(await uuid(), job('PO-A', '08', ['C', 'K', 'P185'], { print_side: 'F/S' }), true)
ok('entry PO-A F/S saved', r.ok, r)
r = await save(await uuid(), job('PO-A', '09', ['K', 'p185', 'Gold'], { print_side: 'B/S', job_name: 'Box v2' }), true)
ok('entry PO-A B/S saved', r.ok, r)
await save(await uuid(), job('PO-B', '10', ['C', 'M', 'Y', 'K']), true)
await save(await uuid(), { ...job('PO-C', '11', ['P300']), machine_id: m.K629 }, false) // draft (one per machine)
await save(await uuid(), job('PO-D', '12', ['P185', 'Silver']), true)
await save(await uuid(), job('PO-E', '13', ['P185'], { paper_type_id: art }), true)

let opts = (await as(I, 'select * from public.ink_order_options()')).rows
const names = opts.map((o) => o.order_no).sort().join()
ok('orders from saved entries needing a formula (CMYK-only and draft-only left out)', names === 'PO-A,PO-D,PO-E', names)
const a = opts.find((o) => o.order_no === 'PO-A')
ok('order details from the latest saved entry', a.job_name === 'Box v2' && a.cso_no === 'x' && a.category === 'Carton' && a.paper_type === 'CFBB' && a.last_production_date, a)
r = await as(N, 'select count(*)::int n from public.ink_order_options()')
ok('user without ink rights sees no orders', r.rows?.[0].n === 0, r)

let cols = await rpc(I, 'select public.order_entry_colours($1) r', ['po-a '])
ok('colours of all sides together, shared colour once, in entry order', cols.map((c) => c.colour).join() === 'C,K,P185,Gold' && cols.find((c) => c.colour === 'P185').sides.join() === 'B/S,F/S', cols)
ok('C and K marked standard', cols.filter((c) => c.standard).map((c) => c.colour).join() === 'C,K', cols)

const saveInk = (user, id, order, colours, expected = null) => rpc(user, 'select public.save_ink_formula($1,$2,$3::jsonb,null,$4) r', [id, order, JSON.stringify(colours), expected])
r = await saveInk(I, null, 'PO-C', [{ colour: 'P300', formula: 'x' }])
ok('order with only a draft entry refused', r.ok === false && /saved production entry/.test(JSON.stringify(r)), r)
r = await saveInk(I, null, 'PO-A', [{ colour: 'P185', formula: 'Rubine 60%' }, { colour: 'Gold', formula: '' }, { colour: 'C', formula: 'x' }])
ok('formula saved for an order from Production Entry', r.ok && r.revision === 1, r)
const recA = r.id
const row = await one('select * from public.ink_formula_records where id = $1', [recA])
ok('record keeps job name, category, paper type, production date; no plan job', row.job_name === 'Box v2' && row.category === 'Carton' && row.paper_type === 'CFBB' && row.paper_type_id === paper && row.production_date && row.job_id === null, row)
r = await saveInk(I, null, 'po-a', [{ colour: 'P185', formula: 'again' }])
ok('second formula for the same order refused', r.code === 'EXISTS' && r.id === recA, r)
opts = (await as(I, 'select * from public.ink_order_options()')).rows
ok('PO-A listed with its formula', opts.find((o) => o.order_no === 'PO-A')?.record_id === recA, opts)
cols = await rpc(I, 'select public.order_entry_colours($1) r', ['PO-D'])
ok('same colour, paper type and category on another order → formula known', cols.find((c) => c.colour === 'P185')?.known?.record_id === recA && !cols.find((c) => c.colour === 'Silver').known, cols)
cols = await rpc(I, 'select public.order_entry_colours($1) r', ['PO-E'])
ok('different paper type → not known', cols.find((c) => c.colour === 'P185')?.known === null, cols)
r = await saveInk(I, null, 'PO-D', [{ colour: 'P185', formula: 'mine' }, { colour: 'Silver', formula: 'Silver 90%' }])
const d = await one('select colour from public.ink_formula_colours where record_id = $1 order by line', [r.id])
ok('known colour is not saved again on the other order', r.ok && d.colour === 'Silver', [r, d])
opts = (await as(I, 'select * from public.ink_order_options()')).rows
// A new saved entry adds a colour to PO-A; editing keeps old colours and offers the new one.
r = await save(await uuid(), job('PO-A', '14', ['Orange'], { print_side: 'F/S', continuing: true }), true)
ok('later PO-A entry saved', r.ok, r)
cols = await rpc(I, 'select public.order_entry_colours($1, $2) r', ['PO-A', row.created_at])
ok('new colour from a later entry offered', cols.some((c) => c.colour === 'Orange'), cols)
r = await saveInk(S, recA, null, [{ colour: 'P185', formula: 'Rubine 55%' }, { colour: 'Gold', formula: 'Gold 80%' }, { colour: 'Orange', formula: 'Orange 100%' }], row.updated_at)
ok('editor saves revision 2 with the new colour', r.ok && r.revision === 2, r)

// Colour codes written differently are one colour.
const keys = await one("select public.colour_key('P185') a, public.colour_key('185') b, public.colour_key('p.185') c, public.colour_key('PMS 185') d, public.colour_key('Pblue072') e, public.colour_key('Rubine Red') f, public.colour_key('P') g")
ok('colour codes: P185 = 185 = p.185 = PMS 185', keys.a === '185' && keys.b === '185' && keys.c === '185' && keys.d === '185', keys)
ok('colour names kept (Pblue072, Rubine Red, P)', keys.e === 'pblue072' && keys.f === 'rubinered' && keys.g === 'p', keys)
r = await save(await uuid(), job('PO-F', '15', ['185', 'p.2087']), true)
ok('entry PO-F with 185 saved', r.ok, r)
await save(await uuid(), job('PO-F', '16', ['P2087', 'Texture'], { continuing: true }), true)
cols = await rpc(I, 'select public.order_entry_colours($1) r', ['PO-F'])
ok('185 → formula known from P185 of PO-A (same paper and category)', cols.find((c) => c.colour === '185')?.known?.record_id === recA, cols)
ok('p.2087 and P2087 shown once, as P2087', cols.filter((c) => /2087/.test(c.colour)).map((c) => c.colour).join() === 'P2087', cols)
r = await saveInk(I, null, 'PO-F', [{ colour: '185', formula: 'again' }, { colour: 'p2087', formula: 'Warm red' }, { colour: 'Texture', formula: 'Varnish' }])
const fcols = (await db.query('select colour from public.ink_formula_colours where record_id = $1 order by line', [r.id])).rows.map((x) => x.colour)
ok('known 185 not asked again; P2087 saved once', r.ok && fcols.join() === 'P2087,Texture', [r, fcols])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
