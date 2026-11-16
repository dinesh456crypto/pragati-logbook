-- Production Order Number + CSO Number, coating per job, automatic colour / coating
-- changes, one Downtime (Man / Machine / Material / Others), ink formulas reused by
-- colour + paper + category, wastage in Pcs.
--
--   1. Jobs keep the Production Order Number (unique, column order_no) and gain a CSO
--      Number (shared by many jobs) and one Coating. Production entries keep a CSO too.
--   2. A planned job's coating fills the entry's coating and cannot be changed there.
--   3. No. of Colour Changes and Coating Changed? are worked out by the database from
--      the previous submitted entry on the same machine (unit by unit, 7 units).
--   4. "Make Ready" is called "Job Changeover" in messages (columns keep their names).
--   5. BDT and ODT become one Downtime with four reason groups; one permission.
--   6. Ink formulas: a colour (ignoring case and spaces) that already has a formula for
--      the same paper type and category is not asked again; orders that need no
--      formula are left out of the Ink Formula Entry list.
--   7. Wastage quantities are in Pcs (unit value 'pcs').

-- Colour codes compare without case or spaces: 'PMS 185' = 'pms185'.
create or replace function public.colour_key(p_colour text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(coalesce(p_colour, ''), '\s', '', 'g'));
$$;

-- ---------------------------------------------------------------------------
-- 1. Jobs: CSO Number and Coating
-- ---------------------------------------------------------------------------

alter table public.production_jobs
  add column cso_no text check (cso_no is null or length(btrim(cso_no)) between 1 and 60),
  add column coating_id uuid references public.coatings (id) on delete restrict;
create index production_jobs_cso_idx on public.production_jobs (lower(btrim(cso_no)));
create index production_jobs_coating_idx on public.production_jobs (coating_id);

alter table public.production_entries
  add column cso_no text check (cso_no is null or length(btrim(cso_no)) between 1 and 60);
create index production_entries_cso_idx on public.production_entries (lower(btrim(cso_no)));

-- Job Details save: same rules as before, plus CSO Number and Coating (both required).
create or replace function public.save_production_job(
  p_id uuid,
  p_job jsonb,
  p_sides jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.production_jobs;
  v_exists boolean := false;
  v_errors jsonb := '[]'::jsonb;
  v_id uuid;
  v_updated timestamptz;
  v_date date := nullif(p_job ->> 'plan_date', '')::date;
  v_order text := nullif(regexp_replace(btrim(coalesce(p_job ->> 'order_no', '')), '\s+', ' ', 'g'), '');
  v_name text := nullif(regexp_replace(btrim(coalesce(p_job ->> 'job_name', '')), '\s+', ' ', 'g'), '');
  v_cat text := nullif(regexp_replace(btrim(coalesce(p_job ->> 'category', '')), '\s+', ' ', 'g'), '');
  v_cso text := nullif(regexp_replace(btrim(coalesce(p_job ->> 'cso_no', '')), '\s+', ' ', 'g'), '');
  v_coating uuid := nullif(p_job ->> 'coating_id', '')::uuid;
  v_ups integer := nullif(p_job ->> 'ups', '')::integer;
  v_type text := nullif(p_job ->> 'job_type', '');
  v_paper uuid := nullif(p_job ->> 'paper_type_id', '')::uuid;
  v_qty integer := nullif(p_job ->> 'quantity', '')::integer;
  v_side jsonb;
  v_print text;
  v_colours text[];
  v_sides text[] := '{}';
  v_final jsonb := '[]'::jsonb; -- the slots to store, after the B/B rule
  v_bb jsonb;
  v_line integer := 0;
  v_removed text;
begin
  if not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_id is not null then
    select * into v_old from public.production_jobs where id = p_id for update;
    v_exists := found;
  end if;
  if v_exists then
    if not public.has_perm('production_plan', 'edit') then
      raise exception 'You do not have permission to edit jobs' using errcode = '42501';
    end if;
    if p_expected_updated_at is distinct from v_old.updated_at then
      return jsonb_build_object('ok', false, 'code', 'STALE',
        'message', 'This job was changed by someone else after you opened it. Close it and open it again.');
    end if;
  elsif not public.has_perm('production_plan', 'create') then
    raise exception 'You do not have permission to create jobs' using errcode = '42501';
  end if;

  if v_date is null then
    v_errors := v_errors || jsonb_build_object('field', 'plan_date', 'message', 'Date is required.');
  end if;
  if v_order is null then
    v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Production Order Number is required.');
  elsif length(v_order) > 60 then
    v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Production Order Number can be at most 60 characters.');
  elsif exists (select 1 from public.production_jobs j
                where lower(btrim(j.order_no)) = lower(v_order) and j.id is distinct from p_id) then
    v_errors := v_errors || jsonb_build_object('field', 'order_no',
      'message', format('Production Order Number %s already exists. Each production order can be planned only once.', v_order));
  elsif v_exists and lower(v_order) <> lower(btrim(v_old.order_no))
        and exists (select 1 from public.production_entries e where e.order_key = lower(btrim(v_old.order_no))) then
    v_errors := v_errors || jsonb_build_object('field', 'order_no',
      'message', 'Production entries already use this Production Order Number, so it cannot be changed.');
  end if;
  if v_name is null then
    v_errors := v_errors || jsonb_build_object('field', 'job_name', 'message', 'Job Name is required.');
  elsif length(v_name) > 150 then
    v_errors := v_errors || jsonb_build_object('field', 'job_name', 'message', 'Job Name can be at most 150 characters.');
  end if;
  if v_cat is null then
    v_errors := v_errors || jsonb_build_object('field', 'category', 'message', 'Category is required.');
  elsif length(v_cat) > 80 then
    v_errors := v_errors || jsonb_build_object('field', 'category', 'message', 'Category can be at most 80 characters.');
  end if;
  if v_cso is null then
    v_errors := v_errors || jsonb_build_object('field', 'cso_no', 'message', 'CSO Number is required.');
  elsif length(v_cso) > 60 then
    v_errors := v_errors || jsonb_build_object('field', 'cso_no', 'message', 'CSO Number can be at most 60 characters.');
  end if;
  if v_ups is null or v_ups <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'ups', 'message', 'UPS must be a whole number above zero.');
  end if;
  if v_type is null or v_type not in ('NPD', 'NEW', 'Re-Print') then
    v_errors := v_errors || jsonb_build_object('field', 'job_type', 'message', 'Select a Job Type.');
  end if;
  if v_paper is null or not exists (select 1 from public.paper_types p where p.id = v_paper) then
    v_errors := v_errors || jsonb_build_object('field', 'paper_type_id', 'message', 'Select a Type of Paper.');
  end if;
  if v_coating is null or not exists (select 1 from public.coatings c where c.id = v_coating) then
    v_errors := v_errors || jsonb_build_object('field', 'coating_id', 'message', 'Select a Coating.');
  end if;
  if v_qty is null or v_qty <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'quantity', 'message', 'Quantity must be a whole number of sheets above zero.');
  end if;

  if jsonb_array_length(coalesce(p_sides, '[]'::jsonb)) = 0 then
    v_errors := v_errors || jsonb_build_object('field', 'sides', 'message', 'Add at least one print side with its colours.');
  end if;
  for v_side in select value from jsonb_array_elements(coalesce(p_sides, '[]'::jsonb)) loop
    v_print := nullif(v_side ->> 'print_side', '');
    v_colours := array(
      select regexp_replace(btrim(c), '\s+', ' ', 'g')
      from jsonb_array_elements_text(coalesce(v_side -> 'colours', '[]'::jsonb)) with ordinality as t(c, n)
      where btrim(c) <> ''
      order by n);
    if v_print is null or v_print not in ('O/S', 'F/S', 'B/S', 'B/B F', 'B/B B') then
      v_errors := v_errors || jsonb_build_object('field', 'sides', 'message', 'Select the Print Side for every slot.');
    elsif v_print = any (v_sides) then
      v_errors := v_errors || jsonb_build_object('field', 'sides', 'message', format('%s is added more than once.', v_print));
    elsif v_print in ('B/B F', 'B/B B') and ('B/B F' = any (v_sides) or 'B/B B' = any (v_sides)) then
      null; -- B/B F and B/B B are one slot: the second one is ignored
    else
      v_sides := v_sides || v_print;
      v_final := v_final || jsonb_build_array(jsonb_build_object('print_side', v_print, 'colours', to_jsonb(v_colours)));
      if cardinality(v_colours) = 0 then
        v_errors := v_errors || jsonb_build_object('field', 'sides', 'message', format('%s: enter at least one colour.', v_print));
      elsif not public.colour_list_valid(v_colours) then
        v_errors := v_errors || jsonb_build_object('field', 'sides',
          'message', format('%s: each colour once, at most 40 characters.', v_print));
      end if;
    end if;
  end loop;
  -- B/B F and B/B B are printed in one go: planning either one plans both, with
  -- the same colours.
  select value into v_bb from jsonb_array_elements(v_final) where value ->> 'print_side' in ('B/B F', 'B/B B') limit 1;
  if v_bb is not null then
    v_final := v_final || jsonb_build_array(jsonb_build_object(
      'print_side', case when v_bb ->> 'print_side' = 'B/B F' then 'B/B B' else 'B/B F' end,
      'colours', v_bb -> 'colours'));
    v_sides := v_sides || case when v_bb ->> 'print_side' = 'B/B F' then 'B/B B' else 'B/B F' end;
  end if;

  if (select count(distinct public.side_family(s)) from unnest(v_sides) s) > 1 then
    v_errors := v_errors || jsonb_build_object('field', 'sides',
      'message', 'Print sides cannot be mixed: O/S stands alone; F/S pairs with B/S; B/B F pairs with B/B B.');
  end if;
  if v_exists then
    for v_removed in
      select s.print_side from public.production_job_sides s
      where s.job_id = v_old.id and not (s.print_side = any (v_sides))
    loop
      if exists (select 1 from public.production_entries e
                 where e.order_key = lower(btrim(v_old.order_no)) and e.print_side = v_removed) then
        v_errors := v_errors || jsonb_build_object('field', 'sides',
          'message', format('%s already has production entries, so it cannot be removed.', v_removed));
      end if;
    end loop;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
  end if;

  if v_exists then
    update public.production_jobs set
      plan_date = v_date, order_no = v_order, job_name = v_name, category = v_cat, ups = v_ups,
      job_type = v_type, paper_type_id = v_paper, quantity = v_qty, cso_no = v_cso, coating_id = v_coating
    where id = v_old.id
    returning id, updated_at into v_id, v_updated;
  else
    insert into public.production_jobs (plan_date, order_no, job_name, category, ups, job_type, paper_type_id, quantity, cso_no, coating_id)
    values (v_date, v_order, v_name, v_cat, v_ups, v_type, v_paper, v_qty, v_cso, v_coating)
    returning id, updated_at into v_id, v_updated;
  end if;

  delete from public.production_job_sides s where s.job_id = v_id and not (s.print_side = any (v_sides));
  for v_side in select value from jsonb_array_elements(v_final) loop
    v_line := v_line + 1;
    v_colours := array(
      select regexp_replace(btrim(c), '\s+', ' ', 'g')
      from jsonb_array_elements_text(coalesce(v_side -> 'colours', '[]'::jsonb)) with ordinality as t(c, n)
      where btrim(c) <> ''
      order by n);
    insert into public.production_job_sides (job_id, print_side, colours, line)
    values (v_id, v_side ->> 'print_side', v_colours, v_line)
    on conflict (job_id, print_side) do update set colours = excluded.colours, line = excluded.line;
  end loop;

  return jsonb_build_object('ok', true, 'id', v_id, 'updated_at', v_updated);
end;
$$;

-- Bulk upload: the template now has CSO Number and Coating (by name).
create or replace function public.import_production_jobs(p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_errors jsonb := '[]'::jsonb;
  v_row jsonb;
  v_n integer;
  v_date date;
  v_paper uuid;
  v_paper_active boolean;
  v_coating uuid;
  v_coating_active boolean;
  v_side text;
  v_colours jsonb;
  v_bs jsonb;
  v_sides jsonb;
  v_reply jsonb;
  v_err jsonb;
  v_count integer := 0;
  v_ok boolean;
  v_dups text[];
begin
  if not public.is_active_user() or not public.has_perm('production_plan', 'create') then
    raise exception 'You do not have permission to create jobs' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID',
      'errors', jsonb_build_array(jsonb_build_object('row', null, 'field', 'file', 'message', 'The file has no jobs to import.')));
  end if;
  if jsonb_array_length(p_rows) > 500 then
    return jsonb_build_object('ok', false, 'code', 'INVALID',
      'errors', jsonb_build_array(jsonb_build_object('row', null, 'field', 'file', 'message', 'Upload at most 500 jobs per file.')));
  end if;

  -- Order Numbers repeated inside the file.
  select array_agg(o) into v_dups from (
    select lower(regexp_replace(btrim(r ->> 'order_no'), '\s+', ' ', 'g')) o
    from jsonb_array_elements(p_rows) r
    where btrim(coalesce(r ->> 'order_no', '')) <> ''
    group by 1 having count(*) > 1
  ) d;

  begin
    for v_row in select value from jsonb_array_elements(p_rows) loop
      v_n := nullif(v_row ->> 'row', '')::integer;
      v_ok := true;

      -- Values the form would never send in the wrong shape.
      v_date := null;
      if btrim(coalesce(v_row ->> 'plan_date', '')) <> '' then
        begin
          v_date := (v_row ->> 'plan_date')::date;
        exception when others then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'plan_date', 'message', 'Date is not a valid date (use dd-mm-yyyy).');
          v_ok := false;
        end;
      end if;
      if coalesce(v_row ->> 'ups', '') !~ '^\s*\d{0,9}\s*$' then
        v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'ups', 'message', 'UPS must be a whole number above zero.');
        v_ok := false;
      end if;
      if coalesce(v_row ->> 'quantity', '') !~ '^\s*\d{0,9}\s*$' then
        v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'quantity', 'message', 'Quantity must be a whole number of sheets above zero.');
        v_ok := false;
      end if;
      if lower(regexp_replace(btrim(coalesce(v_row ->> 'order_no', '')), '\s+', ' ', 'g')) = any (coalesce(v_dups, '{}')) then
        v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'order_no',
          'message', format('Production Order Number %s appears more than once in the file.', btrim(v_row ->> 'order_no')));
        v_ok := false;
      end if;

      -- Type of Paper by name: must be an active paper type.
      v_paper := null;
      if btrim(coalesce(v_row ->> 'paper_type', '')) <> '' then
        select p.id, p.active into v_paper, v_paper_active
        from public.paper_types p
        where lower(btrim(p.name)) = lower(btrim(v_row ->> 'paper_type'))
        order by p.active desc
        limit 1;
        if v_paper is null then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'paper_type_id',
            'message', format('Type of Paper "%s" is not in the Paper Type master.', btrim(v_row ->> 'paper_type')));
          v_ok := false;
        elsif not v_paper_active then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'paper_type_id',
            'message', format('Type of Paper "%s" is inactive.', btrim(v_row ->> 'paper_type')));
          v_ok := false;
        end if;
      end if;

      -- Coating by name: must be an active coating.
      v_coating := null;
      if btrim(coalesce(v_row ->> 'coating', '')) <> '' then
        select c.id, c.active into v_coating, v_coating_active
        from public.coatings c
        where lower(btrim(c.name)) = lower(btrim(v_row ->> 'coating'))
        order by c.active desc
        limit 1;
        if v_coating is null then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'coating_id',
            'message', format('Coating "%s" is not in the Coating master.', btrim(v_row ->> 'coating')));
          v_ok := false;
        elsif not v_coating_active then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'coating_id',
            'message', format('Coating "%s" is inactive.', btrim(v_row ->> 'coating')));
          v_ok := false;
        end if;
      end if;

      -- Print side + colours -> the same slots the form sends.
      v_side := btrim(coalesce(v_row ->> 'print_side', ''));
      v_colours := public.split_colours(v_row ->> 'colours');
      v_bs := public.split_colours(v_row ->> 'bs_colours');
      v_sides := '[]'::jsonb;
      if v_side = '' then
        v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'sides', 'message', 'Print Side is required.');
        v_ok := false;
      elsif v_side not in ('O/S', 'F/S', 'B/S', 'F/S + B/S', 'B/B') then
        v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'sides',
          'message', format('Print Side "%s" is not allowed: use O/S, F/S, B/S, F/S + B/S or B/B.', v_side));
        v_ok := false;
      else
        if jsonb_array_length(v_colours) = 0 then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'colours', 'message', 'Colours are required.');
          v_ok := false;
        end if;
        if v_side = 'F/S + B/S' then
          if jsonb_array_length(v_bs) = 0 then
            v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'bs_colours', 'message', 'B/S Colours are required for F/S + B/S.');
            v_ok := false;
          end if;
          v_sides := jsonb_build_array(jsonb_build_object('print_side', 'F/S', 'colours', v_colours),
                                       jsonb_build_object('print_side', 'B/S', 'colours', v_bs));
        else
          if jsonb_array_length(v_bs) > 0 then
            v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'bs_colours',
              'message', 'B/S Colours are only for Print Side "F/S + B/S". Leave it empty or change the Print Side.');
            v_ok := false;
          end if;
          v_sides := jsonb_build_array(jsonb_build_object(
            'print_side', case v_side when 'B/B' then 'B/B F' else v_side end, 'colours', v_colours));
        end if;
      end if;

      -- Everything else: exactly the Job Details form's rules.
      v_reply := public.save_production_job(
        null,
        jsonb_build_object(
          'plan_date', v_date, 'order_no', v_row ->> 'order_no', 'job_name', v_row ->> 'job_name',
          'category', v_row ->> 'category', 'cso_no', v_row ->> 'cso_no', 'coating_id', v_coating,
          'ups', case when v_row ->> 'ups' ~ '^\s*\d{1,9}\s*$' then btrim(v_row ->> 'ups') end,
          'job_type', btrim(coalesce(v_row ->> 'job_type', '')),
          'paper_type_id', v_paper,
          'quantity', case when v_row ->> 'quantity' ~ '^\s*\d{1,9}\s*$' then btrim(v_row ->> 'quantity') end),
        v_sides);
      if not (v_reply ->> 'ok')::boolean then
        for v_err in select value from jsonb_array_elements(coalesce(v_reply -> 'errors', '[]'::jsonb)) loop
          -- Skip what was already reported above in clearer words.
          continue when v_err ->> 'field' = 'plan_date' and v_date is null and btrim(coalesce(v_row ->> 'plan_date', '')) <> '';
          continue when v_err ->> 'field' in ('ups', 'quantity') and coalesce(v_row ->> (v_err ->> 'field'), '') !~ '^\s*\d{0,9}\s*$';
          continue when v_err ->> 'field' = 'paper_type_id' and btrim(coalesce(v_row ->> 'paper_type', '')) <> '';
          continue when v_err ->> 'field' = 'coating_id' and btrim(coalesce(v_row ->> 'coating', '')) <> '';
          continue when v_err ->> 'field' = 'sides' and (v_side = '' or v_side not in ('O/S', 'F/S', 'B/S', 'F/S + B/S', 'B/B')
                                                          or v_err ->> 'message' like '%at least one colour%');
          continue when v_err ->> 'field' = 'order_no' and v_err ->> 'message' like '%already exists%'
                        and lower(regexp_replace(btrim(coalesce(v_row ->> 'order_no', '')), '\s+', ' ', 'g')) = any (coalesce(v_dups, '{}'));
          v_errors := v_errors || (v_err || jsonb_build_object('row', v_n));
        end loop;
        if jsonb_typeof(v_reply -> 'errors') is null then
          v_errors := v_errors || jsonb_build_object('row', v_n, 'field', 'row', 'message', coalesce(v_reply ->> 'message', 'Could not save this row.'));
        end if;
      elsif v_ok then
        v_count := v_count + 1;
      end if;
    end loop;

    if jsonb_array_length(v_errors) > 0 then
      raise exception using errcode = 'P0001', message = 'IMPORT_INVALID';
    end if;
    if p_dry_run then
      raise exception using errcode = 'P0001', message = 'IMPORT_DRY_RUN';
    end if;
  exception when sqlstate 'P0001' then
    -- Everything saved in this block is undone.
    if sqlerrm = 'IMPORT_INVALID' then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
    elsif sqlerrm = 'IMPORT_DRY_RUN' then
      return jsonb_build_object('ok', true, 'count', v_count, 'dry_run', true);
    end if;
    raise;
  end;

  return jsonb_build_object('ok', true, 'count', v_count, 'dry_run', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Downtime: one kind, reasons in four groups (Man, Machine, Material, Others)
-- ---------------------------------------------------------------------------

create table public.downtime_reasons (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('Man', 'Machine', 'Material', 'Others')),
  name text not null check (length(btrim(name)) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
create unique index downtime_reasons_name_unique on public.downtime_reasons (category, lower(btrim(name)));

create trigger downtime_reasons_audit_fields
before insert or update on public.downtime_reasons
for each row execute function public.set_audit_fields();
create trigger downtime_reasons_audit
after insert or update or delete on public.downtime_reasons
for each row execute function public.audit_row();

alter table public.downtime_reasons enable row level security;
revoke all on public.downtime_reasons from anon;
create policy downtime_reasons_select on public.downtime_reasons
  for select to authenticated using ((select public.is_active_user()));
create policy downtime_reasons_insert on public.downtime_reasons
  for insert to authenticated with check ((select public.has_perm('masters', 'create')));
create policy downtime_reasons_update on public.downtime_reasons
  for update to authenticated
  using ((select public.has_perm('masters', 'edit')))
  with check ((select public.has_perm('masters', 'edit')));
create policy downtime_reasons_delete on public.downtime_reasons
  for delete to authenticated using ((select public.has_perm('masters', 'delete')));

-- Four starting reasons per group (change them under Master).
insert into public.downtime_reasons (category, name) values
  ('Man', 'Operator not available'), ('Man', 'Shift handover'), ('Man', 'Tea / lunch break'), ('Man', 'Meeting or training'),
  ('Machine', 'Mechanical breakdown'), ('Machine', 'Electrical fault'), ('Machine', 'Plate change or damage'), ('Machine', 'Preventive maintenance'),
  ('Material', 'Waiting for sheets'), ('Material', 'Waiting for ink'), ('Material', 'Waiting for plates'), ('Material', 'Paper or board quality issue'),
  ('Others', 'Power cut'), ('Others', 'Waiting for approval'), ('Others', 'Cleaning'), ('Others', 'Other');

-- Existing records keep their reason: BDT reasons join Machine, ODT reasons join Others.
insert into public.downtime_reasons (category, name, active)
select 'Machine', b.name, b.active from public.bdt_reasons b
where exists (select 1 from public.downtime_events d where d.bdt_reason_id = b.id)
on conflict do nothing;
insert into public.downtime_reasons (category, name, active)
select 'Others', o.name, o.active from public.odt_reasons o
where exists (select 1 from public.downtime_events d where d.odt_reason_id = o.id)
on conflict do nothing;

alter table public.downtime_events add column reason_id uuid references public.downtime_reasons (id) on delete restrict;
create index downtime_events_reason_idx on public.downtime_events (reason_id);

do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.downtime_events'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.downtime_events drop constraint %I', c.conname);
  end loop;
end;
$$;

update public.downtime_events d set
  reason_id = (select r.id from public.downtime_reasons r join public.bdt_reasons b on lower(btrim(b.name)) = lower(btrim(r.name))
               where r.category = 'Machine' and b.id = d.bdt_reason_id),
  kind = 'Machine'
where d.kind = 'BDT';
update public.downtime_events d set
  reason_id = (select r.id from public.downtime_reasons r join public.odt_reasons o on lower(btrim(o.name)) = lower(btrim(r.name))
               where r.category = 'Others' and o.id = d.odt_reason_id),
  kind = 'Others'
where d.kind = 'ODT';

-- kind = the reason's group, set by the save functions (empty until a reason is chosen).
alter table public.downtime_events alter column kind drop not null;
alter table public.downtime_events
  add constraint downtime_events_kind_check check (kind is null or kind in ('Man', 'Machine', 'Material', 'Others'));
alter table public.downtime_events drop column bdt_reason_id, drop column odt_reason_id;
drop table public.bdt_reasons;
drop table public.odt_reasons;

-- Downtime minutes per group on each entry, for reports.
alter table public.production_entries
  add column man_minutes integer not null default 0,
  add column machine_minutes integer not null default 0,
  add column material_minutes integer not null default 0,
  add column other_minutes integer not null default 0;
update public.production_entries e set
  machine_minutes = e.bdt_minutes,
  other_minutes = e.odt_minutes;
alter table public.production_entries drop column bdt_minutes, drop column odt_minutes;

-- One permission: Downtime (anyone who had BDT or ODT keeps their rights).
insert into public.permission_resources (key, module, label, sort_order)
values ('downtime', 'Production', 'Downtime', 21)
on conflict (key) do nothing;
insert into public.user_permissions (profile_id, resource, can_view, can_create, can_edit, can_delete)
select profile_id, 'downtime', bool_or(can_view), bool_or(can_create), bool_or(can_edit), bool_or(can_delete)
from public.user_permissions where resource in ('bdt', 'odt')
group by profile_id
on conflict (profile_id, resource) do nothing;
delete from public.user_permissions where resource in ('bdt', 'odt');
delete from public.permission_resources where key in ('bdt', 'odt');

drop policy downtime_events_select on public.downtime_events;
drop policy downtime_events_delete on public.downtime_events;
create policy downtime_events_select on public.downtime_events
  for select to authenticated
  using (
    (select public.can_use_machine(machine_id))
    and (
      (select public.has_perm('downtime', 'view'))
      or (select public.has_perm('production_entry', 'view'))
      or (select public.has_perm('production_log', 'view'))
      or (select public.has_perm('dashboard', 'view'))
    )
  );
-- Only downtime between jobs is deleted directly; job downtime goes with its entry.
create policy downtime_events_delete on public.downtime_events
  for delete to authenticated
  using (
    entry_id is null
    and (select public.can_use_machine(machine_id))
    and (select public.has_perm('downtime', 'delete'))
  );

create or replace function public.downtime_clash(
  p_machine_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_skip_entry uuid,
  p_skip_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select format('downtime%s %s to %s %s', coalesce(' (' || d.kind || ')', ''),
           to_char(d.start_at at time zone 'Asia/Kolkata', 'DD-Mon-YYYY HH12:MI AM'),
           coalesce(to_char(d.end_at at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'), 'still open'),
           case when d.entry_id is null then '(recorded between jobs)'
                else format('(in production entry PE-%s)', lpad(e.entry_no::text, 5, '0')) end)
  from public.downtime_events d
  left join public.production_entries e on e.id = d.entry_id
  where d.machine_id = p_machine_id
    and d.start_at is not null and (d.end_at is null or d.end_at > d.start_at)
    and p_start is not null and (p_end is null or p_end > p_start)
    and (p_skip_entry is null or d.entry_id is distinct from p_skip_entry)
    and (p_skip_id is null or d.id <> p_skip_id)
    and tstzrange(d.start_at, coalesce(d.end_at, 'infinity'::timestamptz))
        && tstzrange(p_start, coalesce(p_end, 'infinity'::timestamptz))
  order by d.start_at
  limit 1;
$$;

-- Downtime between jobs: the reason decides the group.
create or replace function public.save_outside_downtime(
  p_id uuid,
  p_event jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.downtime_events;
  v_exists boolean := false;
  v_errors jsonb := '[]'::jsonb;
  v_kind text;
  v_machine uuid := nullif(p_event ->> 'machine_id', '')::uuid;
  v_start timestamptz := nullif(p_event ->> 'start_at', '')::timestamptz;
  v_end timestamptz := nullif(p_event ->> 'end_at', '')::timestamptz;
  v_reason uuid := nullif(p_event ->> 'reason_id', '')::uuid;
  v_remarks text := nullif(btrim(coalesce(p_event ->> 'remarks', '')), '');
  v_shift text;
  v_other public.production_entries;
  v_id uuid;
  v_updated timestamptz;
  v_clash text;
begin
  v_kind := (select r.category from public.downtime_reasons r where r.id = v_reason);
  if not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_id is not null then
    select * into v_old from public.downtime_events where id = p_id for update;
    v_exists := found;
  end if;
  if v_exists then
    if v_old.entry_id is not null then
      raise exception 'This downtime belongs to a production entry; change it there' using errcode = '22023';
    end if;
    if not public.has_perm('downtime', 'edit') or not public.can_use_machine(v_old.machine_id) then
      raise exception 'Not allowed' using errcode = '42501';
    end if;
    if p_expected_updated_at is distinct from v_old.updated_at then
      return jsonb_build_object('ok', false, 'code', 'STALE',
        'message', 'This record was changed by someone else after you opened it. Close it and open it again.');
    end if;
  elsif not public.has_perm('downtime', 'create') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if v_machine is null then
    v_errors := v_errors || jsonb_build_object('field', 'machine_id', 'message', 'Select a machine.');
  elsif not public.can_use_machine(v_machine) then
    raise exception 'You do not have access to this machine' using errcode = '42501';
  end if;
  if v_start is null then
    v_errors := v_errors || jsonb_build_object('field', 'start', 'message', 'Enter the Start date and time.');
  elsif v_start > now() + interval '5 minutes' then
    v_errors := v_errors || jsonb_build_object('field', 'start', 'message', 'Start cannot be in the future.');
  end if;
  if v_end is not null then
    if v_start is not null and v_end < v_start then
      v_errors := v_errors || jsonb_build_object('field', 'end', 'message', 'End is before Start. Check the dates and times.');
    elsif v_end > now() + interval '5 minutes' then
      v_errors := v_errors || jsonb_build_object('field', 'end', 'message', 'End cannot be in the future.');
    elsif v_start is not null and v_end - v_start > interval '7 days' then
      v_errors := v_errors || jsonb_build_object('field', 'end', 'message', 'Downtime longer than 7 days: check the dates.');
    end if;
  end if;
  if v_reason is null or v_kind is null then
    v_errors := v_errors || jsonb_build_object('field', 'reason_id', 'message', 'Select a downtime reason.');
  end if;
  if v_remarks is not null and length(v_remarks) > 500 then
    v_errors := v_errors || jsonb_build_object('field', 'remarks', 'message', 'Remarks can be at most 500 characters.');
  end if;

  -- Downtime between jobs cannot fall inside a submitted job on this machine.
  if v_machine is not null and v_start is not null and (v_end is null or v_end >= v_start) then
    select * into v_other from public.production_entries x
    where x.machine_id = v_machine and x.status = 'submitted' and x.run_end is not null
      and least(x.make_ready_start, x.registration_start, x.colour_matching_start, x.run_start) < coalesce(v_end, 'infinity'::timestamptz)
      and x.run_end > v_start
    order by x.run_end desc
    limit 1;
    if found then
      v_errors := v_errors || jsonb_build_object('field', 'start', 'message',
        format('This falls inside job PE-%s (production order %s, %s to %s). Record downtime during a job in that production entry.',
               lpad(v_other.entry_no::text, 5, '0'), v_other.order_no,
               to_char(least(v_other.make_ready_start, v_other.registration_start, v_other.colour_matching_start, v_other.run_start)
                       at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
               to_char(v_other.run_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
    end if;
  end if;

  -- One downtime record per machine at any moment.
  if v_machine is not null and v_start is not null and (v_end is null or v_end > v_start) then
    v_clash := public.downtime_clash(v_machine, v_start, v_end, null, case when v_exists then v_old.id end);
    if v_clash is not null then
      v_errors := v_errors || jsonb_build_object('field', 'start', 'message',
        format('This overlaps %s on the same machine. A machine can have only one downtime at a time.', v_clash));
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
  end if;

  v_shift := case when (v_start at time zone 'Asia/Kolkata')::time >= time '08:00'
                   and (v_start at time zone 'Asia/Kolkata')::time < time '16:30' then 'A' else 'B' end;

  if v_exists then
    update public.downtime_events set
      machine_id = v_machine, start_at = v_start, end_at = v_end, kind = v_kind, reason_id = v_reason,
      remarks = v_remarks, shift = v_shift, production_date = public.plant_production_date(v_start, v_shift)
    where id = v_old.id
    returning id, updated_at into v_id, v_updated;
  else
    insert into public.downtime_events (kind, machine_id, start_at, end_at, reason_id, remarks, shift, production_date)
    values (v_kind, v_machine, v_start, v_end, v_reason, v_remarks, v_shift, public.plant_production_date(v_start, v_shift))
    returning id, updated_at into v_id, v_updated;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'updated_at', v_updated);
end;
$$;

-- The previous job on the machine now also gives its unit colours and coating.
create or replace function public.machine_timeline(p_machine_id uuid, p_entry_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_prev public.production_entries;
  v_found boolean;
begin
  if p_machine_id is null or not public.has_perm('production_entry', 'view') or not public.can_use_machine(p_machine_id) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  -- For an entry that already has times, look at what came before it.
  select least(e.make_ready_start, e.registration_start, e.colour_matching_start, e.run_start) into v_start
  from public.production_entries e where e.id = p_entry_id;

  select * into v_prev from public.production_entries x
  where x.machine_id = p_machine_id and x.status = 'submitted' and x.id is distinct from p_entry_id
    and x.run_end is not null and (v_start is null or x.run_end <= v_start)
  order by x.run_end desc
  limit 1;
  v_found := found;

  return jsonb_build_object(
    'previous', case when v_found then jsonb_build_object('id', v_prev.id, 'entry_no', v_prev.entry_no,
      'order_no', v_prev.order_no, 'job_name', v_prev.job_name, 'print_side', v_prev.print_side, 'run_end', v_prev.run_end,
      'unit_colours', to_jsonb(v_prev.unit_colours), 'coating_id', v_prev.coating_id,
      'coating', (select c.name from public.coatings c where c.id = v_prev.coating_id)) end,
    'downtime', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'start_at', d.start_at, 'end_at', d.end_at,
               'minutes', d.minutes, 'reason', r.name) order by d.start_at), '[]'::jsonb)
      from public.downtime_events d
      left join public.downtime_reasons r on r.id = d.reason_id
      where d.machine_id = p_machine_id and d.entry_id is null and d.end_at is not null
        and (not v_found or d.start_at >= v_prev.run_end)
        and (v_start is null or d.end_at <= v_start)
        and (v_found or d.end_at > now() - interval '2 days')),
    'open_downtime', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'start_at', d.start_at) order by d.start_at), '[]'::jsonb)
      from public.downtime_events d
      where d.machine_id = p_machine_id and d.entry_id is null and d.end_at is null),
    'ready_at', public.machine_ready_after(p_machine_id, case when v_found then v_prev.run_end end, v_start));
end;
$$;

create or replace function public.downtime_counted(p_from date, p_to date, p_machine_id uuid default null)
returns table (
  id uuid, kind text, machine_id uuid, entry_id uuid, production_date date, shift text,
  start_at timestamptz, end_at timestamptz, minutes integer, counted_minutes integer,
  reason text, remarks text
)
language sql
stable
set search_path = ''
as $$
  with w as (
    select n.machine_id, range_agg(tstzrange(n.starts_at, n.ends_at)) as night
    from public.night_windows(p_from - 1, p_to + 1) n
    where n.ends_at > n.starts_at
    group by n.machine_id
  )
  select d.id, d.kind, d.machine_id, d.entry_id, d.production_date, d.shift, d.start_at, d.end_at, d.minutes,
         greatest(0, round((extract(epoch from (d.end_at - d.start_at)) - public.overlap_seconds(w.night, d.start_at, d.end_at)) / 60))::integer,
         r.name, d.remarks
  from public.downtime_events d
  left join w on w.machine_id = d.machine_id
  left join public.downtime_reasons r on r.id = d.reason_id
  where d.production_date between p_from and p_to
    and d.start_at is not null and d.end_at is not null
    and (p_machine_id is null or d.machine_id = p_machine_id);
$$;

create or replace function public.dashboard_figures(p_from date, p_to date, p_machine_id uuid default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with e as (
    select x.* from public.production_entries x
    where x.status = 'submitted' and x.production_date between p_from and p_to
      and (p_machine_id is null or x.machine_id = p_machine_id)
  ),
  d as (select * from public.downtime_counted(p_from, p_to, p_machine_id)),
  m as (
    select mc.id, mc.code, mc.name, mc.sort_order from public.machines mc
    where (p_machine_id is null or mc.id = p_machine_id)
      and (mc.active or exists (select 1 from e where e.machine_id = mc.id) or exists (select 1 from d where d.machine_id = mc.id))
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'entries', count(*),
        'jobs_ran', count(distinct e.order_key),
        'given', coalesce(sum(e.total_sheets), 0),
        'ok', coalesce(sum(e.ok_sheets), 0),
        'separate', coalesce(sum(e.separate_sheets), 0),
        'wastage', coalesce(sum(e.wastage_sheets), 0),
        'changeover_gross', coalesce(sum(e.changeover_gross_minutes), 0),
        'changeover_net', coalesce(sum(e.changeover_net_minutes), 0),
        'run_gross', coalesce(sum(e.run_minutes), 0),
        'run_net', coalesce(sum(e.run_net_minutes), 0),
        'downtime', (select coalesce(sum(d.counted_minutes), 0) from d),
        'man', (select coalesce(sum(d.counted_minutes), 0) from d where d.kind = 'Man'),
        'machine', (select coalesce(sum(d.counted_minutes), 0) from d where d.kind = 'Machine'),
        'material', (select coalesce(sum(d.counted_minutes), 0) from d where d.kind = 'Material'),
        'others', (select coalesce(sum(d.counted_minutes), 0) from d where d.kind = 'Others'),
        'night_excluded', (select coalesce(sum(d.minutes - d.counted_minutes), 0) from d))
      from e),
    'machines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'machine_id', m.id, 'code', m.code, 'name', m.name,
        'entries', (select count(*) from e where e.machine_id = m.id),
        'jobs_ran', (select count(distinct e.order_key) from e where e.machine_id = m.id),
        'given', (select coalesce(sum(e.total_sheets), 0) from e where e.machine_id = m.id),
        'ok', (select coalesce(sum(e.ok_sheets), 0) from e where e.machine_id = m.id),
        'wastage', (select coalesce(sum(e.wastage_sheets), 0) from e where e.machine_id = m.id),
        'changeover_gross', (select coalesce(sum(e.changeover_gross_minutes), 0) from e where e.machine_id = m.id),
        'changeover_net', (select coalesce(sum(e.changeover_net_minutes), 0) from e where e.machine_id = m.id),
        'run_gross', (select coalesce(sum(e.run_minutes), 0) from e where e.machine_id = m.id),
        'run_net', (select coalesce(sum(e.run_net_minutes), 0) from e where e.machine_id = m.id),
        'downtime', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id),
        'man', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id and d.kind = 'Man'),
        'machine', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id and d.kind = 'Machine'),
        'material', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id and d.kind = 'Material'),
        'others', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id and d.kind = 'Others'))
        order by m.sort_order, m.code), '[]'::jsonb)
      from m),
    'by_date', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', x.production_date, 'entries', x.entries, 'given', x.given, 'ok', x.ok, 'wastage', x.wastage, 'run_gross', x.run_gross)
        order by x.production_date desc), '[]'::jsonb)
      from (select e.production_date, count(*) as entries, sum(e.total_sheets) as given, sum(e.ok_sheets) as ok,
                   sum(e.wastage_sheets) as wastage, sum(e.run_minutes) as run_gross
            from e group by e.production_date) x));
$$;

-- Order details for the entry form now include CSO Number and Coating.
create or replace function public.production_order_status(p_order_no text, p_machine_id uuid, p_entry_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(p_order_no));
  v_job jsonb;
  v_last jsonb;
  v_sides jsonb;
  v_prev jsonb;
begin
  if not public.has_perm('production_entry', 'view')
     or (p_machine_id is not null and not public.can_use_machine(p_machine_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_key is null or v_key = '' then
    return jsonb_build_object();
  end if;

  select jsonb_build_object('id', j.id, 'order_no', j.order_no, 'cso_no', j.cso_no, 'coating_id', j.coating_id,
           'job_name', j.job_name, 'category', j.category,
           'ups', j.ups, 'job_type', j.job_type, 'paper_type_id', j.paper_type_id, 'quantity', j.quantity,
           'sides', (select coalesce(jsonb_agg(jsonb_build_object('print_side', s.print_side, 'colours', to_jsonb(s.colours))
                                              order by s.line), '[]'::jsonb)
                     from public.production_job_sides s where s.job_id = j.id))
    into v_job
  from public.production_jobs j where lower(btrim(j.order_no)) = v_key;

  -- For an unplanned order: the latest submitted entry's details, with each
  -- print side's colours from its latest entry.
  select jsonb_build_object('order_no', e.order_no, 'cso_no', e.cso_no, 'coating_id', e.coating_id,
           'job_name', e.job_name, 'category', e.category, 'ups', e.ups,
           'job_type', e.job_type, 'paper_type_id', e.paper_type_id, 'quantity', e.planned_quantity,
           'sides', (select coalesce(jsonb_agg(jsonb_build_object('print_side', s.print_side, 'colours', to_jsonb(s.planned_colours))), '[]'::jsonb)
                     from (select distinct on (x.print_side) x.print_side, x.planned_colours
                           from public.production_entries x
                           where x.order_key = v_key and x.status = 'submitted' and x.print_side is not null
                             and x.id is distinct from p_entry_id
                           order by x.print_side, x.created_at desc) s))
    into v_last
  from public.production_entries e
  where e.order_key = v_key and e.status = 'submitted' and e.id is distinct from p_entry_id
  order by e.created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'side', s.print_side, 'entries', s.entries, 'ok_sheets', s.ok_sheets, 'total_sheets', s.total_sheets,
           'closed', exists (select 1 from public.order_side_closures c where c.order_key = v_key and c.print_side = s.print_side))
         order by s.print_side), '[]'::jsonb)
    into v_sides
  from (
    select e.print_side, count(*) as entries, sum(e.ok_sheets) as ok_sheets, sum(e.total_sheets) as total_sheets
    from public.production_entries e
    where e.order_key = v_key and e.status = 'submitted' and e.print_side is not null and e.id is distinct from p_entry_id
    group by e.print_side
  ) s;

  if p_machine_id is not null then
    select jsonb_build_object('id', e.id, 'entry_no', e.entry_no, 'print_side', e.print_side,
             'production_date', e.production_date, 'shift', e.shift, 'run_end', e.run_end)
      into v_prev
    from public.production_entries e
    where e.order_key = v_key and e.machine_id = p_machine_id and e.status = 'submitted'
      and e.id is distinct from p_entry_id
    order by e.created_at desc limit 1;
  end if;

  return jsonb_build_object(
    'order_key', v_key,
    'job', v_job,
    'last_entry_job', v_last,
    'sides', v_sides,
    'closed_sides', to_jsonb(array(select c.print_side from public.order_side_closures c where c.order_key = v_key order by 1)),
    'fully_closed', public.order_fully_closed(v_key),
    'is_first', public.is_first_order_entry(v_key, p_entry_id),
    'previous_on_machine', v_prev);
end;
$$;

drop function public.production_order_options();
create or replace function public.production_order_options()
returns table (order_no text, cso_no text, job_name text, plan_date date, planned boolean, sides_used text[], sides_closed text[])
language sql
stable
security definer
set search_path = ''
as $$
  with orders as (
    select lower(btrim(j.order_no)) as k, j.order_no, j.cso_no, j.job_name, j.plan_date, true as planned
    from public.production_jobs j
    union all
    select * from (
      select distinct on (e.order_key) e.order_key, e.order_no, e.cso_no, e.job_name, e.production_date, false
      from public.production_entries e
      where e.status = 'submitted' and e.order_key is not null
        and not exists (select 1 from public.production_jobs j where lower(btrim(j.order_no)) = e.order_key)
      order by e.order_key, e.created_at desc
    ) manual
  )
  select o.order_no, o.cso_no, o.job_name, o.plan_date, o.planned,
    array(select distinct e.print_side from public.production_entries e
          where e.order_key = o.k and e.status = 'submitted' and e.print_side is not null order by 1),
    array(select c.print_side from public.order_side_closures c where c.order_key = o.k order by 1)
  from orders o
  where public.has_perm('production_entry', 'view')
    and not public.order_fully_closed(o.k)
  order by o.plan_date desc nulls last, o.order_no;
$$;
revoke execute on function public.production_order_options() from public, anon;
grant execute on function public.production_order_options() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Production entry: CSO, coating from the plan, automatic colour / coating changes,
--    downtime by reason group
-- ---------------------------------------------------------------------------

create or replace function public.save_production_entry(
  p_id uuid,
  p_save_id uuid,
  p_submit boolean,
  p_entry jsonb,
  p_wastage jsonb default '[]'::jsonb,
  p_expected_updated_at timestamptz default null,
  p_close_side boolean default false,
  p_downtime jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.production_entries;
  v_new public.production_entries;
  v_exists boolean;
  v_submit boolean;
  v_errors jsonb := '[]'::jsonb;
  v_key text;
  v_first boolean;
  v_required boolean;
  v_draft public.production_entries;
  v_other public.production_entries;
  v_wastage_total integer := 0;
  v_row jsonb;
  v_line integer := 0;
  v_qty integer;
  v_reason uuid;
  v_colour text;
  v_seen text[] := '{}';
  v_planned text[];
  v_latest_changeover timestamptz;
  v_window_start timestamptz;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_mins integer;
  v_label text;
  v_pair record;
  v_job_id uuid;
  v_side_colours text[];
  v_side_found boolean := false;
  v_ev jsonb;
  v_kind text;
  v_ev_start timestamptz;
  v_ev_end timestamptz;
  v_ev_reason uuid;
  v_chain timestamptz;
  v_downtime tstzmultirange;
  v_prev public.production_entries;
  v_outside public.downtime_events;
  v_seen_ranges tstzrange[] := '{}';
  v_range tstzrange;
  v_clash text;
  v_job public.production_jobs;
  v_prev_found boolean := false;
  v_ev_kind text;
begin
  if p_id is null or p_save_id is null or p_entry is null then
    raise exception 'Missing entry id, save id or entry data' using errcode = '22023';
  end if;
  if not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_old from public.production_entries where id = p_id for update;
  v_exists := found;

  if v_exists then
    -- The same save arriving twice (lost response, retry) is applied once.
    if v_old.last_save_id = p_save_id then
      return jsonb_build_object('ok', true, 'id', v_old.id, 'entry_no', v_old.entry_no,
        'status', v_old.status, 'updated_at', v_old.updated_at, 'repeat', true);
    end if;
    if not public.can_use_machine(v_old.machine_id) then
      raise exception 'You do not have access to this machine' using errcode = '42501';
    end if;
    if v_old.status = 'submitted' and not public.has_perm('production_entry', 'edit') then
      raise exception 'You do not have permission to edit submitted entries' using errcode = '42501';
    end if;
    if v_old.status = 'draft'
       and not (public.has_perm('production_entry', 'create') or public.has_perm('production_entry', 'edit')) then
      raise exception 'You do not have permission to edit drafts' using errcode = '42501';
    end if;
    if p_expected_updated_at is distinct from v_old.updated_at then
      return jsonb_build_object('ok', false, 'code', 'STALE',
        'message', 'This entry was changed by someone else after you opened it. Reopen it to see the latest version.');
    end if;
    v_new := v_old;
  else
    if not public.has_perm('production_entry', 'create') then
      raise exception 'You do not have permission to create production entries' using errcode = '42501';
    end if;
    v_new.id := p_id;
    v_new.continuing := false;
    v_new.unit_colours := array[null, null, null, null, null, null, null]::text[];
  end if;

  -- A submitted entry stays submitted; edits to it are checked like a submission.
  v_submit := coalesce(p_submit, false) or (v_exists and v_old.status = 'submitted');

  -- Copy the form values.
  v_new.machine_id := nullif(p_entry ->> 'machine_id', '')::uuid;
  v_new.production_date := nullif(p_entry ->> 'production_date', '')::date;
  v_new.shift := nullif(p_entry ->> 'shift', '');
  v_new.order_no := nullif(regexp_replace(btrim(coalesce(p_entry ->> 'order_no', '')), '\s+', ' ', 'g'), '');
  v_new.cso_no := nullif(regexp_replace(btrim(coalesce(p_entry ->> 'cso_no', '')), '\s+', ' ', 'g'), '');
  v_new.job_name := nullif(regexp_replace(btrim(coalesce(p_entry ->> 'job_name', '')), '\s+', ' ', 'g'), '');
  v_new.category := nullif(regexp_replace(btrim(coalesce(p_entry ->> 'category', '')), '\s+', ' ', 'g'), '');
  v_new.ups := nullif(p_entry ->> 'ups', '')::integer;
  v_new.job_type := nullif(p_entry ->> 'job_type', '');
  v_new.paper_type_id := nullif(p_entry ->> 'paper_type_id', '')::uuid;
  v_new.planned_quantity := nullif(p_entry ->> 'planned_quantity', '')::integer;
  v_new.print_side := nullif(p_entry ->> 'print_side', '');
  v_new.continuing := coalesce((p_entry ->> 'continuing')::boolean, false);
  v_new.operator_id := nullif(p_entry ->> 'operator_id', '')::uuid;
  v_new.supervisor_id := nullif(p_entry ->> 'supervisor_id', '')::uuid;
  v_new.qc_executive_id := nullif(p_entry ->> 'qc_executive_id', '')::uuid;
  v_new.helpers := nullif(p_entry ->> 'helpers', '')::integer;
  v_new.coating_id := nullif(p_entry ->> 'coating_id', '')::uuid;
  v_new.make_ready_start := nullif(p_entry ->> 'make_ready_start', '')::timestamptz;
  v_new.make_ready_end := nullif(p_entry ->> 'make_ready_end', '')::timestamptz;
  v_new.registration_start := nullif(p_entry ->> 'registration_start', '')::timestamptz;
  v_new.registration_end := nullif(p_entry ->> 'registration_end', '')::timestamptz;
  v_new.colour_matching_start := nullif(p_entry ->> 'colour_matching_start', '')::timestamptz;
  v_new.colour_matching_end := nullif(p_entry ->> 'colour_matching_end', '')::timestamptz;
  v_new.run_start := nullif(p_entry ->> 'run_start', '')::timestamptz;
  v_new.run_end := nullif(p_entry ->> 'run_end', '')::timestamptz;
  v_new.machine_speed := nullif(p_entry ->> 'machine_speed', '')::integer;
  v_new.total_sheets := nullif(p_entry ->> 'total_sheets', '')::integer;
  v_new.ok_sheets := nullif(p_entry ->> 'ok_sheets', '')::integer;
  v_new.separate_sheets := nullif(p_entry ->> 'separate_sheets', '')::integer;
  v_new.remarks := nullif(btrim(coalesce(p_entry ->> 'remarks', '')), '');

  -- Job colours: tidied, empty ones dropped.
  v_new.planned_colours := array(
    select regexp_replace(btrim(c), '\s+', ' ', 'g')
    from jsonb_array_elements_text(coalesce(p_entry -> 'planned_colours', '[]'::jsonb)) with ordinality as t(c, n)
    where btrim(c) <> ''
    order by n);
  -- Unit 1..7 colours: always seven slots.
  v_new.unit_colours := array(
    select nullif(regexp_replace(btrim(coalesce(p_entry -> 'unit_colours' ->> (i - 1), '')), '\s+', ' ', 'g'), '')
    from generate_series(1, 7) as i
    order by i);

  v_key := lower(btrim(v_new.order_no));
  v_new.manual_starts := array(
    select distinct s from jsonb_array_elements_text(coalesce(p_entry -> 'manual_starts', '[]'::jsonb)) as t(s)
    where s in ('make_ready', 'registration', 'colour_matching', 'run'));

  -- A planned order's colours come from the plan's slot for the chosen print side,
  -- so colours of other sides or other orders can never be used.
  v_job_id := (select j.id from public.production_jobs j where lower(btrim(j.order_no)) = v_key);
  if v_job_id is not null then
    select * into v_job from public.production_jobs j where j.id = v_job_id;
    v_new.cso_no := coalesce(v_job.cso_no, v_new.cso_no);
    v_new.coating_id := coalesce(v_job.coating_id, v_new.coating_id);
  end if;
  if v_job_id is not null and v_new.print_side is not null then
    select s.colours into v_side_colours from public.production_job_sides s
    where s.job_id = v_job_id and s.print_side = v_new.print_side;
    v_side_found := found;
    if v_side_found then
      v_new.planned_colours := v_side_colours;
    end if;
  end if;

  -- ---- Checks that apply to drafts too ----------------------------------------
  if v_new.machine_id is null then
    v_errors := v_errors || jsonb_build_object('field', 'machine_id', 'message', 'Select a machine.');
  elsif not public.can_use_machine(v_new.machine_id) then
    raise exception 'You do not have access to this machine' using errcode = '42501';
  elsif not exists (select 1 from public.machines m where m.id = v_new.machine_id
                    and (m.active or (v_exists and m.id = v_old.machine_id))) then
    v_errors := v_errors || jsonb_build_object('field', 'machine_id', 'message', 'This machine is inactive.');
  end if;
  if v_new.production_date is null then
    v_errors := v_errors || jsonb_build_object('field', 'production_date', 'message', 'Production Date is required.');
  end if;
  if v_new.order_no is not null and length(v_new.order_no) > 60 then
    v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Production Order Number can be at most 60 characters.');
  end if;
  if v_new.cso_no is not null and length(v_new.cso_no) > 60 then
    v_errors := v_errors || jsonb_build_object('field', 'cso_no', 'message', 'CSO Number can be at most 60 characters.');
  end if;
  if v_new.job_name is not null and length(v_new.job_name) > 150 then
    v_errors := v_errors || jsonb_build_object('field', 'job_name', 'message', 'Job Name can be at most 150 characters.');
  end if;
  if v_new.category is not null and length(v_new.category) > 80 then
    v_errors := v_errors || jsonb_build_object('field', 'category', 'message', 'Category can be at most 80 characters.');
  end if;
  if v_new.ups is not null and v_new.ups <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'ups', 'message', 'UPS must be above zero.');
  end if;
  if v_new.planned_quantity is not null and v_new.planned_quantity <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'planned_quantity', 'message', 'Planned quantity must be above zero.');
  end if;
  if v_new.shift is not null and v_new.shift not in ('A', 'B') then
    v_errors := v_errors || jsonb_build_object('field', 'shift', 'message', 'Shift must be A or B.');
  end if;
  if v_new.job_type is not null and v_new.job_type not in ('NPD', 'NEW', 'Re-Print') then
    v_errors := v_errors || jsonb_build_object('field', 'job_type', 'message', 'Job Type must be NPD, NEW or Re-Print.');
  end if;
  if v_new.print_side is not null and v_new.print_side not in ('O/S', 'F/S', 'B/S', 'B/B F', 'B/B B') then
    v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message', 'Unknown print side.');
  end if;
  if v_new.helpers is not null and v_new.helpers not between 1 and 4 then
    v_errors := v_errors || jsonb_build_object('field', 'helpers', 'message', 'No. of Helpers must be 1 to 4.');
  end if;
  if v_new.machine_speed is not null and v_new.machine_speed not between 0 and 100000 then
    v_errors := v_errors || jsonb_build_object('field', 'machine_speed', 'message', 'Machine Speed cannot be negative.');
  end if;
  if v_new.total_sheets is not null and v_new.total_sheets not between 1 and 10000000 then
    v_errors := v_errors || jsonb_build_object('field', 'total_sheets', 'message', 'Total Given Sheets must be above zero.');
  end if;
  if v_new.ok_sheets is not null and v_new.ok_sheets not between 0 and 10000000 then
    v_errors := v_errors || jsonb_build_object('field', 'ok_sheets', 'message', 'OK Sheets cannot be negative.');
  end if;
  if v_new.separate_sheets is not null and v_new.separate_sheets not between 0 and 10000000 then
    v_errors := v_errors || jsonb_build_object('field', 'separate_sheets', 'message', 'Separate Sheets cannot be negative.');
  end if;
  if v_new.remarks is not null and length(v_new.remarks) > 1000 then
    v_errors := v_errors || jsonb_build_object('field', 'remarks', 'message', 'Remarks can be at most 1000 characters.');
  end if;
  if not public.colour_list_valid(v_new.planned_colours) then
    v_errors := v_errors || jsonb_build_object('field', 'planned_colours',
      'message', 'Job colours: each colour once, at most 40 characters.');
  end if;

  -- Unit colours: each used once.
  foreach v_colour in array v_new.unit_colours loop
    if v_colour is not null then
      if lower(v_colour) = any (v_seen) then
        v_errors := v_errors || jsonb_build_object('field', 'unit_colours',
          'message', format('Colour %s is allocated to more than one unit.', v_colour));
      end if;
      v_seen := v_seen || lower(v_colour);
    end if;
  end loop;

  -- Each time pair: the end cannot be before the start.
  for v_pair in
    select * from (values
      ('make_ready', 'Job Changeover', v_new.make_ready_start, v_new.make_ready_end),
      ('registration', 'Registration', v_new.registration_start, v_new.registration_end),
      ('colour_matching', 'Colour Matching', v_new.colour_matching_start, v_new.colour_matching_end),
      ('run', 'Production Time', v_new.run_start, v_new.run_end)
    ) as t(field, label, s, e)
  loop
    if v_pair.s is not null and v_pair.e is not null and v_pair.e < v_pair.s then
      v_errors := v_errors || jsonb_build_object('field', v_pair.field,
        'message', format('%s: End is before Start. Check the dates and times.', v_pair.label));
    end if;
  end loop;

  -- The steps follow each other: each starts once the earlier steps have ended.
  v_chain := null;
  for v_pair in
    select * from (values
      ('make_ready', 'Job Changeover', v_new.make_ready_start, v_new.make_ready_end),
      ('registration', 'Registration', v_new.registration_start, v_new.registration_end),
      ('colour_matching', 'Colour Matching', v_new.colour_matching_start, v_new.colour_matching_end),
      ('run', 'Production', v_new.run_start, v_new.run_end)
    ) as t(field, label, s, e)
  loop
    if v_pair.s is not null and v_chain is not null and v_pair.s < v_chain then
      v_errors := v_errors || jsonb_build_object('field', v_pair.field,
        'message', format('%s cannot start before the previous step ends (%s).', v_pair.label,
                          to_char(v_chain at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
    end if;
    v_chain := greatest(v_chain, v_pair.s, v_pair.e);
  end loop;

  -- Wastage rows.
  for v_row in select value from jsonb_array_elements(coalesce(p_wastage, '[]'::jsonb)) loop
    v_qty := nullif(v_row ->> 'quantity', '')::integer;
    v_reason := nullif(v_row ->> 'reason_id', '')::uuid;
    continue when v_qty is null and v_reason is null;
    if v_qty is not null and v_qty not between 1 and 10000000 then
      v_errors := v_errors || jsonb_build_object('field', 'wastage', 'message', 'Each wastage quantity must be above zero.');
    end if;
    v_wastage_total := v_wastage_total + coalesce(v_qty, 0);
  end loop;

  -- Downtime rows (inside this job).
  for v_ev in select value from jsonb_array_elements(coalesce(p_downtime, '[]'::jsonb)) loop
    v_ev_start := nullif(v_ev ->> 'start_at', '')::timestamptz;
    v_ev_end := nullif(v_ev ->> 'end_at', '')::timestamptz;
    v_ev_reason := nullif(v_ev ->> 'reason_id', '')::uuid;
    continue when v_ev_start is null and v_ev_end is null and v_ev_reason is null;
    if v_ev_reason is not null and not exists (select 1 from public.downtime_reasons r where r.id = v_ev_reason) then
      v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'A downtime reason was not found. Choose it again.');
    end if;
    if v_ev_start is not null and v_ev_end is not null and v_ev_end < v_ev_start then
      v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Downtime: End is before Start. Check the dates and times.');
    end if;
    if (v_ev ->> 'remarks') is not null and length(v_ev ->> 'remarks') > 500 then
      v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Downtime remarks can be at most 500 characters.');
    end if;

    -- One downtime record per machine at any moment: not overlapping another row
    -- of this job, nor downtime recorded elsewhere on this machine.
    if v_ev_start is not null and (v_ev_end is null or v_ev_end > v_ev_start) then
      v_range := tstzrange(v_ev_start, coalesce(v_ev_end, 'infinity'::timestamptz));
      if exists (select 1 from unnest(v_seen_ranges) r where r && v_range) then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message',
          format('Downtime from %s overlaps another downtime row of this job. A machine can have only one downtime at a time.',
                 to_char(v_ev_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
      end if;
      v_seen_ranges := v_seen_ranges || v_range;
      if v_new.machine_id is not null then
        v_clash := public.downtime_clash(v_new.machine_id, v_ev_start, v_ev_end, v_new.id, null);
        if v_clash is not null then
          v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message',
            format('Downtime from %s overlaps %s on this machine. A machine can have only one downtime at a time.',
                   to_char(v_ev_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'), v_clash));
        end if;
      end if;
    end if;
  end loop;

  v_window_start := least(v_new.make_ready_start, v_new.registration_start, v_new.colour_matching_start, v_new.run_start);

  -- ---- Checks for a final (submitted) entry ----------------------------------
  if v_submit then
    if v_new.production_date > v_today then
      v_errors := v_errors || jsonb_build_object('field', 'production_date', 'message', 'Production Date cannot be in the future.');
    end if;
    if v_new.shift is null then
      v_errors := v_errors || jsonb_build_object('field', 'shift', 'message', 'Select the shift.');
    end if;
    if v_new.order_no is null then
      v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Production Order Number is required.');
    end if;
    if v_new.cso_no is null then
      v_errors := v_errors || jsonb_build_object('field', 'cso_no', 'message', 'CSO Number is required.');
    end if;
    if v_new.job_name is null then
      v_errors := v_errors || jsonb_build_object('field', 'job_name', 'message', 'Job Name is required.');
    end if;
    if v_new.category is null then
      v_errors := v_errors || jsonb_build_object('field', 'category', 'message', 'Category is required.');
    end if;
    if v_new.ups is null then
      v_errors := v_errors || jsonb_build_object('field', 'ups', 'message', 'UPS is required.');
    end if;
    if v_new.job_type is null then
      v_errors := v_errors || jsonb_build_object('field', 'job_type', 'message', 'Select the Job Type.');
    end if;
    if v_new.paper_type_id is null then
      v_errors := v_errors || jsonb_build_object('field', 'paper_type_id', 'message', 'Select the Type of Paper.');
    end if;
    if v_new.print_side is null then
      v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message', 'Select the Print Side.');
    end if;
    if v_new.operator_id is null then
      v_errors := v_errors || jsonb_build_object('field', 'operator_id', 'message', 'Select the Operator.');
    end if;
    if v_new.supervisor_id is null then
      v_errors := v_errors || jsonb_build_object('field', 'supervisor_id', 'message', 'Select the Supervisor.');
    end if;
    if v_new.qc_executive_id is null then
      v_errors := v_errors || jsonb_build_object('field', 'qc_executive_id', 'message', 'Select the QC Executive.');
    end if;
    if v_new.helpers is null then
      v_errors := v_errors || jsonb_build_object('field', 'helpers', 'message', 'Select the No. of Helpers.');
    end if;
    if v_new.coating_id is null then
      v_errors := v_errors || jsonb_build_object('field', 'coating_id', 'message', 'Select the Coating.');
    end if;

    -- Unit colours must come from this job's colours, at least one unit used.
    if cardinality(v_new.planned_colours) = 0 then
      v_errors := v_errors || jsonb_build_object('field', 'planned_colours', 'message', 'Enter the job colours.');
    end if;
    if not exists (select 1 from unnest(v_new.unit_colours) c where c is not null) then
      v_errors := v_errors || jsonb_build_object('field', 'unit_colours', 'message', 'Allocate at least one colour to a unit.');
    end if;
    v_planned := array(select lower(c) from unnest(v_new.planned_colours) c);
    foreach v_colour in array v_new.unit_colours loop
      if v_colour is not null and not (lower(v_colour) = any (v_planned)) then
        v_errors := v_errors || jsonb_build_object('field', 'unit_colours',
          'message', format('Colour %s is not one of this job''s colours.', v_colour));
      end if;
    end loop;

    -- Print side, closed sides and continuation.
    if v_key is not null and v_new.print_side is not null then
      select * into v_other from public.production_entries x
      where x.order_key = v_key and x.status = 'submitted' and x.id <> v_new.id
        and public.side_family(x.print_side) <> public.side_family(v_new.print_side)
      limit 1;
      if found then
        v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message',
          format('Production order %s is already printed as %s. O/S stands alone; F/S pairs with B/S; B/B F pairs with B/B B.',
                 v_new.order_no, v_other.print_side));
      end if;

      if not (v_exists and v_old.status = 'submitted' and v_old.order_key = v_key) then
        if public.order_fully_closed(v_key) then
          v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message',
            format('Production order %s is fully closed. No more entries can be added.', v_new.order_no));
        end if;
      end if;
      if not (v_exists and v_old.status = 'submitted' and v_old.order_key = v_key and v_old.print_side = v_new.print_side)
         and exists (select 1 from public.order_side_closures c where c.order_key = v_key and c.print_side = v_new.print_side) then
        v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message',
          format('%s of production order %s is already closed.', v_new.print_side, v_new.order_no));
      end if;

      -- An earlier entry on the same side means this one must continue it.
      select * into v_other from public.production_entries x
      where x.order_key = v_key and x.print_side = v_new.print_side and x.status = 'submitted' and x.id <> v_new.id
        and (not v_exists or (x.created_at, x.entry_no) < (v_old.created_at, v_old.entry_no))
      order by x.created_at desc, x.entry_no desc
      limit 1;
      if found and not v_new.continuing then
        v_errors := v_errors || jsonb_build_object('field', 'continuing', 'message',
          format('%s of production order %s already has entry PE-%s. If the same job is continuing, set Continuing Job to Yes.',
                 v_new.print_side, v_new.order_no, lpad(v_other.entry_no::text, 5, '0')));
      end if;
    end if;

    if v_new.continuing then
      select * into v_other from public.production_entries x
      where x.order_key = v_key and x.print_side is not distinct from v_new.print_side
        and x.machine_id = v_new.machine_id and x.status = 'submitted' and x.id <> v_new.id
        and (not v_exists or (x.created_at, x.entry_no) < (v_old.created_at, v_old.entry_no))
      order by x.created_at desc, x.entry_no desc
      limit 1;
      if not found then
        v_errors := v_errors || jsonb_build_object('field', 'continuing', 'message',
          'Continuing Job needs an earlier submitted entry for the same production order, print side and machine.');
      end if;
    end if;

    -- Times.
    v_first := v_key is null or public.is_first_order_entry(v_key, case when v_exists then v_new.id end);
    v_required := public.changeover_required(v_new.print_side, v_new.continuing, v_first);
    for v_pair in
      select * from (values
        ('make_ready', 'Job Changeover', v_new.make_ready_start, v_new.make_ready_end),
        ('registration', 'Registration', v_new.registration_start, v_new.registration_end),
        ('colour_matching', 'Colour Matching', v_new.colour_matching_start, v_new.colour_matching_end)
      ) as t(field, label, s, e)
    loop
      if (v_pair.s is null) <> (v_pair.e is null) then
        v_errors := v_errors || jsonb_build_object('field', v_pair.field,
          'message', format('%s: enter both Start and End, or leave both empty.', v_pair.label));
      elsif v_required and v_pair.s is null then
        v_errors := v_errors || jsonb_build_object('field', v_pair.field,
          'message', format('%s Start and End are required for this entry.', v_pair.label));
      end if;
    end loop;
    if v_new.run_start is null or v_new.run_end is null then
      v_errors := v_errors || jsonb_build_object('field', 'run', 'message', 'Production Time Start and End are required.');
    end if;

    for v_pair in
      select * from (values
        ('make_ready', 'Job Changeover', v_new.make_ready_start, v_new.make_ready_end),
        ('registration', 'Registration', v_new.registration_start, v_new.registration_end),
        ('colour_matching', 'Colour Matching', v_new.colour_matching_start, v_new.colour_matching_end),
        ('run', 'Production Time', v_new.run_start, v_new.run_end)
      ) as t(field, label, s, e)
    loop
      v_mins := public.minutes_between(v_pair.s, v_pair.e);
      if v_mins > 1440 then
        v_errors := v_errors || jsonb_build_object('field', v_pair.field,
          'message', format('%s is longer than 24 hours. Check the dates.', v_pair.label));
      end if;
      if v_pair.e > now() + interval '5 minutes' or v_pair.s > now() + interval '5 minutes' then
        v_errors := v_errors || jsonb_build_object('field', v_pair.field,
          'message', format('%s cannot be in the future.', v_pair.label));
      end if;
    end loop;

    -- Production Date must match the run start under the shift rule.
    if v_new.run_start is not null and v_new.shift is not null and v_new.production_date is not null
       and v_new.production_date <> public.plant_production_date(v_new.run_start, v_new.shift) then
      v_errors := v_errors || jsonb_build_object('field', 'production_date', 'message',
        format('Production Date should be %s for a %s shift run that starts at %s.',
               to_char(public.plant_production_date(v_new.run_start, v_new.shift), 'DD-Mon-YYYY'),
               v_new.shift,
               to_char(v_new.run_start at time zone 'Asia/Kolkata', 'DD-Mon-YYYY HH12:MI AM')));
    end if;

    -- No overlap with another submitted entry on the same machine.
    if v_window_start is not null and v_new.run_end is not null and v_new.machine_id is not null then
      select * into v_other from public.production_entries x
      where x.machine_id = v_new.machine_id and x.status = 'submitted' and x.id <> v_new.id
        and x.run_end is not null
        and least(x.make_ready_start, x.registration_start, x.colour_matching_start, x.run_start) < v_new.run_end
        and x.run_end > v_window_start
      order by x.run_end desc
      limit 1;
      if found then
        v_errors := v_errors || jsonb_build_object('field', 'run', 'message',
          format('These times overlap entry PE-%s (production order %s, %s to %s) on this machine.',
                 lpad(v_other.entry_no::text, 5, '0'), v_other.order_no,
                 to_char(least(v_other.make_ready_start, v_other.registration_start, v_other.colour_matching_start, v_other.run_start)
                         at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_other.run_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
      end if;
    end if;

    -- A planned order must have colours planned for the chosen print side.
    if v_job_id is not null and v_new.print_side is not null and not v_side_found then
      v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message',
        format('Production order %s has no colours planned for %s. Choose a planned print side, or add %s to this order in Production Plan.',
               v_new.order_no, v_new.print_side, v_new.print_side));
    end if;

    -- Downtime rows: complete, and inside this job (first step start to production end).
    for v_ev in select value from jsonb_array_elements(coalesce(p_downtime, '[]'::jsonb)) loop
      v_ev_start := nullif(v_ev ->> 'start_at', '')::timestamptz;
      v_ev_end := nullif(v_ev ->> 'end_at', '')::timestamptz;
      v_ev_reason := nullif(v_ev ->> 'reason_id', '')::uuid;
      continue when v_ev_start is null and v_ev_end is null and v_ev_reason is null;
      if v_ev_start is null or v_ev_end is null then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Enter Start and End for each downtime row.');
      elsif v_ev_end - v_ev_start > interval '24 hours' then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'A downtime row is longer than 24 hours. Check the dates.');
      elsif v_ev_end > now() + interval '5 minutes' then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Downtime cannot end in the future.');
      elsif v_window_start is not null and v_new.run_end is not null
            and (v_ev_start < v_window_start or v_ev_end > v_new.run_end) then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message',
          format('Downtime %s to %s is outside this job (%s to %s). Record downtime between jobs under Downtime.',
                 to_char(v_ev_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_ev_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_window_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_new.run_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
      end if;
      if v_ev_reason is null then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Select a reason for each downtime.');
      end if;
    end loop;

    -- Downtime recorded between jobs cannot fall inside this job.
    if v_window_start is not null and v_new.run_end is not null and v_new.machine_id is not null then
      select * into v_outside from public.downtime_events d
      where d.machine_id = v_new.machine_id and d.entry_id is null and d.start_at is not null
        and d.start_at < v_new.run_end and coalesce(d.end_at, 'infinity'::timestamptz) > v_window_start
      order by d.start_at
      limit 1;
      if found then
        v_errors := v_errors || jsonb_build_object('field', 'run', 'message',
          format('These times overlap downtime%s recorded between jobs (%s to %s). Change the times, or correct that record under %s.',
                 coalesce(' (' || v_outside.kind || ')', ''),
                 to_char(v_outside.start_at at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 coalesce(to_char(v_outside.end_at at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'), 'still open'),
                 'Production > Downtime'));
      end if;
    end if;

    -- Quantities.
    if v_new.machine_speed is null or v_new.machine_speed = 0 then
      v_errors := v_errors || jsonb_build_object('field', 'machine_speed', 'message', 'Enter the Machine Speed.');
    end if;
    if v_new.total_sheets is null then
      v_errors := v_errors || jsonb_build_object('field', 'total_sheets', 'message', 'Enter the Total Given Sheets.');
    end if;
    if v_new.ok_sheets is null then
      v_errors := v_errors || jsonb_build_object('field', 'ok_sheets', 'message', 'Enter the OK Sheets.');
    end if;
    v_new.separate_sheets := coalesce(v_new.separate_sheets, 0);
    for v_row in select value from jsonb_array_elements(coalesce(p_wastage, '[]'::jsonb)) loop
      v_qty := nullif(v_row ->> 'quantity', '')::integer;
      v_reason := nullif(v_row ->> 'reason_id', '')::uuid;
      continue when v_qty is null and v_reason is null;
      if v_qty is null then
        v_errors := v_errors || jsonb_build_object('field', 'wastage', 'message', 'Enter the quantity for each wastage row.');
      end if;
      if v_reason is null then
        v_errors := v_errors || jsonb_build_object('field', 'wastage', 'message', 'Select a reason for each wastage row.');
      end if;
    end loop;
    if v_new.total_sheets is not null and v_new.ok_sheets is not null
       and v_new.total_sheets <> v_new.ok_sheets + v_new.separate_sheets + v_wastage_total then
      v_errors := v_errors || jsonb_build_object('field', 'total_sheets', 'message',
        format('Total Given Sheets (%s) must equal OK + Separate + Wastage (%s). Difference: %s.',
               v_new.total_sheets, v_new.ok_sheets + v_new.separate_sheets + v_wastage_total,
               v_new.total_sheets - (v_new.ok_sheets + v_new.separate_sheets + v_wastage_total)));
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
  end if;

  -- A machine with an open draft takes no other new record until that draft is
  -- finished or deleted (the draft is the job on the machine). Editing past
  -- submitted entries is still allowed.
  if not (v_exists and v_old.status = 'submitted') then
    select * into v_draft from public.production_entries x
    where x.machine_id = v_new.machine_id and x.status = 'draft' and x.id <> v_new.id;
    if found then
      return jsonb_build_object('ok', false, 'code', 'DRAFT_EXISTS',
        'message', 'This machine already has a draft. Finish or delete that draft before saving another entry for this machine.',
        'draft', jsonb_build_object('id', v_draft.id, 'entry_no', v_draft.entry_no, 'order_no', v_draft.order_no,
          'job_name', v_draft.job_name, 'production_date', v_draft.production_date, 'shift', v_draft.shift,
          'updated_at', v_draft.updated_at));
    end if;
  end if;

  -- No. of Colour Changes and Coating Changed?: compared with the previous submitted
  -- job on this machine, unit by unit (colour codes ignore case and spaces).
  v_window_start := least(v_new.make_ready_start, v_new.registration_start, v_new.colour_matching_start, v_new.run_start);
  select * into v_prev from public.production_entries x
  where x.machine_id = v_new.machine_id and x.status = 'submitted' and x.id <> v_new.id and x.run_end is not null
    and (v_window_start is null or x.run_end <= v_window_start)
  order by x.run_end desc
  limit 1;
  v_prev_found := found;
  v_new.colour_changes := (
    select count(*) from generate_series(1, 7) as i
    where case when v_prev_found
               then public.colour_key(v_new.unit_colours[i]) <> public.colour_key(v_prev.unit_colours[i])
               else v_new.unit_colours[i] is not null end);
  v_new.coating_changed := case when v_new.coating_id is null then null
                                when v_prev_found then v_prev.coating_id is distinct from v_new.coating_id
                                else true end;

  -- Server-derived fields.
  v_new.job_id := (select j.id from public.production_jobs j where lower(btrim(j.order_no)) = v_key);
  v_new.continues_entry_id := null;
  if v_new.continuing and v_key is not null then
    v_new.continues_entry_id := (
      select x.id from public.production_entries x
      where x.order_key = v_key and x.print_side is not distinct from v_new.print_side
        and x.machine_id = v_new.machine_id and x.status = 'submitted' and x.id <> v_new.id
        and (not v_exists or (x.created_at, x.entry_no) < (v_old.created_at, v_old.entry_no))
      order by x.created_at desc, x.entry_no desc
      limit 1);
  end if;
  v_new.wastage_sheets := v_wastage_total;
  v_new.last_save_id := p_save_id;
  if v_submit then
    v_new.status := 'submitted';
    if not v_exists or v_old.status = 'draft' then
      v_new.submitted_at := now();
      v_new.submitted_by := auth.uid();
    end if;
  else
    v_new.status := 'draft';
  end if;

  if not v_exists then
    insert into public.production_entries (id, status, machine_id, production_date)
    values (v_new.id, v_new.status, v_new.machine_id, v_new.production_date);
  end if;

  update public.production_entries set
    status = v_new.status,
    machine_id = v_new.machine_id,
    production_date = v_new.production_date,
    shift = v_new.shift,
    order_no = v_new.order_no,
    cso_no = v_new.cso_no,
    job_id = v_new.job_id,
    job_name = v_new.job_name,
    category = v_new.category,
    ups = v_new.ups,
    job_type = v_new.job_type,
    paper_type_id = v_new.paper_type_id,
    planned_quantity = v_new.planned_quantity,
    planned_colours = v_new.planned_colours,
    print_side = v_new.print_side,
    continuing = v_new.continuing,
    continues_entry_id = v_new.continues_entry_id,
    operator_id = v_new.operator_id,
    supervisor_id = v_new.supervisor_id,
    qc_executive_id = v_new.qc_executive_id,
    helpers = v_new.helpers,
    unit_colours = v_new.unit_colours,
    coating_id = v_new.coating_id,
    colour_changes = v_new.colour_changes,
    coating_changed = v_new.coating_changed,
    make_ready_start = v_new.make_ready_start,
    make_ready_end = v_new.make_ready_end,
    registration_start = v_new.registration_start,
    registration_end = v_new.registration_end,
    colour_matching_start = v_new.colour_matching_start,
    colour_matching_end = v_new.colour_matching_end,
    run_start = v_new.run_start,
    run_end = v_new.run_end,
    machine_speed = v_new.machine_speed,
    total_sheets = v_new.total_sheets,
    ok_sheets = v_new.ok_sheets,
    separate_sheets = v_new.separate_sheets,
    wastage_sheets = v_new.wastage_sheets,
    remarks = v_new.remarks,
    submitted_at = v_new.submitted_at,
    submitted_by = v_new.submitted_by,
    last_save_id = v_new.last_save_id,
    manual_starts = v_new.manual_starts
  where id = v_new.id
  returning * into v_new;

  delete from public.production_entry_wastage where entry_id = v_new.id;
  for v_row in select value from jsonb_array_elements(coalesce(p_wastage, '[]'::jsonb)) loop
    v_qty := nullif(v_row ->> 'quantity', '')::integer;
    v_reason := nullif(v_row ->> 'reason_id', '')::uuid;
    continue when v_qty is null and v_reason is null;
    v_line := v_line + 1;
    insert into public.production_entry_wastage (entry_id, line, quantity, reason_id)
    values (v_new.id, v_line, v_qty, v_reason);
  end loop;

  -- Downtime inside this job.
  delete from public.downtime_events where entry_id = v_new.id;
  v_line := 0;
  for v_ev in select value from jsonb_array_elements(coalesce(p_downtime, '[]'::jsonb)) loop
    v_ev_start := nullif(v_ev ->> 'start_at', '')::timestamptz;
    v_ev_end := nullif(v_ev ->> 'end_at', '')::timestamptz;
    v_ev_reason := nullif(v_ev ->> 'reason_id', '')::uuid;
    continue when v_ev_start is null and v_ev_end is null and v_ev_reason is null;
    v_line := v_line + 1;
    v_ev_kind := (select r.category from public.downtime_reasons r where r.id = v_ev_reason);
    insert into public.downtime_events (kind, machine_id, entry_id, line, start_at, end_at, reason_id,
                                        remarks, production_date, shift)
    values (v_ev_kind, v_new.machine_id, v_new.id, v_line, v_ev_start, v_ev_end, v_ev_reason,
            nullif(btrim(coalesce(v_ev ->> 'remarks', '')), ''), v_new.production_date, v_new.shift);
  end loop;

  -- Net times: gross minus downtime inside each step. Overlapping downtime rows
  -- are merged first, so the same minute is never deducted twice.
  select range_agg(tstzrange(d.start_at, d.end_at)) into v_downtime
  from public.downtime_events d
  where d.entry_id = v_new.id and d.start_at is not null and d.end_at > d.start_at;

  -- Machine timeline: the previous completed job on this machine and when the
  -- machine became ready after it.
  v_window_start := least(v_new.make_ready_start, v_new.registration_start, v_new.colour_matching_start, v_new.run_start);
  select * into v_prev from public.production_entries x
  where x.machine_id = v_new.machine_id and x.status = 'submitted' and x.id <> v_new.id and x.run_end is not null
    and (v_window_start is null or x.run_end <= v_window_start)
  order by x.run_end desc
  limit 1;

  update public.production_entries set
    make_ready_net_minutes = public.net_minutes(v_downtime, make_ready_start, make_ready_end),
    registration_net_minutes = public.net_minutes(v_downtime, registration_start, registration_end),
    colour_matching_net_minutes = public.net_minutes(v_downtime, colour_matching_start, colour_matching_end),
    changeover_net_minutes = case
      when coalesce(public.net_minutes(v_downtime, make_ready_start, make_ready_end),
                    public.net_minutes(v_downtime, registration_start, registration_end),
                    public.net_minutes(v_downtime, colour_matching_start, colour_matching_end)) is null then null
      else coalesce(public.net_minutes(v_downtime, make_ready_start, make_ready_end), 0)
         + coalesce(public.net_minutes(v_downtime, registration_start, registration_end), 0)
         + coalesce(public.net_minutes(v_downtime, colour_matching_start, colour_matching_end), 0) end,
    run_net_minutes = public.net_minutes(v_downtime, run_start, run_end),
    downtime_minutes = coalesce(round((select sum(extract(epoch from (upper(r) - lower(r)))) from unnest(v_downtime) as r) / 60)::integer, 0),
    man_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = v_new.id and d.kind = 'Man'), 0),
    machine_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = v_new.id and d.kind = 'Machine'), 0),
    material_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = v_new.id and d.kind = 'Material'), 0),
    other_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = v_new.id and d.kind = 'Others'), 0),
    previous_entry_id = v_prev.id,
    machine_ready_at = public.machine_ready_after(v_new.machine_id, v_prev.run_end, v_window_start)
  where id = v_new.id
  returning * into v_new;

  -- Optionally close the side in the same step (the side is finished).
  if v_new.status = 'submitted' and coalesce(p_close_side, false) and v_key is not null and v_new.print_side is not null then
    insert into public.order_side_closures (order_key, print_side, entry_id, closed_by)
    values (v_key, v_new.print_side, v_new.id, auth.uid())
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true, 'id', v_new.id, 'entry_no', v_new.entry_no,
    'status', v_new.status, 'updated_at', v_new.updated_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Ink formulas: reuse a formula for the same colour, paper type and category
-- ---------------------------------------------------------------------------

-- The formula already saved for this colour with this paper type and category on an
-- earlier order (the first one saved), or null. p_before: only records created before
-- that moment count (a record never borrows from one made after it).
create or replace function public.known_ink_formula(p_colour text, p_paper_type_id uuid, p_category text, p_job_id uuid,
                                                    p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('record_id', r.id, 'record_no', r.record_no, 'order_no', r.order_no, 'formula', c.formula)
  from public.ink_formula_records r
  join public.production_jobs j on j.id = r.job_id
  join public.ink_formula_colours c on c.record_id = r.id
  where not r.archived
    and r.job_id is distinct from p_job_id
    and (p_before is null or r.created_at < p_before)
    and j.paper_type_id = p_paper_type_id
    and public.colour_key(j.category) = public.colour_key(p_category)
    and public.colour_key(c.colour) = public.colour_key(p_colour)
    and nullif(btrim(coalesce(c.formula, '')), '') is not null
  order by r.created_at, r.record_no
  limit 1;
$$;

drop function public.order_plan_colours(uuid);
create or replace function public.order_plan_colours(p_job_id uuid, p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with job as (select j.id, j.paper_type_id, j.category from public.production_jobs j where j.id = p_job_id),
  c as (
    select s.line, n, btrim(colour) as colour,
           case when s.print_side in ('B/B F', 'B/B B') then 'B/B' else s.print_side end as side
    from public.production_job_sides s
    cross join lateral unnest(s.colours) with ordinality as u(colour, n)
    where s.job_id = p_job_id
      and (public.has_perm('ink_formula', 'view') or public.has_perm('production_plan', 'view'))
  ),
  g as (
    select public.colour_key(colour) as k, min(colour) as colour, min(line * 1000 + n) as pos,
           array_agg(distinct side order by side) as sides
    from c group by public.colour_key(colour)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'colour', g.colour, 'sides', to_jsonb(g.sides),
           'standard', public.is_standard_colour(g.colour),
           'known', case when public.is_standard_colour(g.colour) then null
                         else public.known_ink_formula(g.colour, job.paper_type_id, job.category, p_job_id, p_before) end)
         order by g.pos), '[]'::jsonb)
  from g cross join job;
$$;

-- Orders for Ink Formula Entry: those with a formula record, or with at least one
-- colour that still needs a formula.
create or replace function public.ink_order_options()
returns table (job_id uuid, order_no text, cso_no text, job_name text, category text, plan_date date, paper_type text,
               record_id uuid, record_no bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select j.id, j.order_no, j.cso_no, j.job_name, j.category, j.plan_date, p.name, r.id, r.record_no
  from public.production_jobs j
  left join public.paper_types p on p.id = j.paper_type_id
  left join public.ink_formula_records r on r.order_key = lower(btrim(j.order_no)) and not r.archived
  where public.has_perm('ink_formula', 'view')
    and (r.id is not null or exists (
      select 1 from public.production_job_sides s cross join lateral unnest(s.colours) as u(colour)
      where s.job_id = j.id and not public.is_standard_colour(u.colour)
        and public.known_ink_formula(u.colour, j.paper_type_id, j.category, j.id) is null))
  order by j.plan_date desc, j.order_no;
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
        jsonb_build_array(jsonb_build_object('field', 'order_no', 'message', 'Select a production order from Production Plan.')));
    end if;
    select * into v_other from public.ink_formula_records r where r.order_key = lower(btrim(v_job.order_no)) and not r.archived;
    if found then
      return jsonb_build_object('ok', false, 'code', 'EXISTS', 'id', v_other.id, 'record_no', v_other.record_no,
        'message', format('Production order %s already has ink formula IF-%s. Open it to make changes.', v_job.order_no, lpad(v_other.record_no::text, 5, '0')));
    end if;
  end if;

  -- Colours allowed: the plan's colours now, plus colours already on the record.
  -- The standard process colours C, M, Y, K never take a formula.
  -- Colours that already have a formula for this paper type and category on an
  -- earlier order are not asked again (shown with that formula instead).
  v_plan := case when v_job.id is not null
                 then public.order_plan_colours(v_job.id, case when v_exists then v_rec.created_at end) else '[]'::jsonb end;
  v_allowed := array(select public.colour_key(x ->> 'colour') from jsonb_array_elements(v_plan || v_old) x
                     where not public.is_standard_colour(x ->> 'colour')
                       and not exists (select 1 from jsonb_array_elements(v_plan) k
                                       where public.colour_key(k ->> 'colour') = public.colour_key(x ->> 'colour')
                                         and jsonb_typeof(k -> 'known') = 'object'));
  if not v_exists and cardinality(v_allowed) = 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', jsonb_build_array(jsonb_build_object('field', 'colours',
      'message', 'This production order needs no new ink formula: its colours are standard (C, M, Y, K) or already have a formula for this paper type and category.')));
  end if;
  v_paper := (select p.name from public.paper_types p where p.id = v_job.paper_type_id);

  for v_item in select value from jsonb_array_elements(coalesce(p_colours, '[]'::jsonb)) loop
    v_colour := btrim(coalesce(v_item ->> 'colour', ''));
    v_formula := nullif(btrim(coalesce(v_item ->> 'formula', '')), '');
    continue when public.is_standard_colour(v_colour); -- no formula for C, M, Y, K
    continue when exists (select 1 from jsonb_array_elements(v_plan) k
                          where public.colour_key(k ->> 'colour') = public.colour_key(v_colour)
                            and jsonb_typeof(k -> 'known') = 'object'); -- formula already known
    if v_colour = '' or not (public.colour_key(v_colour) = any (v_allowed)) then
      v_errors := v_errors || jsonb_build_object('field', 'colours',
        'message', format('Colour %s is not one of this production order''s colours.', coalesce(nullif(v_colour, ''), '(blank)')));
      continue;
    end if;
    if exists (select 1 from jsonb_array_elements(v_new) n where public.colour_key(n ->> 'colour') = public.colour_key(v_colour)) then
      continue; -- each colour once
    end if;
    if v_formula is not null and length(v_formula) > 4000 then
      v_errors := v_errors || jsonb_build_object('field', 'colours',
        'message', format('The formula for %s is longer than 4000 characters.', v_colour));
    end if;
    v_sides := coalesce(
      (select x -> 'sides' from jsonb_array_elements(v_plan) x where public.colour_key(x ->> 'colour') = public.colour_key(v_colour) limit 1),
      (select x -> 'sides' from jsonb_array_elements(v_old) x where public.colour_key(x ->> 'colour') = public.colour_key(v_colour) limit 1),
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
-- 5. Wastage: quantities in Pcs
-- ---------------------------------------------------------------------------

do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.wastage_lines'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%cartons%'
  loop
    execute format('alter table public.wastage_lines drop constraint %I', c.conname);
  end loop;
end;
$$;
update public.wastage_lines set unit = 'pcs' where unit = 'cartons';
alter table public.wastage_lines add constraint wastage_lines_unit_check check (unit in ('pcs', 'sheets'));

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
        'message', format('Production order %s already has wastage record WE-%s. Open it to make changes.', v_rec.order_no, lpad(v_rec.record_no::text, 5, '0')));
    end if;
  end if;

  v_totals := public.order_production_totals(v_order);
  if v_totals is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', jsonb_build_array(jsonb_build_object('field', 'order_no',
      'message', 'Select a production order that has submitted production entries.')));
  end if;

  if v_order_qty is null or v_order_qty <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'order_qty', 'message', 'Enter the Order Qty (Pcs), above zero.');
  end if;
  if v_packed is null or v_packed < 0 then
    v_errors := v_errors || jsonb_build_object('field', 'packed_qty', 'message', 'Enter the Packed Qty (Pcs), zero or more.');
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
    if v_unit is null or v_unit not in ('pcs', 'sheets') then
      v_errors := v_errors || jsonb_build_object('field', 'lines', 'message', format('Line %s: choose the unit (Pcs or Sheets).', v_n));
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
    'cso_no', coalesce((select j.cso_no from j), (select e.cso_no from e order by e.created_at desc limit 1)),
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

-- ---------------------------------------------------------------------------
-- 6. Execution rights
-- ---------------------------------------------------------------------------

revoke execute on function
  public.colour_key(text),
  public.known_ink_formula(text, uuid, text, uuid, timestamptz),
  public.order_plan_colours(uuid, timestamptz),
  public.ink_order_options()
from public, anon;
grant execute on function
  public.colour_key(text),
  public.order_plan_colours(uuid, timestamptz),
  public.ink_order_options()
to authenticated;
