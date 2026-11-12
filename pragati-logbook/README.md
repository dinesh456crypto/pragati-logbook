# Pragati Production Logbook

Shift production logbook for Pragati Offset's printing machines.

| Part | Technology | Hosted on |
|---|---|---|
| Front-end (`web/`) | React + Vite + TypeScript | Cloudflare (Workers & Pages) |
| Database, login, API (`supabase/`) | Supabase: Postgres, Auth, Row Level Security, Edge Functions | Supabase (South Asia – Mumbai) |

This repository currently contains the **foundation**: sign-in, roles, machine access and master lists.
Production entry, finished jobs and downtime screens are added in the next phase.

## Repository layout

```
web/                         React app
  src/lib/supabase.ts        Supabase client (publishable key only)
  src/lib/auth.tsx           Sign-in, sign-out, password change, current profile
  src/lib/username.ts        Username → internal login email mapping
  src/components/            Layout, route guards
  src/pages/                 Screens
  wrangler.jsonc             Cloudflare deploy config
supabase/
  config.toml                Local Supabase settings (sign-up disabled, 12-char passwords)
  migrations/                Database schema, RLS policies and RPCs, applied in order
  functions/admin-users/     Admin-only user creation and password resets
.github/workflows/           Manual "Deploy Supabase" workflow
```

## How access works

- Operators sign in with a **username**. Supabase Auth is email-based, so `ravi` signs in as
  `ravi@pragati.internal` behind the scenes. That address never receives mail.
- Roles: **admin** (everything, all machines) and **operator** (only machines assigned to them).
- Every table has Row Level Security. The browser only holds the publishable key, so the
  database itself decides what each user can read or change.
- New users are created by an admin through the `admin-users` Edge Function. The service-role key
  stays on the server. New and reset passwords are temporary and must be changed at next sign-in.
- Disabling a user bans them in Auth and removes their data access immediately.

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
insert into public.profiles (id, username, full_name, role, must_change_password)
select id, 'dinesh', 'Dinesh Kumar P', 'admin', false
from auth.users
where email = 'dinesh@pragati.internal';

-- Starting machines (edit to match the plant)
insert into public.machines (code, sort_order) values ('K729', 1), ('K629', 2), ('KBA105', 3);
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

Then add the Cloudflare URL (e.g. `https://pragati-logbook.<account>.workers.dev`) in Supabase under
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

## Importing data from the old Google Sheets system

Planned. The new system starts empty; an admin import tool for the old logbook's jobs, downtime
and master lists will be added later.
