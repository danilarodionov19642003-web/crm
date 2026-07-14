begin;

alter table public.client_orders add column if not exists payment_provider text;
alter table public.client_orders add column if not exists payment_id text;
alter table public.client_orders add column if not exists payment_status text;
alter table public.client_orders add column if not exists payment_url text;
alter table public.client_orders add column if not exists payment_environment text;
alter table public.client_orders add column if not exists payment_created_at timestamptz;
alter table public.client_orders add column if not exists payment_paid_at timestamptz;

create table if not exists public.payment_transactions (
  id bigserial primary key,
  client_order_id bigint not null references public.client_orders(id) on delete restrict,
  client_email text not null,
  provider_order_id text not null unique,
  provider_payment_id text unique,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'RUB',
  status text not null,
  pay_url text,
  environment text not null default 'production',
  expires_at timestamptz,
  paid_at timestamptz,
  business_applied_at timestamptz,
  requires_manual_review boolean not null default false,
  apply_note text,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_transactions_one_active_order_idx
  on public.payment_transactions(client_order_id)
  where status in ('initiating','created','processing');
create index if not exists payment_transactions_order_idx
  on public.payment_transactions(client_order_id, created_at desc);

-- A payment link can still be completed after an administrator opens the CRM.
-- Keep the order and audit row together instead of cascading away a live payment.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.payment_transactions'::regclass
      and conname = 'payment_transactions_client_order_id_fkey'
      and confdeltype = 'c'
  ) then
    alter table public.payment_transactions
      drop constraint payment_transactions_client_order_id_fkey;
    alter table public.payment_transactions
      add constraint payment_transactions_client_order_id_fkey
      foreign key (client_order_id) references public.client_orders(id) on delete restrict;
  end if;
end
$$;

create table if not exists public.payment_webhook_events (
  id bigserial primary key,
  event_key text not null unique,
  event_type text,
  provider_payment_id text,
  provider_timestamp text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.payment_transactions enable row level security;
alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_transactions from public, anon, authenticated;
revoke all on public.payment_webhook_events from public, anon, authenticated;

-- An order exists before money is received. Notify without confirmation
-- buttons; the signed payment.paid callback performs confirmation itself.
create or replace function public.notify_owner_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_chat bigint := 6876234451;
  target_label text;
  msg text;
begin
  target_label := case
    when NEW.order_type = 'remainder' then coalesce(NEW.anketa_name, '—')
    when NEW.is_new_anketa then 'новая «' || coalesce(NEW.anketa_name, '—') || '»'
    else coalesce(NEW.anketa_code, NEW.anketa_name, '—')
  end;
  msg := '🧾 Новый заказ · ожидает онлайн-оплату' || E'\n'
      || '👤 ' || coalesce(NEW.client_name, NEW.client_email, 'клиент') || E'\n'
      || 'Анкета: ' || target_label || E'\n'
      || 'К оплате: ' || trim(to_char(
           case when NEW.order_type = 'remainder'
                then coalesce(NEW.amount, 0)
                else coalesce(NEW.prepay_amount, NEW.amount, 0) end,
           'FM999999990')) || ' ₽';
  insert into public.notification_outbox
    (telegram_chat_id, kind, message, status, mentor_id, client_email)
  values (owner_chat, 'client_order_pending_payment', msg, 'pending', NEW.id::text, NEW.client_email);
  return NEW;
end;
$$;

notify pgrst, 'reload schema';
commit;
