-- Phase 9: ink formula changes and Wastage Management.
--
--   Ink formulas
--   * The standard process colours C, M, Y, K need no formula: they are left out
--     of ink formula records.
--   * Records also keep the order's Type of Paper.
--
--   Wastage Management
--   * One wastage record per order that has submitted production entries.
--   * Production figures (job name, UPS, OK sheets, production wastage) are taken
--     from the submitted production entries when the record is saved.
--   * The user adds order quantity, packed quantity and any number of wastage
--     lines (process, defect, reason, quantity, unit: cartons or sheets).
--   * Writes go through save_wastage_record(); deleting needs the Delete right.

-- ---------------------------------------------------------------------------
-- 1. Ink formulas
-- ---------------------------------------------------------------------------

create or replace function public.is_standard_colour(p_colour text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_colour, ''))) in ('c', 'm', 'y', 'k');
$$;

alter table public.ink_formula_records add column paper_type text;
update public.ink_formula_records r set paper_type = p.name
from public.production_jobs j join public.paper_types p on p.id = j.paper_type_id
where j.id = r.job_id;

-- Standard colours already saved on a record are taken off it.
delete from public.ink_formula_colours where public.is_standard_colour(colour);

create or replace function public.order_plan_colours(p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select s.line, n, btrim(colour) as colour,
           case when s.print_side in ('B/B F', 'B/B B') then 'B/B' else s.print_side end as side
    from public.production_job_sides s
    cross join lateral unnest(s.colours) with ordinality as u(colour, n)
    where s.job_id = p_job_id
      and (public.has_perm('ink_formula', 'view') or public.has_perm('production_plan', 'view'))
  ),
  g as (
    select lower(colour) as k, min(colour) as colour, min(line * 1000 + n) as pos,
           array_agg(distinct side order by side) as sides
    from c group by lower(colour)
  )
  select coalesce(jsonb_agg(jsonb_build_object('colour', g.colour, 'sides', to_jsonb(g.sides),
                                               'standard', public.is_standard_colour(g.colour)) order by g.pos), '[]'::jsonb)
  from g;
$$;

create or replace function public.save_ink_formula(
  p_id uuid,
  p_order_no text,
  p_colours jsonb, -- [{colour, formula}]
  p_note text default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec public.ink_formula_records;
  v_exists boolean := false;
  v_job public.production_jobs;
  v_plan jsonb;
  v_allowed text[];
  v_old jsonb := '[]'::jsonb;
  v_new jsonb := '[]'::jsonb;
  v_item jsonb;
  v_colour text;
  v_formula text;
  v_sides jsonb;
  v_line integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_name text := (select p.full_name from public.profiles p where p.id = auth.uid());
  v_other public.ink_formula_records;
  v_paper text;
begin
  if not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if p_id is not null then
    select * into v_rec from public.ink_formula_records where id = p_id for update;
    v_exists := found;
    if not v_exists then
      raise exception 'Formula record not found' using errcode = 'P0002';
    end if;
    if not public.has_perm('ink_formula', 'edit') then
      raise exception 'You do not have permission to edit ink formulas' using errcode = '42501';
    end if;
    if v_rec.archived then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors',
        jsonb_build_array(jsonb_build_object('field', null, 'message', 'This formula record is archived. Restore it before editing.')));
    end if;
    if p_expected_updated_at is distinct from v_rec.updated_at then
      return jsonb_build_object('ok', false, 'code', 'STALE',
        'message', 'This formula was changed by someone else after you opened it. Reopen it to see the latest version.');
    end if;
    select * into v_job from public.production_jobs j where j.id = v_rec.job_id;
    select coalesce(jsonb_agg(jsonb_build_object('colour', c.colour, 'sides', to_jsonb(c.sides), 'formula', c.formula) order by c.line), '[]'::jsonb)
      into v_old
    from public.ink_formula_colours c where c.record_id = v_rec.id;
  else
    if not public.has_perm('ink_formula', 'create') then
      raise exception 'You do not have permission to create ink formulas' using errcode = '42501';
    end if;
    select * into v_job from public.production_jobs j where lower(btrim(j.order_no)) = lower(btrim(coalesce(p_order_no, '')));
    if not found then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors',
        jsonb_build_array(jsonb_build_object('field', 'order_no', 'message', 'Select an order from Production Plan.')));
    end if;
    select * into v_other from public.ink_formula_records r where r.order_key = lower(btrim(v_job.order_no)) and not r.archived;
    if found then
      return jsonb_build_object('ok', false, 'code', 'EXISTS', 'id', v_other.id, 'record_no', v_other.record_no,
        'message', format('Order %s already has ink formula IF-%s. Open it to make changes.', v_job.order_no, lpad(v_other.record_no::text, 5, '0')));
    end if;
  end if;

  -- Colours allowed: the plan's colours now, plus colours already on the record.
  -- The standard process colours C, M, Y, K never take a formula.
  v_plan := case when v_job.id is not null then public.order_plan_colours(v_job.id) else '[]'::jsonb end;
  v_allowed := array(select lower(x ->> 'colour') from jsonb_array_elements(v_plan || v_old) x
                     where not public.is_standard_colour(x ->> 'colour'));
  if not v_exists and cardinality(v_allowed) = 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', jsonb_build_array(jsonb_build_object('field', 'colours',
      'message', 'This order uses only the standard colours C, M, Y, K, which need no ink formula.')));
  end if;
  v_paper := (select p.name from public.paper_types p where p.id = v_job.paper_type_id);

  for v_item in select value from jsonb_array_elements(coalesce(p_colours, '[]'::jsonb)) loop
    v_colour := btrim(coalesce(v_item ->> 'colour', ''));
    v_formula := nullif(btrim(coalesce(v_item ->> 'formula', '')), '');
    continue when public.is_standard_colour(v_colour); -- no formula for C, M, Y, K
    if v_colour = '' or not (lower(v_colour) = any (v_allowed)) then
      v_errors := v_errors || jsonb_build_object('field', 'colours',
        'message', format('Colour %s is not one of this order''s colours.', coalesce(nullif(v_colour, ''), '(blank)')));
      continue;
    end if;
    if exists (select 1 from jsonb_array_elements(v_new) n where lower(n ->> 'colour') = lower(v_colour)) then
      continue; -- each colour once
    end if;
    if v_formula is not null and length(v_formula) > 4000 then
      v_errors := v_errors || jsonb_build_object('field', 'colours',
        'message', format('The formula for %s is longer than 4000 characters.', v_colour));
    end if;
    v_sides := coalesce(
      (select x -> 'sides' from jsonb_array_elements(v_plan) x where lower(x ->> 'colour') = lower(v_colour) limit 1),
      (select x -> 'sides' from jsonb_array_elements(v_old) x where lower(x ->> 'colour') = lower(v_colour) limit 1),
      '[]'::jsonb);
    v_new := v_new || jsonb_build_array(jsonb_build_object('colour', v_colour, 'sides', v_sides, 'formula', v_formula));
  end loop;

  if not exists (select 1 from jsonb_array_elements(v_new) n where n ->> 'formula' is not null) then
    v_errors := v_errors || jsonb_build_object('field', 'colours', 'message', 'Enter the formula for at least one colour.');
  end if;
  if p_note is not null and length(p_note) > 300 then
    v_errors := v_errors || jsonb_build_object('field', 'note', 'message', 'The change note can be at most 300 characters.');
  end if;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
  end if;

  if v_exists then
    -- Nothing changed: keep the current revision.
    if v_new = v_old then
      return jsonb_build_object('ok', true, 'id', v_rec.id, 'record_no', v_rec.record_no, 'revision', v_rec.revision,
        'updated_at', v_rec.updated_at, 'unchanged', true);
    end if;
    update public.ink_formula_records set
      revision = revision + 1,
      updated_by_name = v_name,
      -- refresh the job snapshot while the plan still exists
      job_name = coalesce(v_job.job_name, job_name),
      paper_type = coalesce(v_paper, paper_type),
      category = coalesce(v_job.category, category),
      plan_date = coalesce(v_job.plan_date, plan_date)
    where id = v_rec.id
    returning * into v_rec;
  else
    insert into public.ink_formula_records (job_id, order_no, job_name, category, plan_date, paper_type, created_by_name, updated_by_name)
    values (v_job.id, v_job.order_no, v_job.job_name, v_job.category, v_job.plan_date, v_paper, v_name, v_name)
    returning * into v_rec;
  end if;

  delete from public.ink_formula_colours where record_id = v_rec.id;
  for v_item in select value from jsonb_array_elements(v_new) loop
    v_line := v_line + 1;
    insert into public.ink_formula_colours (record_id, line, colour, sides, formula)
    values (v_rec.id, v_line, v_item ->> 'colour',
            array(select jsonb_array_elements_text(v_item -> 'sides')), v_item ->> 'formula');
  end loop;

  insert into public.ink_formula_revisions (record_id, revision, colours, note, changed_by, changed_by_name)
  values (v_rec.id, v_rec.revision, v_new, nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), v_name);

  return jsonb_build_object('ok', true, 'id', v_rec.id, 'record_no', v_rec.record_no, 'revision', v_rec.revision,
    'updated_at', v_rec.updated_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Wastage Management
-- ---------------------------------------------------------------------------

insert into public.permission_resources (key, module, label, sort_order)
values ('wastage', 'Wastage Management', 'Wastage Entry and Summary', 70)
on conflict (key) do nothing;

create table public.wastage_records (
  id uuid primary key default gen_random_uuid(),
  record_no bigint generated by default as identity unique,
  job_id uuid references public.production_jobs (id) on delete restrict,
  order_no text not null check (length(btrim(order_no)) between 1 and 60),
  order_key text generated always as (lower(btrim(order_no))) stored,
  job_name text,
  ups integer,
  -- From the submitted production entries when the record was last saved.
  given_sheets integer not null default 0,
  ok_sheets integer not null default 0,
  separate_sheets integer not null default 0,
  production_wastage integer not null default 0, -- given - OK - separate
  production_entries integer not null default 0,
  -- Entered by the user.
  order_qty integer not null check (order_qty between 1 and 100000000),
  packed_qty integer not null check (packed_qty between 0 and 100000000),
  remarks text check (remarks is null or length(remarks) <= 500),
  created_by_name text,
  updated_by_name text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
create unique index wastage_records_one_per_order on public.wastage_records (order_key);
create index wastage_records_updated_idx on public.wastage_records (updated_at desc);
create index wastage_records_job_idx on public.wastage_records (job_id);

create table public.wastage_lines (
  record_id uuid not null references public.wastage_records (id) on delete cascade,
  line integer not null,
  process text not null check (length(btrim(process)) between 1 and 80),
  defect text not null check (length(btrim(defect)) between 1 and 120),
  reason text check (reason is null or length(reason) <= 200),
  quantity integer not null check (quantity between 1 and 100000000),
  unit text not null check (unit in ('cartons', 'sheets')),
  primary key (record_id, line)
);
create index wastage_lines_process_idx on public.wastage_lines (lower(process));

create trigger wastage_records_audit_fields
before insert or update on public.wastage_records
for each row execute function public.set_audit_fields();

create trigger wastage_records_audit
after insert or update or delete on public.wastage_records
for each row execute function public.audit_row();

-- What production recorded for an order (submitted entries only), with each print side.
create or replace function public.order_production_totals(p_order_no text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with e as (
    select x.* from public.production_entries x
    where x.order_key = lower(btrim(p_order_no)) and x.status = 'submitted'
  ),
  j as (select * from public.production_jobs pj where lower(btrim(pj.order_no)) = lower(btrim(p_order_no)))
  select case when not exists (select 1 from e) or not public.has_perm('wastage', 'view') then null else jsonb_build_object(
    'order_no', coalesce((select j.order_no from j), (select e.order_no from e order by e.created_at desc limit 1)),
    'job_id', (select j.id from j),
    'job_name', coalesce((select j.job_name from j), (select e.job_name from e order by e.created_at desc limit 1)),
    'ups', coalesce((select j.ups from j), (select e.ups from e order by e.created_at desc limit 1)),
    'entries', (select count(*) from e),
    'given_sheets', (select coalesce(sum(e.total_sheets), 0) from e),
    'ok_sheets', (select coalesce(sum(e.ok_sheets), 0) from e),
    'separate_sheets', (select coalesce(sum(e.separate_sheets), 0) from e),
    'production_wastage', (select coalesce(sum(coalesce(e.total_sheets, 0) - coalesce(e.ok_sheets, 0) - coalesce(e.separate_sheets, 0)), 0) from e),
    'last_production_date', (select max(e.production_date) from e),
    'fully_closed', public.order_fully_closed(lower(btrim(p_order_no))),
    'sides', (select coalesce(jsonb_agg(jsonb_build_object('side', s.print_side, 'entries', s.n, 'given', s.given, 'ok', s.ok,
                       'separate', s.sep, 'wastage', s.given - s.ok - s.sep) order by s.print_side), '[]'::jsonb)
              from (select coalesce(e.print_side, '—') as print_side, count(*) as n, coalesce(sum(e.total_sheets), 0) as given,
                           coalesce(sum(e.ok_sheets), 0) as ok, coalesce(sum(e.separate_sheets), 0) as sep
                    from e group by coalesce(e.print_side, '—')) s)
  ) end;
$$;

-- Orders that can take a wastage record: those with submitted production entries.
create or replace function public.wastage_order_options()
returns table (order_no text, job_name text, last_production_date date, record_id uuid, record_no bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (e.order_key) e.order_no, e.job_name, max(e.production_date) over (partition by e.order_key),
         w.id, w.record_no
  from public.production_entries e
  left join public.wastage_records w on w.order_key = e.order_key
  where e.status = 'submitted' and e.order_key is not null and public.has_perm('wastage', 'view')
  order by e.order_key, e.created_at desc;
$$;

-- Creates or updates the wastage record of an order.
create or replace function public.save_wastage_record(
  p_id uuid,
  p_order_no text,
  p_record jsonb, -- {order_qty, packed_qty, remarks}
  p_lines jsonb,  -- [{process, defect, reason, quantity, unit}]
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec public.wastage_records;
  v_exists boolean := false;
  v_totals jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_order_qty integer := nullif(p_record ->> 'order_qty', '')::integer;
  v_packed integer := nullif(p_record ->> 'packed_qty', '')::integer;
  v_remarks text := nullif(btrim(coalesce(p_record ->> 'remarks', '')), '');
  v_line jsonb;
  v_n integer := 0;
  v_process text;
  v_defect text;
  v_reason text;
  v_qty integer;
  v_unit text;
  v_name text := (select p.full_name from public.profiles p where p.id = auth.uid());
  v_order text;
begin
  if not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_id is not null then
    select * into v_rec from public.wastage_records where id = p_id for update;
    v_exists := found;
    if not v_exists then
      raise exception 'Wastage record not found' using errcode = 'P0002';
    end if;
    if not public.has_perm('wastage', 'edit') then
      raise exception 'You do not have permission to edit wastage records' using errcode = '42501';
    end if;
    if p_expected_updated_at is distinct from v_rec.updated_at then
      return jsonb_build_object('ok', false, 'code', 'STALE',
        'message', 'This record was changed by someone else after you opened it. Reopen it to see the latest version.');
    end if;
    v_order := v_rec.order_no;
  else
    if not public.has_perm('wastage', 'create') then
      raise exception 'You do not have permission to create wastage records' using errcode = '42501';
    end if;
    v_order := p_order_no;
    select * into v_rec from public.wastage_records w where w.order_key = lower(btrim(coalesce(p_order_no, '')));
    if found then
      return jsonb_build_object('ok', false, 'code', 'EXISTS', 'id', v_rec.id, 'record_no', v_rec.record_no,
        'message', format('Order %s already has wastage record WE-%s. Open it to make changes.', v_rec.order_no, lpad(v_rec.record_no::text, 5, '0')));
    end if;
  end if;

  v_totals := public.order_production_totals(v_order);
  if v_totals is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', jsonb_build_array(jsonb_build_object('field', 'order_no',
      'message', 'Select an order that has submitted production entries.')));
  end if;

  if v_order_qty is null or v_order_qty <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'order_qty', 'message', 'Enter the Order Qty (cartons), above zero.');
  end if;
  if v_packed is null or v_packed < 0 then
    v_errors := v_errors || jsonb_build_object('field', 'packed_qty', 'message', 'Enter the Packed Qty (cartons), zero or more.');
  end if;
  if v_remarks is not null and length(v_remarks) > 500 then
    v_errors := v_errors || jsonb_build_object('field', 'remarks', 'message', 'Remarks can be at most 500 characters.');
  end if;

  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_process := nullif(regexp_replace(btrim(coalesce(v_line ->> 'process', '')), '\s+', ' ', 'g'), '');
    v_defect := nullif(regexp_replace(btrim(coalesce(v_line ->> 'defect', '')), '\s+', ' ', 'g'), '');
    v_reason := nullif(btrim(coalesce(v_line ->> 'reason', '')), '');
    v_qty := nullif(v_line ->> 'quantity', '')::integer;
    v_unit := nullif(v_line ->> 'unit', '');
    continue when v_process is null and v_defect is null and v_reason is null and v_qty is null;
    v_n := v_n + 1;
    if v_process is null or length(v_process) > 80 then
      v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', format('Line %s: enter the Function / Process (up to 80 characters).', v_n));
    end if;
    if v_defect is null or length(v_defect) > 120 then
      v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', format('Line %s: enter the Defect (up to 120 characters).', v_n));
    end if;
    if v_reason is not null and length(v_reason) > 200 then
      v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', format('Line %s: Reason can be at most 200 characters.', v_n));
    end if;
    if v_qty is null or v_qty <= 0 then
      v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', format('Line %s: enter a Wastage Qty above zero.', v_n));
    end if;
    if v_unit is null or v_unit not in ('cartons', 'sheets') then
      v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', format('Line %s: choose the unit (cartons or sheets).', v_n));
    end if;
  end loop;
  if v_n = 0 then
    v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', 'Add at least one wastage line.');
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
  end if;

  if v_exists then
    update public.wastage_records set
      job_id = coalesce((v_totals ->> 'job_id')::uuid, job_id),
      job_name = v_totals ->> 'job_name',
      ups = (v_totals ->> 'ups')::integer,
      given_sheets = (v_totals ->> 'given_sheets')::integer,
      ok_sheets = (v_totals ->> 'ok_sheets')::integer,
      separate_sheets = (v_totals ->> 'separate_sheets')::integer,
      production_wastage = (v_totals ->> 'production_wastage')::integer,
      production_entries = (v_totals ->> 'entries')::integer,
      order_qty = v_order_qty,
      packed_qty = v_packed,
      remarks = v_remarks,
      updated_by_name = v_name
    where id = v_rec.id
    returning * into v_rec;
  else
    insert into public.wastage_records (job_id, order_no, job_name, ups, given_sheets, ok_sheets, separate_sheets,
      production_wastage, production_entries, order_qty, packed_qty, remarks, created_by_name, updated_by_name)
    values ((v_totals ->> 'job_id')::uuid, v_totals ->> 'order_no', v_totals ->> 'job_name', (v_totals ->> 'ups')::integer,
      (v_totals ->> 'given_sheets')::integer, (v_totals ->> 'ok_sheets')::integer, (v_totals ->> 'separate_sheets')::integer,
      (v_totals ->> 'production_wastage')::integer, (v_totals ->> 'entries')::integer, v_order_qty, v_packed, v_remarks, v_name, v_name)
    returning * into v_rec;
  end if;

  delete from public.wastage_lines where record_id = v_rec.id;
  v_n := 0;
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_process := nullif(regexp_replace(btrim(coalesce(v_line ->> 'process', '')), '\s+', ' ', 'g'), '');
    v_defect := nullif(regexp_replace(btrim(coalesce(v_line ->> 'defect', '')), '\s+', ' ', 'g'), '');
    v_reason := nullif(btrim(coalesce(v_line ->> 'reason', '')), '');
    v_qty := nullif(v_line ->> 'quantity', '')::integer;
    continue when v_process is null and v_defect is null and v_reason is null and v_qty is null;
    v_n := v_n + 1;
    insert into public.wastage_lines (record_id, line, process, defect, reason, quantity, unit)
    values (v_rec.id, v_n, v_process, v_defect, v_reason, v_qty, v_line ->> 'unit');
  end loop;

  return jsonb_build_object('ok', true, 'id', v_rec.id, 'record_no', v_rec.record_no, 'updated_at', v_rec.updated_at);
end;
$$;

alter table public.wastage_records enable row level security;
alter table public.wastage_lines enable row level security;
revoke all on public.wastage_records, public.wastage_lines from anon;
revoke insert, update on public.wastage_records, public.wastage_lines from authenticated;
revoke delete on public.wastage_lines from authenticated;

create policy wastage_records_select on public.wastage_records
  for select to authenticated using ((select public.has_perm('wastage', 'view')));
create policy wastage_lines_select on public.wastage_lines
  for select to authenticated using ((select public.has_perm('wastage', 'view')));
-- Deleting a record (with its lines) needs the Delete right (the Super Admin has it).
create policy wastage_records_delete on public.wastage_records
  for delete to authenticated using ((select public.has_perm('wastage', 'delete')));

revoke execute on function
  public.is_standard_colour(text),
  public.order_production_totals(text),
  public.wastage_order_options(),
  public.save_wastage_record(uuid, text, jsonb, jsonb, timestamptz)
  from public, anon;
grant execute on function
  public.is_standard_colour(text),
  public.order_production_totals(text),
  public.wastage_order_options(),
  public.save_wastage_record(uuid, text, jsonb, jsonb, timestamptz)
  to authenticated;
