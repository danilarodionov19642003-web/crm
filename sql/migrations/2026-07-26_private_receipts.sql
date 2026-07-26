begin;

update storage.buckets
set public = false
where id = 'receipts';

drop policy if exists receipts_auth_insert on storage.objects;
create policy receipts_auth_insert on storage.objects
  for insert to public
  with check (
    bucket_id = 'receipts'
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'client'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists receipts_auth_select on storage.objects;
create policy receipts_auth_select on storage.objects
  for select to public
  using (
    bucket_id = 'receipts'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or split_part(name, '/', 1) = auth.uid()::text
      or exists (
        select 1
        from public.client_orders co
        where co.client_email = (auth.jwt() ->> 'email')
          and (
            co.receipt_url = 'storage://receipts/' || name
            or co.receipt_url like '%/object/public/receipts/' || name
          )
      )
    )
  );

commit;
