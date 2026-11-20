-- Colour codes: the same Pantone colour is written in different ways, e.g. P185,
-- p185, 185, P.185, P 185, PMS 185. They now count as one colour everywhere colours
-- are compared (ink formulas, "formula already known", colour changes per unit).
--
-- Rule: ignore case, spaces and punctuation; a leading P / PMS / Pantone directly
-- followed by a number is dropped (P185 → 185). Names like Pblue072, Gold or Texture
-- are compared as they are (case, spaces and punctuation ignored).
-- Nothing stored changes; the colour is still shown as it was entered.

create or replace function public.colour_key(p_colour text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(lower(regexp_replace(coalesce(p_colour, ''), '[^A-Za-z0-9]', '', 'g')),
                        '^(pantone|pms|p)([0-9])', '\2');
$$;
