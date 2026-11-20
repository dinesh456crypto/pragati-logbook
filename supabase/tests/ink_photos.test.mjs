// Ink formula sample photos: who can add / see / remove them. Embedded Postgres (PGlite)
// with a small stand-in for Supabase Storage (storage.buckets / storage.objects).
// Usage: node ink_photos.test.mjs <all migrations in order>
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
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid default auth.uid());
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant select, insert, delete on storage.objects to authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`)
const S = '00000000-0000-0000-0000-00000000000a' // super admin
const I = '00000000-0000-0000-0000-00000000000b' // ink user: view + create
const V = '00000000-0000-0000-0000-00000000000c' // viewer: view only
const N = '00000000-0000-0000-0000-00000000000d' // no ink rights
await db.exec(migrations[0])
await db.exec(`
  insert into auth.users values ('${S}','dinesh@pragati.internal',null),('${I}','inku@pragati.internal',null),('${V}','view@pragati.internal',null),('${N}','ravi@pragati.internal',null);
  insert into public.profiles (id, username, full_name, role, must_change_password) values ('${S}','dinesh','Dinesh Kumar P','admin', false);
  insert into public.machines (code, name, sort_order) values ('K729','Komori 729',1);
`)
for (const sql of migrations.slice(1)) await db.exec(sql)
console.log('All migrations applied.')
const one = async (sql, p) => (await db.query(sql, p)).rows[0]
await as(S, "select public.admin_save_user($1,'inku','Ink Person','office_user',true,true,'{}',$2::jsonb)", [I, JSON.stringify([{ resource: 'ink_formula', view: true, create: true }])])
await as(S, "select public.admin_save_user($1,'viewer','Viewer','office_user',true,true,'{}',$2::jsonb)", [V, JSON.stringify([{ resource: 'ink_formula', view: true }])])
await as(S, "select public.admin_save_user($1,'ravi','Ravi','operator',true,true,'{}',$2::jsonb)", [N, JSON.stringify([{ resource: 'production_entry', view: true, create: true }])])

ok('bucket made private', (await one("select public from storage.buckets where id = 'ink-photos'"))?.public === false)
const machine = (await one("select id from public.machines where code = 'K729'")).id
const paper = (await one("insert into public.paper_types (name) values ('Art Card') returning id")).id
const coating = (await one("insert into public.coatings (name) values ('UV') returning id")).id
const job = (order, colour = 'PMS 185') => as(S, 'select public.save_production_job(null,$1::jsonb,$2::jsonb) r', [JSON.stringify({ plan_date: '2026-11-10', order_no: order, job_name: 'Carton',
  category: 'Carton', ups: 2, job_type: 'NEW', paper_type_id: paper, quantity: 1000, cso_no: 'CSO-1', coating_id: coating, machine_id: machine }), JSON.stringify([{ print_side: 'O/S', colours: ['C', colour] }])])
await job('PO-1')
await job('PO-2', 'Gold')
const saveInk = async (user, order, colour = 'PMS 185') => (await as(user, 'select public.save_ink_formula(null,$1,$2::jsonb,null,null) r', [order, JSON.stringify([{ colour, formula: 'Rubine 60%' }])])).rows?.[0]?.r
const rec1 = (await saveInk(I, 'PO-1')).id
const rec2 = (await saveInk(S, 'PO-2', 'Gold')).id
ok('formula records made', rec1 && rec2)

const upload = (user, path) => as(user, "insert into storage.objects (bucket_id, name) values ('ink-photos', $1) returning name", [path])
const add = async (user, rec, path) => { const r = await as(user, 'select public.add_ink_formula_photo($1,$2) r', [rec, path]); return r.error ? r : r.rows[0].r }
const p1 = `${rec1}/${(await one('select gen_random_uuid() id')).id}.jpg`
let r = await upload(N, p1)
ok('user without ink rights cannot upload', Boolean(r.error), r)
r = await upload(V, p1)
ok('view-only user cannot upload', Boolean(r.error), r)
r = await upload(I, p1)
ok('ink user (create) can upload', !r.error, r)
r = await add(I, rec1, p1)
ok('creator adds a photo to own new formula (revision 1)', r.ok && r.revision === 1, r)
r = await add(I, rec1, `${rec1}/${(await one('select gen_random_uuid() id')).id}.jpg`)
ok('photo that was not uploaded is refused', r.ok === false && /not uploaded/.test(r.message), r)
r = await add(I, rec1, `${rec2}/x.jpg`)
ok('wrong folder / name refused', r.ok === false, r)
const p2 = `${rec2}/${(await one('select gen_random_uuid() id')).id}.jpg`
await upload(S, p2)
r = await add(I, rec2, p2)
ok("create-only user cannot add to someone else's formula", r.code === '42501', r)
r = await add(N, rec1, p1)
ok('user without ink rights cannot add', r.code === '42501', r)
r = await as(V, 'select count(*)::int n from public.ink_formula_photos')
ok('view-only user sees the photo list', r.rows?.[0].n === 1, r)
r = await as(V, "select count(*)::int n from storage.objects where bucket_id = 'ink-photos'")
ok('view-only user can read the photo files', r.rows?.[0].n === 2, r)
r = await as(N, 'select count(*)::int n from public.ink_formula_photos')
ok('user without ink rights sees no photos', r.rows?.[0].n === 0, r)
r = await as(I, 'insert into public.ink_formula_photos (record_id, revision, path) values ($1, 1, $2)', [rec1, 'x'])
ok('no direct writes to the photo list', Boolean(r.error), r)

// An edit makes revision 2; a photo added then is tagged with revision 2.
const row = await one('select updated_at from public.ink_formula_records where id = $1', [rec2])
await as(S, 'select public.save_ink_formula($1,null,$2::jsonb,$3,$4)', [rec2, JSON.stringify([{ colour: 'Gold', formula: 'Rubine 55%' }]), 'darker', row.updated_at])
r = await add(S, rec2, p2)
ok('photo added after an edit carries the new revision', r.ok && r.revision === 2, r)
r = await add(S, rec2, p2)
ok('same photo twice is ignored', r.ok && (await one('select count(*)::int n from public.ink_formula_photos where record_id = $1', [rec2])).n === 1, r)

const photo1 = (await one('select id from public.ink_formula_photos where path = $1', [p1])).id
r = await as(I, 'select public.remove_ink_formula_photo($1) r', [photo1])
ok('create-only user cannot remove a photo', r.code === '42501', r)
r = await as(I, "delete from storage.objects where name = $1 returning name", [p1])
ok('create-only user cannot delete the file', (r.rows ?? []).length === 0, r)
r = await as(S, 'select public.remove_ink_formula_photo($1) r', [photo1])
ok('editor removes a photo and gets its path back', r.rows?.[0].r.ok && r.rows[0].r.path === p1, r)
r = await as(S, "delete from storage.objects where name = $1 returning name", [p1])
ok('editor can delete the file', r.rows?.length === 1, r)
r = await as(S, 'select public.remove_ink_formula_photo($1) r', [photo1])
ok('removing twice says already removed', r.rows?.[0].r.ok === false, r)

await as(S, 'select public.archive_ink_formula($1, true)', [rec2])
const p3 = `${rec2}/${(await one('select gen_random_uuid() id')).id}.jpg`
await upload(S, p3)
r = await add(S, rec2, p3)
ok('no photos added to an archived formula', r.ok === false && /archived/.test(r.message), r)
r = await one('select count(*)::int n from public.audit_logs where table_name = $1', ['ink_formula_photos'])
ok('photo changes are in the audit log', r.n >= 3, r)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
