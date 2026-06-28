-- ===========================================================================
-- client_orders — заявки клиентов на оплату/заказ отзывов из личного кабинета.
--
-- Клиент в кабинете жмёт «Заказать отзывы» → выбирает тариф и анкету
-- (существующую или новую) → видит реквизиты → жмёт «Я оплатил».
-- Кабинет (под JWT клиента) вставляет строку сюда. RLS пускает клиента
-- вставлять/читать ТОЛЬКО свои заявки (по email из JWT).
--
-- AFTER INSERT триггер кладёт пинг владельцу в notification_outbox →
-- уже работающий notifier (tg/backend/notifier.py) шлёт его в Telegram.
-- Передеплой Python-бэкенда НЕ нужен.
--
-- Запускать в SQL Editor / psql под ролью postgres. Всё идемпотентно.
-- ===========================================================================

create table if not exists public.client_orders (
  id            bigserial primary key,

  -- кто заказал (client_email = ключ RLS, совпадает с auth.jwt()->>'email')
  client_email  text,
  client_name   text,

  -- на какую анкету
  anketa_code   text,                       -- код существующей анкеты (a15) или null
  anketa_name   text,                       -- имя анкеты (новой — обязательно)
  is_new_anketa boolean not null default false,

  -- что заказали
  tariff_name   text,
  tariff_price  numeric,                      -- цена тарифа (пакет — итог; опт — за штуку)
  qty           int,                          -- кол-во отзывов (пакет — из тарифа; опт — выбрал клиент)
  amount        numeric,                      -- ПОЛНАЯ сумма заказа (итог)
  pay_full      boolean default false,        -- клиент выбрал оплату 100% сразу (иначе 50% предоплата)
  prepay_amount numeric,                      -- сколько внесено при заказе (50% или 100% от amount)
  remainder_status text,                      -- null|pending — есть ли у заказа неоплаченные 50%
  order_type    text default 'order',         -- 'order' (новый заказ отзывов) | 'remainder' (доплата остатка)
  items         jsonb,                         -- для remainder: [{code,name,amount}] по анкетам
  comment       text,
  profile_url   text,                         -- ссылка на профиль клиента (упрощает работу владельцу)
  receipt_url   text,                         -- публичная ссылка на чек (Supabase Storage, bucket receipts)
  offer_agreed  boolean default false,        -- клиент поставил галочку согласия с офертой
  offer_text    text,                          -- СНИМОК текста условий на момент заказа (пруф согласия)

  -- обработка владельцем
  status        text not null default 'new', -- new | confirmed | rejected
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  created_by    text
);

-- Идемпотентно для уже созданной таблицы (на Beget создана без profile_url):
alter table public.client_orders add column if not exists profile_url text;
alter table public.client_orders add column if not exists receipt_url text;
alter table public.client_orders add column if not exists offer_agreed boolean default false;
alter table public.client_orders add column if not exists offer_text text;
alter table public.client_orders add column if not exists pay_full boolean default false;
alter table public.client_orders add column if not exists prepay_amount numeric;
alter table public.client_orders add column if not exists remainder_status text;
alter table public.client_orders add column if not exists order_type text default 'order';
alter table public.client_orders add column if not exists items jsonb;

create index if not exists client_orders_status_idx
  on public.client_orders (status, created_at);
create index if not exists client_orders_email_idx
  on public.client_orders (client_email);

alter table public.client_orders enable row level security;

-- Клиент (authenticated, под своим JWT) вставляет ТОЛЬКО свою заявку —
-- email в строке обязан совпадать с email из токена (нельзя подделать чужую).
drop policy if exists client_orders_auth_insert on public.client_orders;
create policy client_orders_auth_insert
  on public.client_orders for insert to authenticated
  with check (client_email = (auth.jwt() ->> 'email'));

-- Клиент видит только свои заявки.
drop policy if exists client_orders_auth_select on public.client_orders;
create policy client_orders_auth_select
  on public.client_orders for select to authenticated
  using (client_email = (auth.jwt() ->> 'email'));

-- Владелец (role='owner' в JWT-метаданных) видит и ПРАВИТ все заявки —
-- для раздела «Заявки» в CRM: подтверждение/отклонение оплаты. Permissive-
-- политики OR-ятся: клиент видит свои, владелец — все.
drop policy if exists client_orders_owner_all on public.client_orders;
create policy client_orders_owner_all on public.client_orders
  for all to authenticated
  using ( coalesce(auth.jwt() -> 'user_metadata' ->> 'role',
                   auth.jwt() -> 'app_metadata' ->> 'role') = 'owner' )
  with check ( coalesce(auth.jwt() -> 'user_metadata' ->> 'role',
                        auth.jwt() -> 'app_metadata' ->> 'role') = 'owner' );

-- ВАЖНО: RLS отдельно от table-GRANT. На этой инсталляции CRM-фронт и кабинет
-- ходят под ролью `authenticated` (JWT), `anon` не используется. У новой таблицы
-- table-grant'ов нет по умолчанию — выдаём их явно, иначе даже валидный JWT
-- получит "permission denied for table" ДО проверки RLS.
-- подчистка ранее созданных (ненужных) anon-политик, если остались
drop policy if exists client_orders_anon_select on public.client_orders;
drop policy if exists client_orders_anon_update on public.client_orders;

grant select, insert, update, delete on public.client_orders to authenticated;
grant usage, select on sequence public.client_orders_id_seq to authenticated;
-- service_role (notifier / будущий админ-бэкенд) уже имеет всё; на всякий случай:
grant all on public.client_orders to service_role;
grant usage, select on sequence public.client_orders_id_seq to service_role;
-- Будущий CRM-инбокс заявок (чтение ВСЕХ владельцем) сделаем позже отдельной
-- ролевой политикой или через service_role — сейчас уведомление идёт в Telegram.

-- ── Пинг владельцу в Telegram через notification_outbox ────────────────────
-- SECURITY DEFINER: функция исполняется под владельцем БД (postgres) и обходит
-- RLS notification_outbox. owner_chat_id зашит ЗДЕСЬ (server-side) — клиентский
-- JS его не видит и не может выбрать получателя/текст сам.
create or replace function public.notify_owner_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_chat bigint := 6876234451;   -- bot_owner_chat_id (@MentoriTG_bot)
  anketa_lbl text;
  tariff_lbl text;
  pay_lbl text;
  msg text;
begin
  if NEW.order_type = 'remainder' then
    -- доплата остатка по анкетам (anketa_name = сводка кодов, items = разбивка)
    msg := '💰 Доплата остатка!' || E'\n'
        || '👤 ' || coalesce(NEW.client_name, NEW.client_email, 'клиент') || E'\n'
        || 'Анкеты: ' || coalesce(NEW.anketa_name, '—') || E'\n'
        || 'Итого: ' || trim(to_char(coalesce(NEW.amount, 0), 'FM999999990')) || ' ₽'
        || case when coalesce(NEW.receipt_url, '') <> '' then E'\n🧾 чек: ' || NEW.receipt_url else '' end
        || case when coalesce(NEW.comment, '') <> '' then E'\n💬 ' || NEW.comment else '' end;
  else
    anketa_lbl := case
      when NEW.is_new_anketa
        then 'новая «' || coalesce(NEW.anketa_name, '—') || '»'
      else coalesce(NEW.anketa_code, '') ||
           case when coalesce(NEW.anketa_name, '') <> ''
                then ' (' || NEW.anketa_name || ')' else '' end
    end;
    tariff_lbl := coalesce(NEW.tariff_name, '—')
      || case when NEW.qty is not null then ' · ' || NEW.qty || ' шт' else '' end
      || case when NEW.amount is not null
              then ' · ' || trim(to_char(NEW.amount, 'FM999999990')) || ' ₽' else '' end;
    pay_lbl := (case when NEW.pay_full then 'оплачено полностью' else 'предоплата 50%' end)
      || case when NEW.prepay_amount is not null
              then ': ' || trim(to_char(NEW.prepay_amount, 'FM999999990')) || ' ₽' else '' end;
    msg := '💰 Новая оплата!' || E'\n'
        || '👤 ' || coalesce(NEW.client_name, NEW.client_email, 'клиент') || E'\n'
        || 'Анкета: ' || anketa_lbl || E'\n'
        || 'Тариф: ' || tariff_lbl || E'\n'
        || '💳 ' || pay_lbl
        || case when coalesce(NEW.profile_url, '') <> '' then E'\n🔗 ' || NEW.profile_url else '' end
        || case when coalesce(NEW.receipt_url, '') <> '' then E'\n🧾 чек: ' || NEW.receipt_url else '' end
        || case when coalesce(NEW.comment, '') <> '' then E'\n💬 ' || NEW.comment else '' end;
  end if;

  -- mentor_id переиспользуем под order_id — notifier берёт его для callback-кнопок.
  insert into public.notification_outbox
    (telegram_chat_id, kind, message, status, mentor_id)
  values (owner_chat, 'client_order', msg, 'pending', NEW.id::text);
  return NEW;
end;
$$;

drop trigger if exists client_orders_notify_trg on public.client_orders;
create trigger client_orders_notify_trg
  after insert on public.client_orders
  for each row execute function public.notify_owner_new_order();

-- Trim: держим максимум 5000 строк, чтобы таблица не разрасталась.
-- SECURITY DEFINER: вставку делает роль authenticated (у неё НЕТ DELETE —
-- и не должно быть), а триггер чистит старьё. Без definer trim падал бы
-- "permission denied" и валил INSERT клиента.
create or replace function public.trim_client_orders()
returns trigger language plpgsql
security definer set search_path = public as $$
begin
  delete from public.client_orders
  where id <= coalesce(
    (select id from public.client_orders order by id desc offset 5000 limit 1), -1);
  return null;
end;
$$;

drop trigger if exists trim_client_orders_trg on public.client_orders;
create trigger trim_client_orders_trg
  after insert on public.client_orders
  for each statement execute function public.trim_client_orders();

-- ⚠️ ОБЯЗАТЕЛЬНО после создания таблицы: PostgREST держит схему в кэше и НЕ
-- увидит новую таблицу на запись (POST → 404), пока кэш не перезагрузить.
-- На этой инсталляции нет DDL-триггера авто-reload, поэтому делаем вручную:
NOTIFY pgrst, 'reload schema';

-- Проверка:
--   \d public.client_orders
--   select polname, polcmd from pg_policies where tablename='client_orders';
