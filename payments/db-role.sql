-- Run after creating the LOGIN role `mentori_payments` and after the payment
-- migration. The role remains subject to RLS and can access only these paths.
alter role mentori_payments nobypassrls;

grant connect on database postgres to mentori_payments;
grant usage on schema public to mentori_payments;
grant select, update on public.crm_state, public.client_snapshots to mentori_payments;
grant select, update on public.client_orders to mentori_payments;
revoke insert, delete on public.client_orders from mentori_payments;
grant select, insert, update on public.payment_transactions to mentori_payments;
grant select, insert on public.payment_webhook_events to mentori_payments;
grant insert on public.notification_outbox to mentori_payments;
grant usage, select on sequence public.payment_transactions_id_seq to mentori_payments;
grant usage, select on sequence public.payment_webhook_events_id_seq to mentori_payments;
grant usage, select on sequence public.notification_outbox_id_seq to mentori_payments;

drop policy if exists payments_crm_state_select on public.crm_state;
create policy payments_crm_state_select on public.crm_state
  for select to mentori_payments using (id = 'main');
drop policy if exists payments_crm_state_update on public.crm_state;
create policy payments_crm_state_update on public.crm_state
  for update to mentori_payments using (id = 'main') with check (id = 'main');

drop policy if exists payments_snapshots_select on public.client_snapshots;
create policy payments_snapshots_select on public.client_snapshots
  for select to mentori_payments using (true);
drop policy if exists payments_snapshots_update on public.client_snapshots;
create policy payments_snapshots_update on public.client_snapshots
  for update to mentori_payments using (true) with check (true);

drop policy if exists payments_orders_select on public.client_orders;
create policy payments_orders_select on public.client_orders
  for select to mentori_payments using (true);
drop policy if exists payments_orders_update on public.client_orders;
create policy payments_orders_update on public.client_orders
  for update to mentori_payments using (true) with check (true);

drop policy if exists payments_transactions_select on public.payment_transactions;
create policy payments_transactions_select on public.payment_transactions
  for select to mentori_payments using (true);
drop policy if exists payments_transactions_insert on public.payment_transactions;
create policy payments_transactions_insert on public.payment_transactions
  for insert to mentori_payments with check (true);
drop policy if exists payments_transactions_update on public.payment_transactions;
create policy payments_transactions_update on public.payment_transactions
  for update to mentori_payments using (true) with check (true);

drop policy if exists payments_webhook_select on public.payment_webhook_events;
create policy payments_webhook_select on public.payment_webhook_events
  for select to mentori_payments using (true);
drop policy if exists payments_webhook_insert on public.payment_webhook_events;
create policy payments_webhook_insert on public.payment_webhook_events
  for insert to mentori_payments with check (true);

drop policy if exists payments_outbox_insert on public.notification_outbox;
create policy payments_outbox_insert on public.notification_outbox
  for insert to mentori_payments with check (true);
