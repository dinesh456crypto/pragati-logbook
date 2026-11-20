-- Changeover (Job Changeover, Registration, Colour Matching) is required for every
-- entry that is not a continuing job, B/B F and B/B B included.
-- Before: a B/B side needed the changeover only on the first entry of the order, so
-- the B/B B side had it optional (and its Registration / Colour Matching start times
-- did not fill in automatically).
-- Saved entries are not changed; the rule applies when an entry is saved.

create or replace function public.changeover_required(p_side text, p_continuing boolean, p_first boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not coalesce(p_continuing, false);
$$;
