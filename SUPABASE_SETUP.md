# Подключение Supabase — пошаговая инструкция

Mentori CRM хранит весь стейт (доходы, расходы, клиенты, сотрудники, подписки)
одним JSON-блобом в одной строке таблицы `crm_state`. На каждом устройстве
скрипт `js/cloud-sync.js` автоматически:

1. при загрузке страницы — тянет свежий снимок с сервера и обновляет UI;
2. при каждом изменении — дебаунсит (600 мс) и шлёт PATCH в облако.

Это значит, что данные одинаковы на всех устройствах, где открыт сайт.

---

## Шаг 1. Открыть SQL Editor в Supabase

1. Зайди в [supabase.com](https://supabase.com) → выбери свой проект
   `ivzouyhyuyfzoodhyrya`.
2. Левое меню → **SQL Editor** → **New query**.

## Шаг 2. Запустить SQL ниже

Скопируй и нажми **Run**. Это создаст таблицу, включит Row Level Security и
добавит политики, разрешающие анонимному ключу читать/писать одну строку
с `id = 'main'`.

```sql
-- 1) Таблица для всего стейта CRM
create table if not exists public.crm_state (
  id          text primary key,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 2) Включаем RLS
alter table public.crm_state enable row level security;

-- 3) Политики: разрешаем anon-ключу читать и писать в строку 'main'
drop policy if exists "anon_select_main" on public.crm_state;
drop policy if exists "anon_insert_main" on public.crm_state;
drop policy if exists "anon_update_main" on public.crm_state;

create policy "anon_select_main"
  on public.crm_state
  for select
  using (id = 'main');

create policy "anon_insert_main"
  on public.crm_state
  for insert
  with check (id = 'main');

create policy "anon_update_main"
  on public.crm_state
  for update
  using (id = 'main')
  with check (id = 'main');

-- 4) Заглушка-строка, чтобы первый PATCH с фронта прошёл
insert into public.crm_state (id, data)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;
```

## Шаг 3. Проверить

После запуска SQL открой `pages/dashboard.html` в браузере. В правом верхнем
углу появится индикатор синхронизации:

| Состояние | Значение |
|-----------|----------|
| 🟢 Синхронизировано | всё ок, данные в облаке |
| 🟠 Сохранение… | идёт push |
| 🔴 Ошибка сохранения | проблема — смотри Console |
| ⚫ Оффлайн | нет интернета, копится в localStorage |

Открой DevTools → Network. После любого изменения должен идти запрос
`POST https://ivzouyhyuyfzoodhyrya.supabase.co/rest/v1/crm_state?on_conflict=id`
со статусом **201** или **204**.

## Шаг 4. Проверить синхронизацию между устройствами

1. Сделай изменение на ноутбуке — например добавь доход.
2. Открой сайт на телефоне — данные должны появиться (если были там старые,
   страница автоматически перезагрузится через секунду).

---

## Безопасность

⚠ **Текущая настройка разрешает любому, кто знает URL и ключ из репозитория,
читать и менять `crm_state` (id='main')**. Поскольку ключ публикабельный
(`sb_publishable_*`) и лежит в исходниках, сейчас это твоя личная база
без авторизации.

Если позже захочешь полноценную защиту:
1. Добавить Supabase Auth (Magic Link на твою почту).
2. Заменить политики на `using (auth.uid() = owner_id)`.
3. Добавить колонку `owner_id uuid references auth.users(id)`.

Пока для одного пользователя на нескольких устройствах — текущей схемы
достаточно. При компрометации ключа можно сделать **Settings → API → Roll
publishable key** и обновить `SUPABASE_KEY` в `js/cloud-sync.js`.

---

## Откат / сброс

Чтобы стереть облачный стейт и начать с локального:

```sql
update public.crm_state set data = '{}'::jsonb where id = 'main';
```

После этого открой страницу — `cloud-sync.js` увидит пустой облачный state
и зальёт туда то, что есть в твоём localStorage.

## Сменить URL/ключ

Поправь две константы в начале `js/cloud-sync.js`:

```js
const SUPABASE_URL = 'https://....supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```
