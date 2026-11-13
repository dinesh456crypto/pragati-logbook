-- Phase 5: downtime rules and production reports.
--
--   * A machine can have only one downtime record (BDT or ODT) at any moment:
--     downtime during a job and downtime between jobs may not overlap, on the
--     same machine. Checked in the save functions (clear messages) and by an
--     exclusion constraint (safety net).
--   * Overnight window: downtime between the end of B shift and 08:00 next morning
--     is not counted in reports. The B-shift end is the last job's production end
--     that production day (not before 16:30), or 01:00 when no job ran, unless an
--     admin sets it for that machine and day.
--   * Report functions for the dashboard and Production Log Summary. They run with
--     the caller's rights, so people only see figures for data they can access.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. No overlapping downtime on one machine
-- ---------------------------------------------------------------------------

-- Describes the first downtime record on the machine that overlaps [start, end)
-- (an open record runs on until it is closed). Empty when there is none.
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
  select format('%s %s to %s %s', d.kind,
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

alter table public.downtime_events
  add constraint downtime_events_no_overlap exclude using gist (
    machine_id with =,
    tstzrange(start_at, coalesce(end_at, 'infinity'::timestamptz)) with &&
  ) where (start_at is not null and (end_at is null or end_at > start_at));

-- BDT and ODT minutes of each entry, for reports.
alter table public.production_entries
  add column bdt_minutes integer not null default 0,
  add column odt_minutes integer not null default 0;

update public.production_entries e set
  bdt_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = e.id and d.kind = 'BDT'), 0),
  odt_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = e.id and d.kind = 'ODT'), 0);

-- ---------------------------------------------------------------------------
-- 2. Save functions with the overlap checks
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
  v_new.colour_changes := nullif(p_entry ->> 'colour_changes', '')::integer;
  v_new.coating_changed := nullif(p_entry ->> 'coating_changed', '')::boolean;
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
    v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Order Number can be at most 60 characters.');
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
  if v_new.colour_changes is not null and v_new.colour_changes not between 0 and 7 then
    v_errors := v_errors || jsonb_build_object('field', 'colour_changes', 'message', 'No. of Colour Changes must be 0 to 7.');
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
      ('make_ready', 'Make Ready', v_new.make_ready_start, v_new.make_ready_end),
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
      ('make_ready', 'Make Ready', v_new.make_ready_start, v_new.make_ready_end),
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

  -- Downtime rows (BDT / ODT inside this job).
  for v_ev in select value from jsonb_array_elements(coalesce(p_downtime, '[]'::jsonb)) loop
    v_kind := nullif(v_ev ->> 'kind', '');
    v_ev_start := nullif(v_ev ->> 'start_at', '')::timestamptz;
    v_ev_end := nullif(v_ev ->> 'end_at', '')::timestamptz;
    v_ev_reason := nullif(v_ev ->> 'reason_id', '')::uuid;
    continue when v_kind is null and v_ev_start is null and v_ev_end is null and v_ev_reason is null;
    if v_kind is null or v_kind not in ('BDT', 'ODT') then
      v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Choose BDT or ODT for each downtime row.');
    elsif v_ev_reason is not null
          and ((v_kind = 'BDT' and not exists (select 1 from public.bdt_reasons r where r.id = v_ev_reason))
            or (v_kind = 'ODT' and not exists (select 1 from public.odt_reasons r where r.id = v_ev_reason))) then
      v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'A downtime reason does not match its type (BDT / ODT).');
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
          format('Downtime from %s overlaps another downtime row of this job. A machine can have only one BDT or ODT at a time.',
                 to_char(v_ev_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
      end if;
      v_seen_ranges := v_seen_ranges || v_range;
      if v_new.machine_id is not null then
        v_clash := public.downtime_clash(v_new.machine_id, v_ev_start, v_ev_end, v_new.id, null);
        if v_clash is not null then
          v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message',
            format('Downtime from %s overlaps %s on this machine. A machine can have only one BDT or ODT at a time.',
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
      v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message', 'Order Number is required.');
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
    if v_new.colour_changes is null then
      v_errors := v_errors || jsonb_build_object('field', 'colour_changes', 'message', 'Select the No. of Colour Changes.');
    end if;
    if v_new.coating_changed is null then
      v_errors := v_errors || jsonb_build_object('field', 'coating_changed', 'message', 'Select whether the coating was changed.');
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
          format('Order %s is already printed as %s. O/S stands alone; F/S pairs with B/S; B/B F pairs with B/B B.',
                 v_new.order_no, v_other.print_side));
      end if;

      if not (v_exists and v_old.status = 'submitted' and v_old.order_key = v_key) then
        if public.order_fully_closed(v_key) then
          v_errors := v_errors || jsonb_build_object('field', 'order_no', 'message',
            format('Order %s is fully closed. No more entries can be added.', v_new.order_no));
        end if;
      end if;
      if not (v_exists and v_old.status = 'submitted' and v_old.order_key = v_key and v_old.print_side = v_new.print_side)
         and exists (select 1 from public.order_side_closures c where c.order_key = v_key and c.print_side = v_new.print_side) then
        v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message',
          format('%s of order %s is already closed.', v_new.print_side, v_new.order_no));
      end if;

      -- An earlier entry on the same side means this one must continue it.
      select * into v_other from public.production_entries x
      where x.order_key = v_key and x.print_side = v_new.print_side and x.status = 'submitted' and x.id <> v_new.id
        and (not v_exists or (x.created_at, x.entry_no) < (v_old.created_at, v_old.entry_no))
      order by x.created_at desc, x.entry_no desc
      limit 1;
      if found and not v_new.continuing then
        v_errors := v_errors || jsonb_build_object('field', 'continuing', 'message',
          format('%s of order %s already has entry PE-%s. If the same job is continuing, set Continuing Job to Yes.',
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
          'Continuing Job needs an earlier submitted entry for the same order, print side and machine.');
      end if;
    end if;

    -- Times.
    v_first := v_key is null or public.is_first_order_entry(v_key, case when v_exists then v_new.id end);
    v_required := public.changeover_required(v_new.print_side, v_new.continuing, v_first);
    for v_pair in
      select * from (values
        ('make_ready', 'Make Ready', v_new.make_ready_start, v_new.make_ready_end),
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
        ('make_ready', 'Make Ready', v_new.make_ready_start, v_new.make_ready_end),
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
          format('These times overlap entry PE-%s (order %s, %s to %s) on this machine.',
                 lpad(v_other.entry_no::text, 5, '0'), v_other.order_no,
                 to_char(least(v_other.make_ready_start, v_other.registration_start, v_other.colour_matching_start, v_other.run_start)
                         at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_other.run_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
      end if;
    end if;

    -- A planned order must have colours planned for the chosen print side.
    if v_job_id is not null and v_new.print_side is not null and not v_side_found then
      v_errors := v_errors || jsonb_build_object('field', 'print_side', 'message',
        format('Order %s has no colours planned for %s. Choose a planned print side, or add %s to this order in Production Plan.',
               v_new.order_no, v_new.print_side, v_new.print_side));
    end if;

    -- Downtime rows: complete, and inside this job (first step start to production end).
    for v_ev in select value from jsonb_array_elements(coalesce(p_downtime, '[]'::jsonb)) loop
      v_kind := nullif(v_ev ->> 'kind', '');
      v_ev_start := nullif(v_ev ->> 'start_at', '')::timestamptz;
      v_ev_end := nullif(v_ev ->> 'end_at', '')::timestamptz;
      v_ev_reason := nullif(v_ev ->> 'reason_id', '')::uuid;
      continue when v_kind is null and v_ev_start is null and v_ev_end is null and v_ev_reason is null;
      if v_ev_start is null or v_ev_end is null then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Enter Start and End for each downtime row.');
      elsif v_ev_end - v_ev_start > interval '24 hours' then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'A downtime row is longer than 24 hours. Check the dates.');
      elsif v_ev_end > now() + interval '5 minutes' then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Downtime cannot end in the future.');
      elsif v_window_start is not null and v_new.run_end is not null
            and (v_ev_start < v_window_start or v_ev_end > v_new.run_end) then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message',
          format('Downtime %s to %s is outside this job (%s to %s). Record downtime between jobs under BDT / ODT.',
                 to_char(v_ev_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_ev_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_window_start at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 to_char(v_new.run_end at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM')));
      end if;
      if v_ev_reason is null then
        v_errors := v_errors || jsonb_build_object('field', 'downtime', 'message', 'Select a reason for each downtime row.');
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
          format('These times overlap %s recorded between jobs (%s to %s). Change the times, or correct that record under %s.',
                 v_outside.kind,
                 to_char(v_outside.start_at at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'),
                 coalesce(to_char(v_outside.end_at at time zone 'Asia/Kolkata', 'DD-Mon HH12:MI AM'), 'still open'),
                 v_outside.kind));
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
    v_kind := nullif(v_ev ->> 'kind', '');
    v_ev_start := nullif(v_ev ->> 'start_at', '')::timestamptz;
    v_ev_end := nullif(v_ev ->> 'end_at', '')::timestamptz;
    v_ev_reason := nullif(v_ev ->> 'reason_id', '')::uuid;
    continue when v_kind is null and v_ev_start is null and v_ev_end is null and v_ev_reason is null;
    v_line := v_line + 1;
    insert into public.downtime_events (kind, machine_id, entry_id, line, start_at, end_at, bdt_reason_id, odt_reason_id,
                                        remarks, production_date, shift)
    values (v_kind, v_new.machine_id, v_new.id, v_line, v_ev_start, v_ev_end,
            case when v_kind = 'BDT' then v_ev_reason end, case when v_kind = 'ODT' then v_ev_reason end,
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
    bdt_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = v_new.id and d.kind = 'BDT'), 0),
    odt_minutes = coalesce((select sum(d.minutes) from public.downtime_events d where d.entry_id = v_new.id and d.kind = 'ODT'), 0),
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
  v_kind text := nullif(p_event ->> 'kind', '');
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
  if v_kind is null or v_kind not in ('BDT', 'ODT') then
    raise exception 'Unknown downtime type' using errcode = '22023';
  end if;
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
    if v_old.kind <> v_kind or not public.has_perm(lower(v_kind), 'edit') or not public.can_use_machine(v_old.machine_id) then
      raise exception 'Not allowed' using errcode = '42501';
    end if;
    if p_expected_updated_at is distinct from v_old.updated_at then
      return jsonb_build_object('ok', false, 'code', 'STALE',
        'message', 'This record was changed by someone else after you opened it. Close it and open it again.');
    end if;
  elsif not public.has_perm(lower(v_kind), 'create') then
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
  if v_reason is null
     or (v_kind = 'BDT' and not exists (select 1 from public.bdt_reasons r where r.id = v_reason))
     or (v_kind = 'ODT' and not exists (select 1 from public.odt_reasons r where r.id = v_reason)) then
    v_errors := v_errors || jsonb_build_object('field', 'reason_id', 'message', 'Select a reason.');
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
        format('This falls inside job PE-%s (order %s, %s to %s). Record downtime during a job in that production entry.',
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
        format('This overlaps %s on the same machine. A machine can have only one BDT or ODT at a time.', v_clash));
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', v_errors);
  end if;

  v_shift := case when (v_start at time zone 'Asia/Kolkata')::time >= time '08:00'
                   and (v_start at time zone 'Asia/Kolkata')::time < time '16:30' then 'A' else 'B' end;

  if v_exists then
    update public.downtime_events set
      machine_id = v_machine, start_at = v_start, end_at = v_end,
      bdt_reason_id = case when v_kind = 'BDT' then v_reason end,
      odt_reason_id = case when v_kind = 'ODT' then v_reason end,
      remarks = v_remarks, shift = v_shift, production_date = public.plant_production_date(v_start, v_shift)
    where id = v_old.id
    returning id, updated_at into v_id, v_updated;
  else
    insert into public.downtime_events (kind, machine_id, start_at, end_at, bdt_reason_id, odt_reason_id, remarks, shift, production_date)
    values (v_kind, v_machine, v_start, v_end,
            case when v_kind = 'BDT' then v_reason end, case when v_kind = 'ODT' then v_reason end,
            v_remarks, v_shift, public.plant_production_date(v_start, v_shift))
    returning id, updated_at into v_id, v_updated;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'updated_at', v_updated);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Overnight window: B-shift end per machine and production day
-- ---------------------------------------------------------------------------

create table public.shift_end_overrides (
  machine_id uuid not null references public.machines (id) on delete cascade,
  production_date date not null,
  b_shift_end timestamptz not null,
  reason text not null check (length(btrim(reason)) between 3 and 300),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  primary key (machine_id, production_date)
);

create trigger shift_end_overrides_audit_fields
before insert or update on public.shift_end_overrides
for each row execute function public.set_audit_fields();

create trigger shift_end_overrides_audit
after insert or update or delete on public.shift_end_overrides
for each row execute function public.audit_row();

alter table public.shift_end_overrides enable row level security;
revoke all on public.shift_end_overrides from anon;
revoke insert, update, delete on public.shift_end_overrides from authenticated;
create policy shift_end_overrides_select on public.shift_end_overrides
  for select to authenticated
  using ((select public.is_active_user()));

-- Who may set the B-shift end: the Super Admin, or users with Edit on Production Log.
create or replace function public.can_set_shift_end()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_super_admin() or public.has_perm('production_log', 'edit');
$$;

-- Sets (or, with an empty end, removes) the B-shift end for a machine and day.
create or replace function public.set_shift_end(p_machine_id uuid, p_date date, p_end timestamptz, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from timestamptz := ((p_date::text || ' 16:30')::timestamp at time zone 'Asia/Kolkata');
  v_to timestamptz := (((p_date + 1)::text || ' 08:00')::timestamp at time zone 'Asia/Kolkata');
begin
  if not public.can_set_shift_end() or not public.can_use_machine(p_machine_id) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_end is null then
    delete from public.shift_end_overrides where machine_id = p_machine_id and production_date = p_date;
    return jsonb_build_object('ok', true);
  end if;
  if p_end < v_from or p_end > v_to then
    return jsonb_build_object('ok', false, 'message', 'The B-shift end must be between 4:30 PM that day and 8:00 AM the next morning.');
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'message', 'Give a reason for the change.');
  end if;
  insert into public.shift_end_overrides (machine_id, production_date, b_shift_end, reason)
  values (p_machine_id, p_date, p_end, btrim(p_reason))
  on conflict (machine_id, production_date) do update set b_shift_end = excluded.b_shift_end, reason = excluded.reason;
  return jsonb_build_object('ok', true);
end;
$$;

-- The overnight window of each machine and production day: from the B-shift end
-- to 08:00 the next morning. Downtime inside it is not counted.
create or replace function public.night_windows(p_from date, p_to date)
returns table (machine_id uuid, production_date date, starts_at timestamptz, ends_at timestamptz, source text)
language sql
stable
set search_path = ''
as $$
  select m.id, d.day,
    least(n.next_morning, coalesce(o.b_shift_end,
      case when l.last_end is not null then greatest(l.last_end, n.b_start) end,
      ((d.day + 1)::text || ' 01:00')::timestamp at time zone 'Asia/Kolkata')),
    n.next_morning,
    case when o.b_shift_end is not null then 'set by admin'
         when l.last_end is not null then 'last job end'
         else 'default 1:00 AM' end
  from public.machines m
  cross join lateral (select g::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g) d
  cross join lateral (select ((d.day + 1)::text || ' 08:00')::timestamp at time zone 'Asia/Kolkata' as next_morning,
                             (d.day::text || ' 16:30')::timestamp at time zone 'Asia/Kolkata' as b_start) n
  left join public.shift_end_overrides o on o.machine_id = m.id and o.production_date = d.day
  left join lateral (select max(x.run_end) as last_end from public.production_entries x
                     where x.machine_id = m.id and x.status = 'submitted' and x.production_date = d.day) l on true;
$$;

-- Finished downtime records of the period, with the minutes that count (the
-- part outside the overnight window).
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
         coalesce(b.name, o.name), d.remarks
  from public.downtime_events d
  left join w on w.machine_id = d.machine_id
  left join public.bdt_reasons b on b.id = d.bdt_reason_id
  left join public.odt_reasons o on o.id = d.odt_reason_id
  where d.production_date between p_from and p_to
    and d.start_at is not null and d.end_at is not null
    and (p_machine_id is null or d.machine_id = p_machine_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. Dashboard figures
-- ---------------------------------------------------------------------------

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
        'bdt', (select coalesce(sum(d.counted_minutes), 0) from d where d.kind = 'BDT'),
        'odt', (select coalesce(sum(d.counted_minutes), 0) from d where d.kind = 'ODT'),
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
        'bdt', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id and d.kind = 'BDT'),
        'odt', (select coalesce(sum(d.counted_minutes), 0) from d where d.machine_id = m.id and d.kind = 'ODT'))
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

revoke execute on function
  public.downtime_clash(uuid, timestamptz, timestamptz, uuid, uuid),
  public.can_set_shift_end(),
  public.set_shift_end(uuid, date, timestamptz, text),
  public.night_windows(date, date),
  public.downtime_counted(date, date, uuid),
  public.dashboard_figures(date, date, uuid)
  from public, anon;
grant execute on function
  public.downtime_clash(uuid, timestamptz, timestamptz, uuid, uuid),
  public.can_set_shift_end(),
  public.set_shift_end(uuid, date, timestamptz, text),
  public.night_windows(date, date),
  public.downtime_counted(date, date, uuid),
  public.dashboard_figures(date, date, uuid)
  to authenticated;
