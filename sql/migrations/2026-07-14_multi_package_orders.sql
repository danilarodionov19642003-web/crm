begin;

alter table public.client_orders add column if not exists parent_order_id bigint;
alter table public.client_orders add column if not exists parent_item_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_orders'::regclass
      and conname = 'client_orders_parent_order_id_fkey'
  ) then
    alter table public.client_orders
      add constraint client_orders_parent_order_id_fkey
      foreign key (parent_order_id) references public.client_orders(id) on delete cascade;
  end if;
end
$$;

create unique index if not exists client_orders_parent_item_idx
  on public.client_orders(parent_order_id, parent_item_id)
  where parent_order_id is not null;

drop policy if exists client_orders_auth_insert on public.client_orders;
create policy client_orders_auth_insert
  on public.client_orders for insert to authenticated
  with check (
    client_email = (auth.jwt() ->> 'email')
    and parent_order_id is null
    and parent_item_id is null
    and order_type is distinct from 'package_item'
    and status = 'new'
    and confirmed_at is null
    and remainder_status is null
    and payment_provider is null
    and payment_id is null
    and payment_status is null
    and payment_url is null
    and payment_environment is null
    and payment_created_at is null
    and payment_paid_at is null
  );

grant insert on public.client_orders to mentori_payments;
grant usage, select on sequence public.client_orders_id_seq to mentori_payments;

drop policy if exists payments_orders_insert on public.client_orders;
create policy payments_orders_insert on public.client_orders
  for insert to mentori_payments with check (
    parent_order_id is not null and order_type = 'package_item'
  );

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
  if NEW.parent_order_id is not null or NEW.order_type = 'package_item' then
    return NEW;
  end if;

  if NEW.order_type = 'multi_order' then
    select coalesce(string_agg(
      case when coalesce(item->>'is_new_anketa', 'false') = 'true'
        then 'новая «' || coalesce(item->>'anketa_name', '—') || '»'
        else coalesce(item->>'anketa_code', item->>'anketa_name', '—')
      end || ' — ' || coalesce(item->>'tariff_name', 'тариф'),
      ', '
    ), 'составной заказ')
    into target_label
    from jsonb_array_elements(
      case when jsonb_typeof(NEW.items) = 'array' then NEW.items else '[]'::jsonb end
    ) item;
  else
    target_label := case
      when NEW.order_type = 'remainder' then coalesce(NEW.anketa_name, '—')
      when NEW.is_new_anketa then 'новая «' || coalesce(NEW.anketa_name, '—') || '»'
      else coalesce(NEW.anketa_code, NEW.anketa_name, '—')
    end;
  end if;

  msg := '🧾 Новый заказ · ожидает онлайн-оплату' || E'\n'
      || '👤 ' || coalesce(NEW.client_name, NEW.client_email, 'клиент') || E'\n'
      || case when NEW.order_type = 'multi_order' then 'Пакеты: ' else 'Анкета: ' end
      || target_label || E'\n'
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
