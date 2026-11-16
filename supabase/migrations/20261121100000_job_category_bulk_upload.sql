-- Job Details: Category is now required, and jobs can be uploaded in bulk from the
-- Excel template (Production Plan -> Job Details -> Bulk Upload).
--
--   * save_production_job()    same as before, plus "Category is required".
--   * import_production_jobs() checks every uploaded row with the same rules and saves
--                              all of them, or none: one mistake and nothing is imported.

-- ---------------------------------------------------------------------------
-- 1. Category required (existing jobs keep their value; a job without one must
--    get a Category the next time it is saved)
-- ---------------------------------------------------------------------------

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
    v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Order Number is required.');
  elsif length(v_order) > 60 then
    v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Order Number can be at most 60 characters.');
  elsif exists (select 1 from public.production_jobs j
                where lower(btrim(j.order_no)) = lower(v_order) and j.id is distinct from p_id) then
    v_errors := v_errors || jsonb_build_object('field', 'order_no',
      'message', format('Order Number %s already exists. Each order can be planned only once.', v_order));
  elsif v_exists and lower(v_order) <> lower(btrim(v_old.order_no))
        and exists (select 1 from public.production_entries e where e.order_key = lower(btrim(v_old.order_no))) then
    v_errors := v_errors || jsonb_build_object('field', 'order_no',
      'message', 'Production entries already use this Order Number, so it cannot be changed.');
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
  if v_ups is null or v_ups <= 0 then
    v_errors := v_errors || jsonb_build_object('field', 'ups', 'message', 'UPS must be a whole number above zero.');
  end if;
  if v_type is null or v_type not in ('NPD', 'NEW', 'Re-Print') then
    v_errors := v_errors || jsonb_build_object('field', 'job_type', 'message', 'Select a Job Type.');
  end if;
  if v_paper is null or not exists (select 1 from public.paper_types p where p.id = v_paper) then
    v_errors := v_errors || jsonb_build_object('field', 'paper_type_id', 'message', 'Select a Type of Paper.');
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
      job_type = v_type, paper_type_id = v_paper, quantity = v_qty
    where id = v_old.id
    returning id, updated_at into v_id, v_updated;
  else
    insert into public.production_jobs (plan_date, order_no, job_name, category, ups, job_type, paper_type_id, quantity)
    values (v_date, v_order, v_name, v_cat, v_ups, v_type, v_paper, v_qty)
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


-- ---------------------------------------------------------------------------
-- 2. Bulk import
-- ---------------------------------------------------------------------------
-- p_rows: [{row, plan_date (yyyy-mm-dd), order_no, job_name, category, ups, job_type,
--           paper_type (name), quantity, print_side (O/S | F/S | B/S | F/S + B/S | B/B),
--           colours ("C, M, Y"), bs_colours}]
-- p_dry_run: check everything, save nothing (the upload preview uses this).
-- Returns {ok: true, count, dry_run} or {ok: false, code: 'INVALID', errors: [{row, field, message}]}.

create or replace function public.split_colours(p_text text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(c order by n), '[]'::jsonb)
  from (
    select regexp_replace(btrim(x), '\s+', ' ', 'g') as c, n
    from regexp_split_to_table(coalesce(p_text, ''), ',') with ordinality as t(x, n)
  ) s
  where c <> '';
$$;

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
          'message', format('Order Number %s appears more than once in the file.', btrim(v_row ->> 'order_no')));
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
          'category', v_row ->> 'category',
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

revoke execute on function public.import_production_jobs(jsonb, boolean), public.split_colours(text) from public, anon;
grant execute on function public.import_production_jobs(jsonb, boolean), public.split_colours(text) to authenticated;
