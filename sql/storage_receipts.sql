-- ===========================================================================
-- Supabase Storage для чеков об оплате (bucket `receipts`).
--
-- Контекст: на self-hosted Supabase (Beget) изначально НЕ было storage-сервиса
-- (только postgres + gotrue + postgrest). Подняли storage-api 2026-06-27, чтобы
-- клиент мог прикреплять чек (PDF/фото) при заказе отзывов из кабинета.
--
-- ⚠️ Этот файл — ДОКУМЕНТАЦИЯ применённого вручную на сервере. Часть шагов —
-- не SQL (docker-compose, nginx). Порядок и нюансы:
--
-- 1) docker-compose (/home/mentori/supabase/docker-compose.yml): добавлен сервис
--    `storage` (supabase/storage-api:v1.11.13) в сеть supnet, порт 127.0.0.1:5000,
--    volume sup-storage:/var/lib/storage, env: ANON_KEY/SERVICE_KEY/POSTGREST_URL/
--    PGRST_JWT_SECRET/DATABASE_URL(supabase_storage_admin)/STORAGE_BACKEND=file/
--    FILE_STORAGE_BACKEND_PATH=/var/lib/storage/ENABLE_IMAGE_TRANSFORMATION=false.
--
-- 2) nginx (/etc/nginx/sites-available/mentori-site): добавлен location
--    `^~ /sb/storage/v1/` → proxy_pass http://127.0.0.1:5000/ (стрипит префикс),
--    client_max_body_size 50m, CORS reflect-origin (как у /sb/rest/v1/).
--    `^~` обязательно: иначе общий regex для .jpg/.png перехватывает OPTIONS
--    загрузки чека и возвращает 404 до обращения к Storage API.
--
-- 3) SQL ниже (роль + схема + гранты + bucket + политика). ГРАБЛИ:
--    - роль supabase_storage_admin: login password = POSTGRES_PASSWORD (из .env),
--      noinherit createrole, член anon/authenticated/service_role. Создать через
--      stdin (пароль не в argv). Создаётся вне этого файла (секрет).
--    - storage-api миграции падали "permission denied for database postgres",
--      пока supabase_storage_admin не получил GRANT ALL ON DATABASE postgres.
--    - storage-api НЕ выдал table-гранты ролям → upload падал с (замаскированным)
--      "violates RLS". ОБЯЗАТЕЛЬНО grant на storage.objects/buckets ниже.
-- ===========================================================================

-- роль (password = POSTGRES_PASSWORD; выполнять отдельно через stdin):
--   create role supabase_storage_admin login password '<POSTGRES_PASSWORD>'
--     noinherit createrole;
grant anon, authenticated, service_role to supabase_storage_admin;
grant all on database postgres to supabase_storage_admin;   -- иначе миграции падают
alter schema storage owner to supabase_storage_admin;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant all on schema storage to supabase_storage_admin;

-- table-гранты (storage-api их НЕ выдал сам — без них upload = permission denied):
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select, insert, update, delete on storage.buckets to anon, authenticated, service_role;
grant usage, select on all sequences in schema storage to anon, authenticated, service_role;

-- Private bucket: доступ к чеку выдаётся через RLS и короткую signed URL.
-- Лимит 50 МБ, только pdf/картинки.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts','receipts', false, 52428800,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update set public=excluded.public,
  file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

-- Клиент загружает только в собственную папку auth.uid().
drop policy if exists receipts_auth_insert on storage.objects;
create policy receipts_auth_insert on storage.objects
  for insert to public
  with check (
    bucket_id = 'receipts'
    and (auth.jwt() -> 'app_metadata' ->> 'role') = 'client'
    and split_part(name, '/', 1) = auth.uid()::text
  );

-- Владелец видит все чеки. Клиент видит свою папку и старые корневые файлы,
-- которые уже привязаны к его заявкам.
drop policy if exists receipts_auth_select on storage.objects;
create policy receipts_auth_select on storage.objects
  for select to public
  using (
    bucket_id = 'receipts'
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'owner'
      or split_part(name, '/', 1) = auth.uid()::text
      or exists (
        select 1
        from public.client_orders co
        where co.client_email = (auth.jwt() ->> 'email')
          and (
            co.receipt_url = 'storage://receipts/' || name
            or co.receipt_url like '%/object/public/receipts/' || name
          )
      )
    )
  );

-- Проверка upload (mint JWT, POST /sb/storage/v1/object/receipts/<file>) — см. историю сессии.
