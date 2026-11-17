// Wastage reason categories (Material | Method | Others).
// Embedded Postgres (PGlite). Usage: node wastage_categories.test.mjs <all migrations in order>
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { readFileSync } from 'node:fs'

const migrations = process.argv.slice(2).map((f) => readFileSync(f, 'utf8'))
const db = new PGlite({ extensions: { btree_gist } })
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, typeof extra === 'string' ? extra : JSON.stringify(extra)) }
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
const last = migrations.pop()
for (const sql of migrations) await db.exec(sql)
// The reasons as they are on the live site (spelling as typed there).
await db.exec(`
  delete from public.wastage_reasons;
  insert into public.wastage_reasons (name) values
    ('Blanket Punch'), ('Scratches on plate'), ('Board bend'), ('Paper Creasing issue'), ('Picking (paper dust)'),
    ('Scum'), ('Colour miss-match/ Variation'), ('Hickies'), ('Mis-registration'), ('Set-off'),
    ('Power failure (Sheets wastage in conventional)'), ('Something new');
`)
await db.exec(last)

const cat = async (name) => (await db.query('select category from public.wastage_reasons where name = $1', [name])).rows[0]?.category
for (const n of ['Blanket Punch', 'Scratches on plate', 'Board bend', 'Paper Creasing issue', 'Picking (paper dust)']) ok(`${n} → Material`, (await cat(n)) === 'Material', await cat(n))
for (const n of ['Scum', 'Colour miss-match/ Variation', 'Hickies', 'Mis-registration', 'Set-off']) ok(`${n} → Method`, (await cat(n)) === 'Method', await cat(n))
ok('Power failure → Others', (await cat('Power failure (Sheets wastage in conventional)')) === 'Others')
ok('unknown reason → Others', (await cat('Something new')) === 'Others')
let e = null
try { await db.exec("insert into public.wastage_reasons (name, category) values ('Bad', 'Man')") } catch (x) { e = x.message }
ok('only Material / Method / Others allowed', Boolean(e), e)
await db.exec("insert into public.wastage_reasons (name) values ('Defaulted')")
ok('new reason without a category → Others', (await cat('Defaulted')) === 'Others')
e = null
try { await db.exec("insert into public.wastage_reasons (name, category) values ('scum', 'Material')") } catch (x) { e = x.message }
ok('reason names stay unique across categories', Boolean(e), e)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
