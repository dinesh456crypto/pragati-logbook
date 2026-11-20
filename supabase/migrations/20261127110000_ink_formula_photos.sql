-- Ink formula sample photos: when a formula is entered or edited, a photo of the job
-- sample can be added for future reference.
--
--   * Photos are kept in the private Storage bucket "ink-photos", one folder per
--     formula record: <record id>/<photo id>.jpg (the app makes them smaller first).
--   * ink_formula_photos lists them, with the revision they were added with and who
--     added them. Anyone who can view ink formulas can see them.
--   * Adding: users who can edit ink formulas, or the creator of the record.
--     Removing: users who can edit ink formulas.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ink-photos', 'ink-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create table public.ink_formula_photos (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.ink_formula_records (id) on delete cascade,
  revision integer not null,
  path text not null unique check (length(path) <= 200),
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_by_name text,
  uploaded_at timestamptz not null default now()
);
create index ink_formula_photos_record_idx on public.ink_formula_photos (record_id, uploaded_at);

create trigger ink_formula_photos_audit
after insert or update or delete on public.ink_formula_photos
for each row execute function public.audit_row();

alter table public.ink_formula_photos enable row level security;
revoke all on public.ink_formula_photos from anon;
revoke insert, update, delete on public.ink_formula_photos from authenticated;
create policy ink_formula_photos_select on public.ink_formula_photos
  for select to authenticated using ((select public.has_perm('ink_formula', 'view')));

-- Storage: read with view permission, upload with create or edit, delete with edit.
create policy ink_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'ink-photos' and (select public.has_perm('ink_formula', 'view')));
create policy ink_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ink-photos'
              and ((select public.has_perm('ink_formula', 'create')) or (select public.has_perm('ink_formula', 'edit'))));
create policy ink_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'ink-photos' and (select public.has_perm('ink_formula', 'edit')));

-- Records an uploaded photo against the formula (at its current revision).
create or replace function public.add_ink_formula_photo(p_record_id uuid, p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec public.ink_formula_records;
  v_row public.ink_formula_photos;
begin
  if not public.is_active_user() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select * into v_rec from public.ink_formula_records where id = p_record_id;
  if not found then
    raise exception 'Formula record not found' using errcode = 'P0002';
  end if;
  if not (public.has_perm('ink_formula', 'edit')
          or (public.has_perm('ink_formula', 'create') and v_rec.created_by = auth.uid())) then
    raise exception 'You do not have permission to add photos to this ink formula' using errcode = '42501';
  end if;
  if v_rec.archived then
    return jsonb_build_object('ok', false, 'message', 'This formula record is archived. Restore it before adding photos.');
  end if;
  if coalesce(p_path, '') !~ ('^' || p_record_id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    return jsonb_build_object('ok', false, 'message', 'The photo could not be added (wrong file name).');
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'ink-photos' and o.name = p_path) then
    return jsonb_build_object('ok', false, 'message', 'The photo was not uploaded. Please try again.');
  end if;
  if (select count(*) from public.ink_formula_photos where record_id = p_record_id) >= 30 then
    return jsonb_build_object('ok', false, 'message', 'A formula can have at most 30 photos. Remove an old one first.');
  end if;
  insert into public.ink_formula_photos (record_id, revision, path, uploaded_by, uploaded_by_name)
  values (p_record_id, v_rec.revision, p_path, auth.uid(), (select p.full_name from public.profiles p where p.id = auth.uid()))
  on conflict (path) do nothing
  returning * into v_row;
  return jsonb_build_object('ok', true, 'id', v_row.id, 'revision', v_rec.revision);
end;
$$;

-- Removes a photo from the formula. Returns its file path, which the app then deletes
-- from Storage.
create or replace function public.remove_ink_formula_photo(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.ink_formula_photos;
begin
  if not public.is_active_user() or not public.has_perm('ink_formula', 'edit') then
    raise exception 'You do not have permission to remove ink formula photos' using errcode = '42501';
  end if;
  if exists (select 1 from public.ink_formula_photos f join public.ink_formula_records r on r.id = f.record_id
             where f.id = p_id and r.archived) then
    return jsonb_build_object('ok', false, 'message', 'This formula record is archived. Restore it before removing photos.');
  end if;
  delete from public.ink_formula_photos where id = p_id returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'This photo was already removed.');
  end if;
  return jsonb_build_object('ok', true, 'path', v_row.path);
end;
$$;

revoke execute on function public.add_ink_formula_photo(uuid, text), public.remove_ink_formula_photo(uuid) from public, anon;
grant execute on function public.add_ink_formula_photo(uuid, text), public.remove_ink_formula_photo(uuid) to authenticated;
