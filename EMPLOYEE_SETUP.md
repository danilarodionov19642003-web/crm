# Employee CRM — настройка Supabase

Этот файл описывает, что нужно один раз выполнить в Supabase, чтобы заработал
сотруднический интерфейс (`pages/employee/...`) поверх уже существующего
JSONB-blob (`crm_state`).

Новые таблицы:

| Таблица    | Назначение                                                         |
|------------|--------------------------------------------------------------------|
| `accounts` | Зеркало анкет клиентов (id, code, name, ordered, done, assigned…)  |
| `tasks`    | Отзывы, оставленные сотрудником. Триггер инкрементит `accounts.done` |

Сотрудник логинится через **Supabase Auth (email + password)** и видит только
свои анкеты. Админ продолжает работать без логина (через анон-ключ), как и
раньше — но эти таблицы доступны ему на чтение/запись по тем же правилам,
что и `crm_state`.

---

## 1) Создать таблицы и политики

В Supabase Dashboard → SQL Editor → New query → вставить и выполнить:

```sql
-- ============================================================================
-- ACCOUNTS — зеркало анкет (синхронизируется из админки)
-- ============================================================================
create table if not exists public.accounts (
  id              text primary key,            -- тот же id, что в crm_state.clients[].id
  code            text,                        -- "A15"
  name            text,                        -- "Варвара Лукашкина"
  ordered         int  not null default 0,     -- сколько отзывов заказано
  done            int  not null default 0,     -- сколько отзывов сделано (только триггером!)
  assigned_email  text,                        -- email сотрудника (lowercase)
  avatar_url      text,
  updated_at      timestamptz not null default now()
);

create index if not exists accounts_assigned_email_idx
  on public.accounts (assigned_email);

-- ============================================================================
-- TASKS — отзывы
-- ============================================================================
create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  account_id      text not null references public.accounts(id) on delete cascade,
  employee_email  text not null,
  text            text not null,
  published_at    date not null,
  status          text not null default 'новый'
                  check (status in ('новый','проверено')),
  created_at      timestamptz not null default now()
);

create index if not exists tasks_account_idx  on public.tasks (account_id);
create index if not exists tasks_employee_idx on public.tasks (employee_email);
create index if not exists tasks_status_idx   on public.tasks (status);

-- ============================================================================
-- RLS: политика как у crm_state — anon-ключ имеет полный доступ
--      (publishable key = одна из «доверенных» точек системы).
-- ============================================================================
alter table public.accounts enable row level security;
alter table public.tasks    enable row level security;

drop policy if exists "accounts open" on public.accounts;
drop policy if exists "tasks open"    on public.tasks;

create policy "accounts open" on public.accounts
  for all using (true) with check (true);

create policy "tasks open" on public.tasks
  for all using (true) with check (true);

-- ============================================================================
-- ТРИГГЕРЫ: при INSERT в tasks инкрементируем accounts.done и
--           проверяем лимит. При DELETE — откатываем.
-- ============================================================================
create or replace function public.bump_account_done()
returns trigger language plpgsql security definer as $$
declare acc public.accounts;
begin
  select * into acc from public.accounts where id = new.account_id for update;
  if acc is null then
    raise exception 'account % not found', new.account_id;
  end if;
  if acc.done >= acc.ordered then
    raise exception 'Лимит исчерпан: % из % отзывов уже сделано', acc.done, acc.ordered;
  end if;
  update public.accounts
     set done = done + 1, updated_at = now()
   where id = new.account_id;
  return new;
end $$;

create or replace function public.dec_account_done()
returns trigger language plpgsql security definer as $$
begin
  update public.accounts
     set done = greatest(0, done - 1), updated_at = now()
   where id = old.account_id;
  return old;
end $$;

drop trigger if exists trg_bump_done on public.tasks;
drop trigger if exists trg_dec_done  on public.tasks;

create trigger trg_bump_done
  after insert on public.tasks
  for each row execute function public.bump_account_done();

create trigger trg_dec_done
  after delete on public.tasks
  for each row execute function public.dec_account_done();
```

---

## 2) Создать пользователя-сотрудника

Supabase Dashboard → **Authentication** → **Users** → **Add user → Create new user**.

- **Email:** `nastya@mentori.local` (или любой реальный)
- **Password:** придумать
- **Auto Confirm:** ✅ (чтобы не нужно было подтверждать письмом)

Под кнопкой `User Metadata` (или после создания → Edit user) добавить:

```json
{
  "name":  "Настя",
  "rate":  100
}
```

`rate` — сколько ₽ сотрудник получает за один отзыв. Используется в KPI.

---

## 3) Включить Email/Password провайдер

Dashboard → **Authentication** → **Providers** → **Email** → включить
«Enable Email provider» и выключить «Confirm email» (для удобства).

---

## 4) Привязать анкеты к сотруднику

В админке (`pages/clients.html`) открыть нужную анкету (двойной клик по ячейке
«Сотрудник») и вписать email сотрудника — он сразу появится у него в кабинете.

Поле `assignedEmail` хранится в `state.clients[].assignedEmail`. При сохранении
оно автоматически уходит в таблицу `accounts` (см. `js/cloud-sync.js`,
функция `pushAccounts`).

---

## 5) Готово

Сотрудник заходит на `https://<your-site>/pages/employee/login.html`,
логинится, видит свои анкеты, добавляет отзыв → счётчик `done` увеличивается
автоматически (через триггер) → админ в `clients.html` видит новое значение
после ближайшего pull (раз в 30 сек или при перезагрузке страницы).
