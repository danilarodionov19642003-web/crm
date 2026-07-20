begin;

alter table public.client_orders
  add column if not exists payment_method text;
alter table public.client_orders
  add column if not exists discount_amount numeric(14,2);

update public.client_orders
set payment_method = case
  when payment_provider = 'manual_transfer' then 'card_transfer'
  else 'online'
end
where payment_method is null;
update public.client_orders set discount_amount = 0 where discount_amount is null;

alter table public.client_orders alter column payment_method set default 'online';
alter table public.client_orders alter column payment_method set not null;
alter table public.client_orders alter column discount_amount set default 0;
alter table public.client_orders alter column discount_amount set not null;

alter table public.client_orders drop constraint if exists client_orders_payment_method_check;
alter table public.client_orders add constraint client_orders_payment_method_check
  check (payment_method in ('online', 'card_transfer'));
alter table public.client_orders drop constraint if exists client_orders_discount_amount_check;
alter table public.client_orders add constraint client_orders_discount_amount_check
  check (discount_amount >= 0 and discount_amount <= 300);

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
    and (
      (payment_method = 'online' and discount_amount = 0 and receipt_url is null)
      or
      (payment_method = 'card_transfer' and discount_amount = 300 and receipt_url is not null)
    )
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
  order_kind text;
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

  order_kind := case when NEW.payment_method = 'card_transfer'
    then 'перевод по реквизитам · проверь чек'
    else 'ожидает онлайн-оплату'
  end;
  msg := '🧾 Новый заказ · ' || order_kind || E'\n'
      || '👤 ' || coalesce(NEW.client_name, NEW.client_email, 'клиент') || E'\n'
      || case when NEW.order_type = 'multi_order' then 'Пакеты: ' else 'Анкета: ' end
      || target_label || E'\n'
      || 'К оплате: ' || trim(to_char(
           case when NEW.order_type = 'remainder'
                then coalesce(NEW.amount, 0)
                else coalesce(NEW.prepay_amount, NEW.amount, 0) end,
           'FM999999990')) || ' ₽'
      || case when NEW.discount_amount > 0
           then E'\nСкидка за перевод: ' || trim(to_char(NEW.discount_amount, 'FM999999990')) || ' ₽'
           else '' end;
  insert into public.notification_outbox
    (telegram_chat_id, kind, message, status, mentor_id, client_email)
  values (
    owner_chat,
    case when NEW.payment_method = 'card_transfer'
      then 'client_order_manual_review' else 'client_order_pending_payment' end,
    msg, 'pending', NEW.id::text, NEW.client_email
  );
  return NEW;
end;
$$;

notify pgrst, 'reload schema';
commit;
