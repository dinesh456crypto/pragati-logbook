-- Wastage reasons get a category, like downtime reasons:
--   Material | Method | Others
-- Production Entry shows the wastage reasons as buttons in these three columns, and
-- Master → Wastage Reasons asks for the category first.
--
-- The reasons in use today are placed by name (spaces, punctuation and case ignored);
-- any other reason goes to Others and can be moved under Master.
-- (Downtime categories are unchanged in the database: Man / Machine / Material / Others.
--  The screens show Man as "Waiting/Approval" and Machine as "Breakdown".)

alter table public.wastage_reasons
  add column category text not null default 'Others'
  check (category in ('Material', 'Method', 'Others'));

update public.wastage_reasons r
set category = case
  when k in ('blanketpunch', 'scratchesonplate', 'boardbend', 'papercreasingissue', 'pickingpaperdust') then 'Material'
  when k in ('scum', 'colourmismatchvariation', 'colourmissmatchvariation', 'colormismatchvariation',
             'hickies', 'misregistration', 'setoff') then 'Method'
  else 'Others'
end
from (select id, lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) as k from public.wastage_reasons) x
where x.id = r.id;

create index wastage_reasons_category_idx on public.wastage_reasons (category);
