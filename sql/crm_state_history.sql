-- ===========================================================================
-- Таблица истории снимков crm_state — страховка от потерь данных.
-- Запускать ОДИН РАЗ в Supabase SQL Editor под ролью postgres
-- (не под impersonation!). Все шаги идемпотентны — можно перезапускать.
-- ===========================================================================

create table if not exists public.crm_state_history (
  id          bigserial primary key,
  state_id    text        not null default 'main',
  data        jsonb       not null,
  pushed_at   timestamptz not null default now(),
  client_info text
);

create index if not exists crm_state_history_pushed_at_idx
  on public.crm_state_history (pushed_at desc);

alter table public.crm_state_history enable row level security;

drop policy if exists "anon_insert_history" on public.crm_state_history;
drop policy if exists "anon_select_history" on public.crm_state_history;
drop policy if exists "anon_delete_history" on public.crm_state_history;

create policy "anon_insert_history"
  on public.crm_state_history
  for insert
  to anon
  with check (true);

create policy "anon_select_history"
  on public.crm_state_history
  for select
  to anon
  using (true);

create policy "anon_delete_history"
  on public.crm_state_history
  for delete
  to anon
  using (true);

-- Триггер: при каждой вставке режем всё, кроме последних 500 строк.
create or replace function public.trim_crm_state_history()
returns trigger language plpgsql as $$
begin
  delete from public.crm_state_history
  where id <= coalesce(
    (select id from public.crm_state_history order by id desc offset 500 limit 1),
    -1
  );
  return null;
end;
$$;

drop trigger if exists trim_crm_state_history_trg on public.crm_state_history;
create trigger trim_crm_state_history_trg
  after insert on public.crm_state_history
  for each statement
  execute function public.trim_crm_state_history();

-- Готово. Проверь, что таблица появилась:
--   select count(*) from public.crm_state_history;
