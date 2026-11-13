-- Phase 4b: print-side colour slots in the plan, a sequential machine timeline,
-- BDT / ODT downtime events and gross / net changeover.
--
--   * Production Plan: each order has one colour slot per print side (any number
--     of colours). Production Entry uses only the chosen side's colours.
--   * Changeover is sequential: Make Ready -> Registration -> Colour Matching ->
--     Production. Each step starts when the previous one ends (start times can be
--     overridden by hand; the entry remembers which ones were).
--   * Each machine has its own timeline. The next job's Make Ready starts when the
--     machine became ready: the previous job's production end, or the end of
--     downtime recorded between jobs.
--   * BDT / ODT events: inside a job (saved with the entry), or between jobs
--     (machine-level, no order). Net time = gross time minus overlapping downtime;
--     overlapping events are merged first so no minute is deducted twice.

-- ---------------------------------------------------------------------------
-- 1. Colour lists without the nine-colour limit
-- ---------------------------------------------------------------------------

create or replace function public.colour_list_valid(p_colours text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(cardinality(p_colours), 0) <= 60
     and not exists (select 1 from unnest(p_colours) c where c is null or length(btrim(c)) not between 1 and 40)
     and (select count(distinct lower(btrim(c))) from unnest(p_colours) c) = coalesce(cardinality(p_colours), 0);
$$;

-- ---------------------------------------------------------------------------
-- 2. Production Plan: colour slots per print side
-- ---------------------------------------------------------------------------

create table public.production_job_sides (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.production_jobs (id) on delete cascade,
  print_side text not null check (print_side in ('O/S', 'F/S', 'B/S', 'B/B F', 'B/B B')),
  colours text[] not null default '{}' check (public.colour_list_valid(colours)),
  line integer not null default 1,
  unique (job_id, print_side)
);

create trigger production_job_sides_audit
after insert or update or delete on public.production_job_sides
for each row execute function public.audit_row();

-- Existing jobs: their single colour list becomes an O/S slot.
insert into public.production_job_sides (job_id, print_side, colours)
select id, 'O/S', colours from public.production_jobs where cardinality(colours) > 0;

alter table public.production_jobs drop column colours;
drop function if exists public.planned_colours_valid(text[]) cascade;

alter table public.production_job_sides enable row level security;
revoke all on public.production_job_sides from anon;
revoke insert, update, delete on public.production_job_sides from authenticated;
create policy production_job_sides_select on public.production_job_sides
  for select to authenticated
  using (exists (select 1 from public.production_jobs j where j.id = job_id));

-- Saves a job and its print-side slots in one step.
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
  if v_cat is not null and length(v_cat) > 80 then
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
    else
      v_sides := v_sides || v_print;
      if cardinality(v_colours) = 0 then
        v_errors := v_errors || jsonb_build_object('field', 'sides', 'message', format('%s: enter at least one colour.', v_print));
      elsif not public.colour_list_valid(v_colours) then
        v_errors := v_errors || jsonb_build_object('field', 'sides',
          'message', format('%s: each colour once, at most 40 characters.', v_print));
      end if;
    end if;
  end loop;
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
  for v_side in select value from jsonb_array_elements(coalesce(p_sides, '[]'::jsonb)) loop
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
-- 3. Production entries: unlimited job colours, gross / net times, timeline
-- ---------------------------------------------------------------------------

alter table public.production_entries drop constraint if exists production_entries_planned_colours_check;
alter table public.production_entries
  add constraint production_entries_planned_colours_check check (public.colour_list_valid(planned_colours));

-- Changeover is now sequential, so gross changeover is the sum of the three steps.
alter table public.production_entries drop column changeover_minutes;
alter table public.production_entries
  add column changeover_gross_minutes integer generated always as (
    case when public.minutes_between(make_ready_start, make_ready_end) is null
          and public.minutes_between(registration_start, registration_end) is null
          and public.minutes_between(colour_matching_start, colour_matching_end) is null then null
         else coalesce(public.minutes_between(make_ready_start, make_ready_end), 0)
            + coalesce(public.minutes_between(registration_start, registration_end), 0)
            + coalesce(public.minutes_between(colour_matching_start, colour_matching_end), 0)
    end) stored,
  add column make_ready_net_minutes integer,
  add column registration_net_minutes integer,
  add column colour_matching_net_minutes integer,
  add column changeover_net_minutes integer,
  add column run_net_minutes integer,
  add column downtime_minutes integer not null default 0,
  add column manual_starts text[] not null default '{}'
    check (manual_starts <@ array['make_ready', 'registration', 'colour_matching', 'run']::text[]),
  add column previous_entry_id uuid references public.production_entries (id) on delete set null,
  add column machine_ready_at timestamptz;

create index production_entries_previous_idx on public.production_entries (previous_entry_id);

-- ---------------------------------------------------------------------------
-- 4. BDT / ODT events
-- ---------------------------------------------------------------------------

create table public.downtime_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('BDT', 'ODT')),
  machine_id uuid not null references public.machines (id) on delete restrict,
  -- Set for downtime inside a job; empty for downtime between jobs.
  entry_id uuid references public.production_entries (id) on delete cascade,
  line integer,
  start_at timestamptz,
  end_at timestamptz,
  minutes integer generated always as (public.minutes_between(start_at, end_at)) stored,
  bdt_reason_id uuid references public.bdt_reasons (id) on delete restrict,
  odt_reason_id uuid references public.odt_reasons (id) on delete restrict,
  remarks text check (remarks is null or length(remarks) <= 500),
  production_date date,
  shift text check (shift in ('A', 'B')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  check ((kind = 'BDT' and odt_reason_id is null) or (kind = 'ODT' and bdt_reason_id is null)),
  check (start_at is null or end_at is null or end_at >= start_at)
);
create index downtime_events_machine_idx on public.downtime_events (machine_id, start_at);
create index downtime_events_entry_idx on public.downtime_events (entry_id);
create index downtime_events_date_idx on public.downtime_events (production_date desc);
create index downtime_events_bdt_reason_idx on public.downtime_events (bdt_reason_id);
create index downtime_events_odt_reason_idx on public.downtime_events (odt_reason_id);

create trigger downtime_events_audit_fields
before insert or update on public.downtime_events
for each row execute function public.set_audit_fields();

create trigger downtime_events_audit
after insert or update or delete on public.downtime_events
for each row execute function public.audit_row();

-- Seconds of downtime (already merged, so never counted twice) inside [start, end].
create or replace function public.overlap_seconds(p_downtime tstzmultirange, p_start timestamptz, p_end timestamptz)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_downtime is null or p_start is null or p_end is null or p_end <= p_start then 0
    else coalesce((select sum(extract(epoch from (upper(r) - lower(r))))
                   from unnest(p_downtime * tstzmultirange(tstzrange(p_start, p_end))) as r), 0)
  end;
$$;

-- Net minutes of an activity: its length minus the downtime inside it.
create or replace function public.net_minutes(p_downtime tstzmultirange, p_start timestamptz, p_end timestamptz)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_start is null or p_end is null or p_end < p_start then null
              else round((extract(epoch from (p_end - p_start)) - public.overlap_seconds(p_downtime, p_start, p_end)) / 60)::integer
         end;
$$;

-- When the machine became ready after a job: the job's production end, or the end
-- of downtime recorded between jobs after it (and before p_before, when given).
create or replace function public.machine_ready_after(p_machine_id uuid, p_prev_end timestamptz, p_before timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(p_prev_end, (
    select max(d.end_at) from public.downtime_events d
    where d.machine_id = p_machine_id and d.entry_id is null and d.end_at is not null
      and (p_prev_end is null or d.start_at >= p_prev_end)
      and (p_before is null or d.end_at <= p_before)));
$$;

-- ---------------------------------------------------------------------------
-- 5. Saving an entry: side colours, sequential steps, downtime, net times
-- ---------------------------------------------------------------------------

drop function public.save_production_entry(uuid, uuid, boolean, jsonb, jsonb, timestamptz, boolean);

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
-- 6. Machine timeline for the entry form
-- ---------------------------------------------------------------------------

-- The previous completed job on this machine, downtime recorded after it, and the
-- moment the machine became ready for the next job (its Make Ready start).
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
      'order_no', v_prev.order_no, 'job_name', v_prev.job_name, 'print_side', v_prev.print_side, 'run_end', v_prev.run_end) end,
    'downtime', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'start_at', d.start_at, 'end_at', d.end_at,
               'minutes', d.minutes, 'reason', coalesce(b.name, o.name)) order by d.start_at), '[]'::jsonb)
      from public.downtime_events d
      left join public.bdt_reasons b on b.id = d.bdt_reason_id
      left join public.odt_reasons o on o.id = d.odt_reason_id
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

-- ---------------------------------------------------------------------------
-- 7. Downtime between jobs (machine level, no order)
-- ---------------------------------------------------------------------------

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

alter table public.downtime_events enable row level security;
revoke all on public.downtime_events from anon;
revoke insert, update on public.downtime_events from authenticated;

create policy downtime_events_select on public.downtime_events
  for select to authenticated
  using (
    (select public.can_use_machine(machine_id))
    and (
      (kind = 'BDT' and (select public.has_perm('bdt', 'view')))
      or (kind = 'ODT' and (select public.has_perm('odt', 'view')))
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
    and public.has_perm(lower(kind), 'delete')
  );

-- ---------------------------------------------------------------------------
-- 8. Order status: the plan's colour slots per print side
-- ---------------------------------------------------------------------------

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

  select jsonb_build_object('id', j.id, 'order_no', j.order_no, 'job_name', j.job_name, 'category', j.category,
           'ups', j.ups, 'job_type', j.job_type, 'paper_type_id', j.paper_type_id, 'quantity', j.quantity,
           'sides', (select coalesce(jsonb_agg(jsonb_build_object('print_side', s.print_side, 'colours', to_jsonb(s.colours))
                                              order by s.line), '[]'::jsonb)
                     from public.production_job_sides s where s.job_id = j.id))
    into v_job
  from public.production_jobs j where lower(btrim(j.order_no)) = v_key;

  -- For an unplanned order: the latest submitted entry's details, with each
  -- print side's colours from its latest entry.
  select jsonb_build_object('order_no', e.order_no, 'job_name', e.job_name, 'category', e.category, 'ups', e.ups,
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function
  public.colour_list_valid(text[]),
  public.save_production_job(uuid, jsonb, jsonb, timestamptz),
  public.overlap_seconds(tstzmultirange, timestamptz, timestamptz),
  public.net_minutes(tstzmultirange, timestamptz, timestamptz),
  public.machine_ready_after(uuid, timestamptz, timestamptz),
  public.machine_timeline(uuid, uuid),
  public.save_outside_downtime(uuid, jsonb, timestamptz),
  public.production_order_status(text, uuid, uuid),
  public.save_production_entry(uuid, uuid, boolean, jsonb, jsonb, timestamptz, boolean, jsonb)
  from public, anon;

grant execute on function
  public.colour_list_valid(text[]),
  public.save_production_job(uuid, jsonb, jsonb, timestamptz),
  public.overlap_seconds(tstzmultirange, timestamptz, timestamptz),
  public.net_minutes(tstzmultirange, timestamptz, timestamptz),
  public.machine_ready_after(uuid, timestamptz, timestamptz),
  public.machine_timeline(uuid, uuid),
  public.save_outside_downtime(uuid, jsonb, timestamptz),
  public.production_order_status(text, uuid, uuid),
  public.save_production_entry(uuid, uuid, boolean, jsonb, jsonb, timestamptz, boolean, jsonb)
  to authenticated;
