begin;

-- user_metadata is editable by the signed-in user and must never grant access.
drop policy if exists client_orders_owner_all on public.client_orders;
create policy client_orders_owner_all on public.client_orders
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'owner');

notify pgrst, 'reload schema';
commit;
