# Pragati Production Logbook

Shift production logbook for Pragati Offset's printing machines.

| Part | Technology | Hosted on |
|---|---|---|
| Front-end (`web/`) | React + Vite + TypeScript | Cloudflare (Workers & Pages) |
| Database, login, API (`supabase/`) | Supabase: Postgres, Auth, Row Level Security, Edge Functions | Supabase (South Asia – Mumbai) |

Built in phases (per the Pragati Offset FSD). **Done:** phase 1 – sign-in, Super Admin, per-user
permission matrix, machine access, ten master tables, audit trail, sidebar layout and dashboard shell.
Later phases add master screens, Production Plan, Production Entry, Downtime, reports, user screens
and ink formulas.

## Repository layout

```
web/                         React app
  src/lib/supabase.ts        Supabase client (publishable key only)
  src/lib/auth.tsx           Sign-in, sign-out, password change, profile + permissions
  src/lib/nav.ts             Sidebar modules/submodules and the permission each needs
  src/lib/username.ts        Username → internal login email mapping
  src/components/            App shell, sidebar, route/permission guards
  src/pages/                 Screens
  wrangler.jsonc             Cloudflare deploy config
supabase/
  config.toml                Local Supabase settings (sign-up disabled, 12-char passwords)
  migrations/                Database schema, RLS policies and RPCs, applied in order
  functions/admin-users/     User creation, edits, disabling and password resets
  tests/                     Database rule tests (run on embedded Postgres)
.github/workflows/           Manual "Deploy Supabase" workflow
```

## How access works

- Operators sign in with a **username**. Supabase Auth is email-based, so `ravi` signs in as
  `ravi@pragati.internal` behind the scenes. That address never receives mail.
- **Super Admin** (exactly one) has every permission. Other users have a role label
  (Manager, Supervisor, Operator, Office User) plus a **permission matrix**: View / Create / Edit /
  Delete per screen (`permission_resources`). Create, Edit and Delete always require View.
- Machine access: all machines, or a chosen list.
- Master lists live in ten separate tables. Created/updated by and at are set by the database,
  and changes to users, permissions and masters are written to `audit_logs` (Super Admin only).
- Every table has Row Level Security. The browser only holds the publishable key, so the
  database itself decides what each user can read or change.
- New users are created through the `admin-users` Edge Function (needs the Users permission;
  only the Super Admin can change permissions). The service-role key
  stays on the server. New and reset passwords are temporary and must be changed at next sign-in.
- Disabling a user bans them in Auth and removes their data access immediately.
- A user can be deleted only if they never created or changed any record; otherwise deactivate them,
  so the audit trail and "created by" names stay intact. The Super Admin cannot be deactivated or deleted.

## One-time setup

### 1. Supabase project settings (dashboard)

1. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up".
   Leave "Confirm email" off.
2. **Authentication → Sign In / Providers → Email**: set the minimum password length to **12**.
3. **Project Settings → API keys**: copy the **Project URL** and the **publishable key** for step 4.

### 2. Apply the database and deploy the function

With the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started):

```bash
supabase login
supabase link --project-ref mklkjywrtypdyqovqhvw
supabase db push                       # applies supabase/migrations
supabase functions deploy admin-users
```

Or use the **Deploy Supabase** GitHub Action (Actions tab → Run workflow) after adding the
secrets listed at the top of `.github/workflows/supabase-deploy.yml`.

### 3. Create the first administrator

1. **Authentication → Users → Add user → Create new user**: email `dinesh@pragati.internal`,
   a strong password, and tick **Auto Confirm User**.
2. **SQL Editor**, run:

```sql
insert into public.profiles (id, username, full_name, role, all_machines, must_change_password)
select id, 'dinesh', 'Dinesh Kumar P', 'super_admin', true, false
from auth.users
where email = 'dinesh@pragati.internal';

-- Starting machines (edit to match the plant)
insert into public.machines (code, name, sort_order)
values ('K729', 'K729', 1), ('K629', 'K629', 2), ('KBA105', 'KBA105', 3);
```

Every later user is created from the app's **Users** screen.

### 4. Deploy the front-end on Cloudflare

Cloudflare dashboard → **Workers & Pages → Create** → import the GitHub repository
`dinesh456crypto/pragati-logbook`:

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm run build` |
| Output directory (Pages) | `dist` |
| Deploy command (Workers) | `npx wrangler deploy` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |

Then add the Cloudflare URL (`https://logbook.pragati-offset.workers.dev`) in Supabase under
**Authentication → URL Configuration → Site URL**.

## Local development

```bash
cd web
cp .env.example .env.local   # fill in the publishable key
npm install
npm run dev                  # http://localhost:5173
npm run build                # type-check and production build
npm run lint
```

Database rule tests (from a folder with `@electric-sql/pglite` installed):

```bash
node supabase/tests/permissions.test.mjs \
  supabase/migrations/20261112120000_foundation.sql \
  supabase/migrations/20261113120000_phase1_permissions_masters.sql

node supabase/tests/production_plan.test.mjs \
  supabase/migrations/20261112120000_foundation.sql \
  supabase/migrations/20261113120000_phase1_permissions_masters.sql \
  supabase/migrations/20261113150000_phase3_production_plan.sql

node supabase/tests/production_entry.test.mjs \
  supabase/migrations/20261112120000_foundation.sql \
  supabase/migrations/20261113120000_phase1_permissions_masters.sql \
  supabase/migrations/20261113150000_phase3_production_plan.sql \
  supabase/migrations/20261114100000_phase4_production_entry.sql

node supabase/tests/timeline_downtime.test.mjs \
  supabase/migrations/20261112120000_foundation.sql \
  supabase/migrations/20261113120000_phase1_permissions_masters.sql \
  supabase/migrations/20261113150000_phase3_production_plan.sql \
  supabase/migrations/20261114100000_phase4_production_entry.sql \
  supabase/migrations/20261115100000_phase4b_sides_timeline_downtime.sql

node supabase/tests/plan_bb.test.mjs <the five migrations above> \
  supabase/migrations/20261116100000_phase4c_bb_one_slot.sql

node supabase/tests/downtime_reports.test.mjs <the six migrations above> \
  supabase/migrations/20261117100000_phase5_downtime_rules_reports.sql

node supabase/tests/ink_formula.test.mjs $(ls supabase/migrations/*.sql | sort | grep -v phase9 | grep -v 20261123 | grep -v 20261124)
node supabase/tests/wastage.test.mjs $(ls supabase/migrations/*.sql | sort)
node supabase/tests/users.test.mjs $(ls supabase/migrations/*.sql | sort)
node supabase/tests/job_import.test.mjs $(ls supabase/migrations/*.sql | sort)
node supabase/tests/cso_downtime_ink.test.mjs $(ls supabase/migrations/*.sql | sort | grep -v 20261124)
node supabase/tests/wastage_categories.test.mjs $(ls supabase/migrations/*.sql | sort)
# go-live hardening is checked by running users / wastage / job_import with all migrations
```

Reports: the dashboard and Production Log Summary count only submitted entries.
Downtime between the end of B shift (the last job's production end, not before
4:30 PM, or 1:00 AM when no job ran, unless an admin sets it) and 8:00 AM is not
counted.

## Importing data from the old Google Sheets system

Planned. The new system starts empty; an admin import tool for the old logbook's jobs, downtime
and master lists will be added later.

## Why the app calls `/supabase/...`

Some Indian internet providers block `*.supabase.co`. The live site therefore sends
all database and sign-in calls to its own address (`/supabase/...`), and the small
Cloudflare Worker in `web/worker/index.js` forwards them to the Supabase project.
Local development (`npm run dev`) still talks to Supabase directly.

