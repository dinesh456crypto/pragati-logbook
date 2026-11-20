-- Ink Formula Entry takes its orders from saved production entries (like Wastage
-- Entry), not from Production Plan.
--
--   * The order list: every production order with at least one saved (submitted)
--     production entry that still needs a formula (a colour other than C, M, Y, K
--     whose formula is not already known), or that already has a formula record.
--   * The order's colours: the Planned Colours of all its saved entries, all print
--     sides together (B/B F and B/B B count as "B/B"), in the order they were entered.
--     Codes written differently (185, P185, P.185) are one colour (see colour_key).
--   * Job details (job name, category, paper type) come from the latest saved entry.
--   * "Already known" formulas match on the same colour, paper type and category of
--     an earlier formula record (records now keep their paper type id).
--   * Records keep the order's last production date; the plan date is kept too when
--     the order is also in Production Plan.

alter table public.ink_formula_records
  add column paper_type_id uuid references public.paper_types (id) on delete set null,
  add column production_date date;

update public.ink_formula_records r set paper_type_id = j.paper_type_id
from public.production_jobs j where j.id = r.job_id and r.paper_type_id is null;
update public.ink_formula_records r
set production_date = (select max(e.production_date) from public.production_entries e
                       where e.order_key = r.order_key and e.status = 'submitted');

-- The old Production-Plan based helpers are replaced.
drop function if exists public.ink_order_options();
drop function if exists public.order_plan_colours(uuid, timestamptz);
drop function if exists public.known_ink_formula(text, uuid, text, uuid, timestamptz);

-- The formula already saved for this colour with this paper type and category on
-- another order (the first one saved), or null. p_before: only records created before
-- that moment count (a record never borrows from one made after it).
create or replace function public.known_ink_formula(p_colour text, p_paper_type_id uuid, p_category text, p_order_key text,
                                                    p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('record_id', r.id, 'record_no', r.record_no, 'order_no', r.order_no, 'formula', c.formula)
  from public.ink_formula_records r
  join public.ink_formula_colours c on c.record_id = r.id
  where not r.archived
    and r.order_key is distinct from p_order_key
    and (p_before is null or r.created_at < p_before)
    and r.paper_type_id = p_paper_type_id
    and public.colour_key(r.category) = public.colour_key(p_category)
    and public.colour_key(c.colour) = public.colour_key(p_colour)
    and nullif(btrim(coalesce(c.formula, '')), '') is not null
  order by r.created_at, r.record_no
  limit 1;
$$;

-- The colours of an order, from the Planned Colours of its saved production entries.
create or replace function public.order_entry_colours(p_order_no text, p_before timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with e as (
    select x.* from public.production_entries x
    where x.order_key = lower(btrim(coalesce(p_order_no, ''))) and x.status = 'submitted'
      and public.has_perm('ink_formula', 'view')
  ),
  latest as (select e.order_key, e.paper_type_id, e.category from e order by e.production_date desc, e.created_at desc limit 1),
  c as (
    select btrim(u.colour) as colour,
           case when e.print_side in ('B/B F', 'B/B B') then 'B/B' else e.print_side end as side,
           row_number() over (order by e.production_date, e.created_at, u.n) as pos
    from e cross join lateral unnest(e.planned_colours) with ordinality as u(colour, n)
    where nullif(btrim(u.colour), '') is not null
  ),
  g as (
    -- shown as written; for codes like 185 / P185 the P form is preferred
    select public.colour_key(colour) as k,
           (array_agg(colour order by (colour ~ '^P[0-9]') desc, (colour ~* '^(p|pms|pantone)[^a-z]*[0-9]') desc, pos))[1] as colour,
           min(pos) as pos,
           coalesce(array_agg(distinct side order by side) filter (where side is not null), '{}') as sides
    from c group by public.colour_key(colour)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'colour', g.colour, 'sides', to_jsonb(g.sides),
           'standard', public.is_standard_colour(g.colour),
           'known', case when public.is_standard_colour(g.colour) then null
                         else public.known_ink_formula(g.colour, latest.paper_type_id, latest.category, latest.order_key, p_before) end)
         order by g.pos), '[]'::jsonb)
  from g cross join latest;
$$;

-- Orders for Ink Formula Entry: orders with saved production entries that have a
-- formula record, or at least one colour that still needs a formula.
create or replace function public.ink_order_options()
returns table (order_no text, cso_no text, job_name text, category text, last_production_date date, paper_type text,
               record_id uuid, record_no bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with o as (
    select distinct on (e.order_key) e.order_key, e.order_no, e.cso_no, e.job_name, e.category, e.paper_type_id,
           max(e.production_date) over (partition by e.order_key) as last_date
    from public.production_entries e
    where e.status = 'submitted' and e.order_key is not null
    order by e.order_key, e.production_date desc, e.created_at desc
  )
  select o.order_no, o.cso_no, o.job_name, o.category, o.last_date, p.name, r.id, r.record_no
  from o
  left join public.paper_types p on p.id = o.paper_type_id
  left join public.ink_formula_records r on r.order_key = o.order_key and not r.archived
  where public.has_perm('ink_formula', 'view')
    and (r.id is not null or exists (
      select 1 from public.production_entries e cross join lateral unnest(e.planned_colours) as u(colour)
      where e.order_key = o.order_key and e.status = 'submitted'
        and nullif(btrim(u.colour), '') is not null
        and not public.is_standard_colour(u.colour)
        and public.known_ink_formula(u.colour, o.paper_type_id, o.category, o.order_key) is null))
  order by o.last_date desc, o.order_no;
$$;

-- Saving: the order must have a saved production entry; colours come from the entries.
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
  v_last public.production_entries; -- latest saved production entry of the order
  v_key text;
  v_job_id uuid;
  v_plan_date date;
  v_prod_date date;
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
    v_key := v_rec.order_key;
    select coalesce(jsonb_agg(jsonb_build_object('colour', c.colour, 'sides', to_jsonb(c.sides), 'formula', c.formula) order by c.line), '[]'::jsonb)
      into v_old
    from public.ink_formula_colours c where c.record_id = v_rec.id;
  else
    if not public.has_perm('ink_formula', 'create') then
      raise exception 'You do not have permission to create ink formulas' using errcode = '42501';
    end if;
    v_key := lower(btrim(coalesce(p_order_no, '')));
    if not exists (select 1 from public.production_entries e where e.order_key = v_key and e.status = 'submitted') then
      return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors',
        jsonb_build_array(jsonb_build_object('field', 'order_no', 'message', 'Select a production order that has a saved production entry.')));
    end if;
    select * into v_other from public.ink_formula_records r where r.order_key = v_key and not r.archived;
    if found then
      return jsonb_build_object('ok', false, 'code', 'EXISTS', 'id', v_other.id, 'record_no', v_other.record_no,
        'message', format('Production order %s already has ink formula IF-%s. Open it to make changes.', v_other.order_no, lpad(v_other.record_no::text, 5, '0')));
    end if;
  end if;

  -- The order as saved in Production Entry (latest saved entry), and its plan if any.
  select * into v_last from public.production_entries e
  where e.order_key = v_key and e.status = 'submitted'
  order by e.production_date desc, e.created_at desc
  limit 1;
  v_prod_date := (select max(e.production_date) from public.production_entries e where e.order_key = v_key and e.status = 'submitted');
  select j.id, j.plan_date into v_job_id, v_plan_date from public.production_jobs j where lower(btrim(j.order_no)) = v_key;

  -- Colours allowed: the plan's colours now, plus colours already on the record.
  -- The standard process colours C, M, Y, K never take a formula.
  -- Colours that already have a formula for this paper type and category on an
  -- earlier order are not asked again (shown with that formula instead).
  v_plan := case when v_last.id is not null
                 then public.order_entry_colours(v_key, case when v_exists then v_rec.created_at end) else '[]'::jsonb end;
  v_allowed := array(select public.colour_key(x ->> 'colour') from jsonb_array_elements(v_plan || v_old) x
                     where not public.is_standard_colour(x ->> 'colour')
                       and not exists (select 1 from jsonb_array_elements(v_plan) k
                                       where public.colour_key(k ->> 'colour') = public.colour_key(x ->> 'colour')
                                         and jsonb_typeof(k -> 'known') = 'object'));
  if not v_exists and cardinality(v_allowed) = 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID', 'errors', jsonb_build_array(jsonb_build_object('field', 'colours',
      'message', 'This production order needs no new ink formula: its colours are standard (C, M, Y, K) or already have a formula for this paper type and category.')));
  end if;
  v_paper := (select p.name from public.paper_types p where p.id = v_last.paper_type_id);

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
    -- keep one spelling per colour: as already saved on the record, else as the order shows it
    v_colour := coalesce(
      (select x ->> 'colour' from jsonb_array_elements(v_old) x where public.colour_key(x ->> 'colour') = public.colour_key(v_colour) limit 1),
      (select x ->> 'colour' from jsonb_array_elements(v_plan) x where public.colour_key(x ->> 'colour') = public.colour_key(v_colour) limit 1),
      v_colour);
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
      -- refresh the job snapshot from the latest saved production entry
      job_id = coalesce(v_job_id, job_id),
      job_name = coalesce(v_last.job_name, job_name),
      paper_type = coalesce(v_paper, paper_type),
      paper_type_id = coalesce(v_last.paper_type_id, paper_type_id),
      category = coalesce(v_last.category, category),
      plan_date = coalesce(v_plan_date, plan_date),
      production_date = coalesce(v_prod_date, production_date)
    where id = v_rec.id
    returning * into v_rec;
  else
    insert into public.ink_formula_records (job_id, order_no, job_name, category, plan_date, production_date, paper_type, paper_type_id,
                                           created_by_name, updated_by_name)
    values (v_job_id, v_last.order_no, v_last.job_name, v_last.category, v_plan_date, v_prod_date, v_paper, v_last.paper_type_id, v_name, v_name)
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

revoke execute on function
  public.known_ink_formula(text, uuid, text, text, timestamptz),
  public.order_entry_colours(text, timestamptz),
  public.ink_order_options(),
  public.save_ink_formula(uuid, text, jsonb, text, timestamptz)
from public, anon;
grant execute on function
  public.order_entry_colours(text, timestamptz),
  public.ink_order_options(),
  public.save_ink_formula(uuid, text, jsonb, text, timestamptz)
to authenticated;
