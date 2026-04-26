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

---

# Личный кабинет клиента (client portal)

С версии «client portal» отдельные клиенты (например, **Флагман**) могут
заходить в свой кабинет по адресу `/pages/client/login.html` и видеть только
свои анкеты, статусы, оплаты и опубликованные отзывы. Изоляция данных
обеспечивается на уровне Supabase RLS — клиент **физически не может**
прочитать ни `crm_state`, ни чужую строку из `client_snapshots`.

## Архитектура

```
crm_state           ← полный JSON CRM, доступ только под анон-ключом (admin)
client_snapshots    ← по строке на клиента, payload = его персональный срез
                       SELECT разрешён только authenticated WHERE email совпадает
```

Когда админ сохраняет любое изменение, `cloud-sync.js`:
1. Заливает полный state в `crm_state` (как раньше).
2. Сразу следом перегенерирует индивидуальные снимки (`Store.buildAllClientSnapshots()`)
   и upsert-ит их в `client_snapshots` по `email`.
3. Удаляет из `client_snapshots` строки, которым больше не соответствует
   запись в `state.clientPortals` (отозвали доступ → его снимок сразу пропал).

Снимок содержит только то, что нужно клиенту: ordered/done/paid/remain,
список аккаунтов с действующими статусами, история оплат, опубликованные
(одобренные) отзывы. Никаких внутренних данных (расходы, сотрудники, чужие
клиенты, IP, телефоны) в снимке нет.

## Шаг A. SQL: таблица + RLS

Запусти в SQL Editor:

```sql
-- 1) Таблица персональных снимков клиентов
create table if not exists public.client_snapshots (
  email       text primary key,
  payload     jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists client_snapshots_updated_idx
  on public.client_snapshots (updated_at desc);

alter table public.client_snapshots enable row level security;

-- 2) Чистим прошлые попытки (идемпотентно)
drop policy if exists "anon_write_snapshots"   on public.client_snapshots;
drop policy if exists "anon_select_snapshots"  on public.client_snapshots;
drop policy if exists "anon_delete_snapshots"  on public.client_snapshots;
drop policy if exists "client_select_own"      on public.client_snapshots;

-- 3) Политики для администратора (работает под анон-ключом)
--    Админ может читать/писать/удалять любую строку.
create policy "anon_select_snapshots"
  on public.client_snapshots
  for select
  to anon
  using (true);

create policy "anon_write_snapshots"
  on public.client_snapshots
  for insert
  to anon
  with check (true);

create policy "anon_update_snapshots"
  on public.client_snapshots
  for update
  to anon
  using (true)
  with check (true);

create policy "anon_delete_snapshots"
  on public.client_snapshots
  for delete
  to anon
  using (true);

-- 4) Политика для клиента: видит ТОЛЬКО свою строку.
--    auth.jwt() ->> 'email' возвращает email из JWT.
create policy "client_select_own"
  on public.client_snapshots
  for select
  to authenticated
  using ( lower(email) = lower(auth.jwt() ->> 'email') );
```

## Шаг B. Запретить клиенту читать crm_state (КРИТИЧНО)

Существующие политики `crm_state` (созданные на Шаге 2) написаны без
явной роли — а значит применяются ко **ВСЕМ** ролям, включая
`authenticated`. Это значит, что залогиненный клиент технически может
прочитать `crm_state` и увидеть всё. Нужно сузить политики до `anon`:

```sql
-- 1) Удаляем старые «всеролевые» политики
drop policy if exists "anon_select_main"  on public.crm_state;
drop policy if exists "anon_insert_main"  on public.crm_state;
drop policy if exists "anon_update_main"  on public.crm_state;

-- 2) Пересоздаём — только для anon (админка ходит под публикабельным ключом)
create policy "anon_select_main"
  on public.crm_state
  for select
  to anon
  using (id = 'main');

create policy "anon_insert_main"
  on public.crm_state
  for insert
  to anon
  with check (id = 'main');

create policy "anon_update_main"
  on public.crm_state
  for update
  to anon
  using (id = 'main')
  with check (id = 'main');

-- 3) Подчистим лишние политики, если они когда-то заводились
drop policy if exists "authed_select_main" on public.crm_state;
```

**Проверка:** залогинься клиентом в /pages/client/login.html и в DevTools выполни:

```js
fetch('https://ivzouyhyuyfzoodhyrya.supabase.co/rest/v1/crm_state?select=data', {
  headers: {
    apikey: 'sb_publishable_QpxNagNre_4iKQrVO5Swzw_XWhmrQo4',
    Authorization: 'Bearer ' + JSON.parse(localStorage['mentori-supabase-session']).access_token
  }
}).then(r => r.json()).then(console.log)
```

Должен вернуться пустой массив `[]`. Если вернулась реальная data — значит
SQL выше не отработал, перепроверь.

## Шаг C. Завести клиента в Supabase Auth

Для каждого клиента (например, Флагман):

1. Supabase Dashboard → **Authentication → Users → Add user → Create new user**.
2. Email: тот, который клиент будет использовать (напр. `flagman@example.com`).
3. Пароль: придумай и передай клиенту (или включи Magic Link).
4. **Auto Confirm User** — поставь галочку (иначе нужно подтверждать email).
5. После создания — открой пользователя → блок **Raw User Meta Data** →
   нажми **Edit** и впиши:

```json
{ "role": "client", "name": "Флагман" }
```

Сохрани. Это критично — без `role: "client"` `auth-gate.js` не сможет
отличить клиента от сотрудника, и наша сторона не пустит его в кабинет.

## Шаг D. Связать email с анкетами

В админке открой **Кабинеты клиентов** (новый пункт сайдбара, owner-only) →
**Добавить доступ**:
- Имя клиента: «Флагман»
- Email: `flagman@example.com` (тот же, что в Supabase Auth)
- Анкеты: отметь `a21` и `a22`
- Сохрани.

Сразу после сохранения админка пушит снимок этого клиента в
`client_snapshots`. Клиент может зайти на `/pages/client/login.html`,
ввести email + пароль и увидеть свой кабинет.

## Что видит/не видит клиент

| Кабинет показывает                              | Кабинет НЕ показывает      |
|-------------------------------------------------|----------------------------|
| Свои анкеты (только привязанные mentorIds)      | Чужих клиентов             |
| Аккаунты с статусами (только под этими mentor)  | Расходы / прибыль          |
| Свои оплаты (по items.accountId)                | Сотрудников и их зарплаты  |
| Опубликованные (одобренные) отзывы              | Отзывы на модерации        |
| Сводный фид по своим действиям                  | IP / номера / регистрации  |
|                                                 | Чужие снимки               |

## Что произойдёт, если клиент попробует обойти UI

- Открыл `/pages/dashboard.html` → `auth-gate.js` видит `role === 'client'`,
  редиректит обратно в `/pages/client/index.html`.
- Через DevTools запросил `crm_state` → RLS отдаёт пустой массив (роль
  `authenticated` без политики).
- Через DevTools запросил `client_snapshots?select=*` → RLS отдаёт ОДНУ
  строку, где `email = auth.jwt() ->> 'email'`. Чужие снимки скрыты.
- Подделал JWT → не получится: подпись проверяется секретом проекта.

## Откат / сброс

Удалить таблицу снимков (политики и индексы уйдут вместе с ней):

```sql
drop table if exists public.client_snapshots;
```

После следующего сохранения в админке таблица будет автоматически создана…
**нет, не будет** — её нужно создать руками SQL’ем заново. Но сами доступы
(`state.clientPortals`) сохранятся в `crm_state` и снимки восстановятся
после первого сохранения, как только таблица появится.

Удалить одного клиента: убрать его в админке (Кабинеты клиентов → корзина).
Запись в Supabase Auth останется — её надо чистить руками
(Authentication → Users → Delete user), если клиент совсем уходит.

