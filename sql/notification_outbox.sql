-- ===========================================================================
-- notification_outbox — изолированная очередь уведомлений в Telegram.
--
-- Зачем: когда в CRM меняется статус аккаунта, фронт пишет одну строку сюда.
-- Telegram-бот (Python, /Users/mentori/tg) опрашивает таблицу, шлёт сообщения
-- клиентам и помечает строки как sent. Сам crm_state бот НИ ПРИ КАКИХ
-- ОБСТОЯТЕЛЬСТВАХ не трогает — это важно после катастрофы 11.05.2026.
--
-- Запускать в SQL Editor под ролью postgres (НЕ под impersonation).
-- Все шаги идемпотентны.
-- ===========================================================================

create table if not exists public.notification_outbox (
  id                bigserial primary key,

  -- адресат
  client_email      text,
  telegram_chat_id  bigint,
  telegram_username text,

  -- что отправить
  kind              text not null default 'status_change',
  message           text not null,

  -- ссылки на исходные сущности (для дедупа/отладки)
  mentor_id         text,
  profile_id        text,
  action_ref        text,
  new_status        text,
  old_status        text,

  -- состояние доставки
  status            text not null default 'pending',  -- pending | sent | failed | skipped
  attempts          int  not null default 0,
  last_error        text,

  -- временные метки
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,

  -- авторство (на всякий)
  created_by        text
);

-- Поллер бота берёт pending в порядке created_at — индекс важен.
create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (status, created_at)
  where status = 'pending';

alter table public.notification_outbox enable row level security;

drop policy if exists "anon_insert_outbox" on public.notification_outbox;
drop policy if exists "anon_select_outbox" on public.notification_outbox;
drop policy if exists "anon_update_outbox" on public.notification_outbox;

-- Админка (anon ключ) — может создавать записи.
create policy "anon_insert_outbox"
  on public.notification_outbox
  for insert to anon
  with check (true);

-- Чтение и апдейт открыты для anon чтобы из админки можно было посмотреть
-- очередь / ретраить вручную. Бот ходит под service_role и RLS обходит.
create policy "anon_select_outbox"
  on public.notification_outbox
  for select to anon
  using (true);

create policy "anon_update_outbox"
  on public.notification_outbox
  for update to anon
  using (true) with check (true);

-- Триггер-страховка от роста: держим максимум 5000 строк
-- (отправленных можно чистить регулярно, но на крайний случай trim).
create or replace function public.trim_notification_outbox()
returns trigger language plpgsql as $$
begin
  delete from public.notification_outbox
  where id <= coalesce(
    (select id from public.notification_outbox order by id desc offset 5000 limit 1),
    -1
  );
  return null;
end;
$$;

drop trigger if exists trim_notification_outbox_trg on public.notification_outbox;
create trigger trim_notification_outbox_trg
  after insert on public.notification_outbox
  for each statement
  execute function public.trim_notification_outbox();

-- Проверь, что таблица появилась:
--   select count(*) from public.notification_outbox;
