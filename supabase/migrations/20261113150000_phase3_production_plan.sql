-- Phase 3: Production Plan (Job Details).
-- Planned jobs are the source for Production Entry and Ink Formula Management.
-- Order Number is the business key: unique, regardless of case or spacing.

-- Planned colours: up to nine, none empty, no duplicates (ignoring case).
create or replace function public.planned_colours_valid(p_colours text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(cardinality(p_colours), 0) <= 9
     and not exists (select 1 from unnest(p_colours) c where c is null or length(btrim(c)) not between 1 and 40)
     and (select count(distinct lower(btrim(c))) from unnest(p_colours) c) = coalesce(cardinality(p_colours), 0);
$$;

create table public.production_jobs (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null,
  order_no text not null check (length(btrim(order_no)) between 1 and 60),
  job_name text not null check (length(btrim(job_name)) between 1 and 150),
  category text check (category is null or length(btrim(category)) between 1 and 80),
  ups integer not null check (ups > 0),
  job_type text not null check (job_type in ('NPD', 'NEW', 'Re-Print')),
  -- A paper type used by a job cannot be deleted (mark it Inactive instead).
  paper_type_id uuid not null references public.paper_types (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  colours text[] not null default '{}' check (public.planned_colours_valid(colours)),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

create unique index production_jobs_order_no_unique on public.production_jobs (lower(btrim(order_no)));
create index production_jobs_plan_date_idx on public.production_jobs (plan_date desc);
create index production_jobs_paper_type_idx on public.production_jobs (paper_type_id);

create trigger production_jobs_audit_fields
before insert or update on public.production_jobs
for each row execute function public.set_audit_fields();

create trigger production_jobs_audit
after insert or update or delete on public.production_jobs
for each row execute function public.audit_row();

alter table public.production_jobs enable row level security;
revoke all on public.production_jobs from anon;

-- Production Entry and Ink Formula users look jobs up by Order Number too.
create policy production_jobs_select on public.production_jobs
  for select to authenticated
  using (
    (select public.has_perm('production_plan', 'view'))
    or (select public.has_perm('production_entry', 'view'))
    or (select public.has_perm('ink_formula', 'view'))
  );
create policy production_jobs_insert on public.production_jobs
  for insert to authenticated with check ((select public.has_perm('production_plan', 'create')));
create policy production_jobs_update on public.production_jobs
  for update to authenticated
  using ((select public.has_perm('production_plan', 'edit')))
  with check ((select public.has_perm('production_plan', 'edit')));
-- Jobs already used by production entries or ink formulas will be protected by
-- foreign keys added with those tables.
create policy production_jobs_delete on public.production_jobs
  for delete to authenticated using ((select public.has_perm('production_plan', 'delete')));

revoke execute on function public.planned_colours_valid(text[]) from public, anon;
grant execute on function public.planned_colours_valid(text[]) to authenticated;
