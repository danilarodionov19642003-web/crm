-- Shared client login + multiple Telegram contacts.
--
-- The login email may change, while portal_email remains the immutable key for
-- snapshots, orders, schedules and receipts. Telegram accounts are linked with
-- short-lived, single-use tokens and never gain access to crm_state writes.

begin;

-- ---------------------------------------------------------------------------
-- Stable client portal identity
-- ---------------------------------------------------------------------------

create or replace function public.current_client_portal_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'portal_email', ''),
    nullif(auth.jwt() ->> 'email', ''),
    ''
  ));
$$;

revoke all on function public.current_client_portal_email() from public, anon;
grant execute on function public.current_client_portal_email() to authenticated, service_role;

-- Existing clients keep their current email as the immutable portal key.
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('portal_email', lower(email)),
    updated_at = now()
where coalesce(raw_app_meta_data ->> 'role', '') = 'client'
  and coalesce(raw_app_meta_data ->> 'portal_email', '') = ''
  and coalesce(email, '') <> '';

create or replace function public.create_client_user(
  p_email text,
  p_password text,
  p_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_role text;
  v_uid uuid;
  v_existing uuid;
  v_user_meta jsonb;
begin
  v_role := current_setting('request.jwt.claims', true)::jsonb
    -> 'app_metadata' ->> 'role';
  if v_role is distinct from 'owner' then
    raise exception 'forbidden: only owner can create users' using errcode = '42501';
  end if;
  p_email := lower(btrim(coalesce(p_email, '')));
  if p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'email is invalid' using errcode = '22023';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'password must be at least 6 chars' using errcode = '22023';
  end if;
  select id into v_existing from auth.users where lower(email) = p_email;
  if v_existing is not null then
    raise exception 'user with email % already exists', p_email using errcode = '23505';
  end if;

  v_uid := gen_random_uuid();
  v_user_meta := jsonb_build_object('role', 'client');
  if p_name is not null and length(btrim(p_name)) > 0 then
    v_user_meta := v_user_meta || jsonb_build_object('name', btrim(p_name));
  end if;

  insert into auth.users (
    id, instance_id, aud, role, email,
    encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token,
    email_change_token_new, email_change_token_current, email_change,
    reauthentication_token, phone_change, phone_change_token,
    created_at, updated_at
  ) values (
    v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_email,
    crypt(p_password, gen_salt('bf', 10)),
    now(),
    jsonb_build_object(
      'provider', 'email',
      'providers', jsonb_build_array('email'),
      'role', 'client',
      'portal_email', p_email
    ),
    v_user_meta,
    '', '', '', '', '', '', '', '',
    now(), now()
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_uid, v_uid::text,
    jsonb_build_object(
      'sub', v_uid::text,
      'email', p_email,
      'email_verified', false,
      'phone_verified', false
    ),
    'email', now(), now(), now()
  );

  return jsonb_build_object(
    'ok', true,
    'user_id', v_uid,
    'email', p_email,
    'portal_email', p_email
  );
end;
$$;

revoke all on function public.create_client_user(text, text, text) from public, anon, authenticated;
grant execute on function public.create_client_user(text, text, text) to authenticated;

create or replace function public.reset_client_password(
  p_email text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_role text;
  v_uid uuid;
  v_login_email text;
begin
  v_role := current_setting('request.jwt.claims', true)::jsonb
    -> 'app_metadata' ->> 'role';
  if v_role is distinct from 'owner' then
    raise exception 'forbidden: only owner can reset passwords' using errcode = '42501';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'password must be at least 6 chars' using errcode = '22023';
  end if;
  p_email := lower(btrim(coalesce(p_email, '')));
  select id, lower(email) into v_uid, v_login_email
  from auth.users
  where lower(email) = p_email
     or lower(coalesce(raw_app_meta_data ->> 'portal_email', '')) = p_email
  order by (lower(email) = p_email) desc
  limit 1;
  if v_uid is null then
    raise exception 'user % not found', p_email using errcode = 'P0002';
  end if;

  update auth.users
  set encrypted_password = crypt(p_password, gen_salt('bf', 10)),
      updated_at = now()
  where id = v_uid;
  delete from auth.sessions where user_id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_uid,
    'email', v_login_email,
    'portal_email', p_email
  );
end;
$$;

revoke all on function public.reset_client_password(text, text) from public, anon, authenticated;
grant execute on function public.reset_client_password(text, text) to authenticated;

create or replace function public.change_my_client_credentials(
  p_current_password text,
  p_new_email text default null,
  p_new_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_old_email text;
  v_new_email text;
  v_portal_email text;
  v_password_hash text;
  v_change_email boolean := false;
  v_change_password boolean := false;
begin
  if auth.role() <> 'authenticated' or v_role <> 'client' or v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(p_current_password, '') = '' then
    raise exception 'CURRENT_PASSWORD_REQUIRED' using errcode = '22023';
  end if;

  select lower(email), encrypted_password,
         lower(coalesce(raw_app_meta_data ->> 'portal_email', email))
    into v_old_email, v_password_hash, v_portal_email
  from auth.users
  where id = v_uid
  for update;

  if v_password_hash is null
     or crypt(p_current_password, v_password_hash) is distinct from v_password_hash then
    raise exception 'CURRENT_PASSWORD_INVALID' using errcode = '28P01';
  end if;

  v_new_email := lower(btrim(coalesce(nullif(p_new_email, ''), v_old_email)));
  v_change_email := v_new_email is distinct from v_old_email;
  v_change_password := coalesce(p_new_password, '') <> '';

  if not v_change_email and not v_change_password then
    raise exception 'NOTHING_TO_CHANGE' using errcode = '22023';
  end if;
  if v_change_email
     and v_new_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'EMAIL_INVALID' using errcode = '22023';
  end if;
  if v_change_email and exists (
    select 1 from auth.users
    where id <> v_uid and lower(email) = v_new_email
  ) then
    raise exception 'EMAIL_ALREADY_USED' using errcode = '23505';
  end if;
  if v_change_password and length(p_new_password) < 8 then
    raise exception 'PASSWORD_TOO_SHORT' using errcode = '22023';
  end if;

  update auth.users
  set email = case when v_change_email then v_new_email else email end,
      encrypted_password = case
        when v_change_password then crypt(p_new_password, gen_salt('bf', 10))
        else encrypted_password
      end,
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
        || jsonb_build_object('portal_email', v_portal_email),
      email_change = '',
      email_change_token_new = '',
      email_change_token_current = '',
      email_change_confirm_status = 0,
      updated_at = now()
  where id = v_uid;

  if v_change_email then
    update auth.identities
    set identity_data = jsonb_set(
          coalesce(identity_data, '{}'::jsonb),
          '{email}', to_jsonb(v_new_email), true
        ),
        updated_at = now()
    where user_id = v_uid and provider = 'email';
  end if;

  -- A shared password change must revoke every old session. The current page
  -- receives this response and immediately clears its local session as well.
  delete from auth.sessions where user_id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'email', v_new_email,
    'portal_email', v_portal_email,
    'email_changed', v_change_email,
    'password_changed', v_change_password
  );
end;
$$;

revoke all on function public.change_my_client_credentials(text, text, text)
  from public, anon;
grant execute on function public.change_my_client_credentials(text, text, text)
  to authenticated;

create or replace function public.list_client_login_accounts()
returns table (portal_email text, login_email text)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'owner' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  return query
  select lower(coalesce(u.raw_app_meta_data ->> 'portal_email', u.email)), lower(u.email)
  from auth.users u
  where coalesce(u.raw_app_meta_data ->> 'role', '') = 'client'
  order by 1;
end;
$$;

revoke all on function public.list_client_login_accounts() from public, anon;
grant execute on function public.list_client_login_accounts() to authenticated;

-- ---------------------------------------------------------------------------
-- Existing client RLS now uses the immutable portal key.
-- ---------------------------------------------------------------------------

drop policy if exists client_snapshots_self_select on public.client_snapshots;
create policy client_snapshots_self_select
  on public.client_snapshots for select to authenticated
  using (
    public._jwt_role() = 'client'
    and lower(email) = public.current_client_portal_email()
  );

drop policy if exists client_orders_auth_select on public.client_orders;
create policy client_orders_auth_select
  on public.client_orders for select to authenticated
  using (lower(client_email) = public.current_client_portal_email());

drop policy if exists client_orders_auth_insert on public.client_orders;
create policy client_orders_auth_insert
  on public.client_orders for insert to authenticated
  with check (
    lower(client_email) = public.current_client_portal_email()
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

drop policy if exists client_outreach_slots_client_select
  on public.client_outreach_slots;
create policy client_outreach_slots_client_select
  on public.client_outreach_slots for select to authenticated
  using (lower(client_email) = public.current_client_portal_email());

drop policy if exists client_publication_requests_client_select
  on public.client_publication_requests;
create policy client_publication_requests_client_select
  on public.client_publication_requests for select to authenticated
  using (lower(client_email) = public.current_client_portal_email());

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
        where lower(co.client_email) = public.current_client_portal_email()
          and (
            co.receipt_url = 'storage://receipts/' || name
            or co.receipt_url like '%/object/public/receipts/' || name
          )
      )
    )
  );

-- Keep the already-audited calendar implementation, replacing only the
-- mutable login email with the stable portal key.
create or replace function public.get_client_outreach_calendar_v1(
  p_from date,
  p_to date
)
returns table (
  schedule_date date,
  used_count int,
  capacity int,
  available_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_email text := public.current_client_portal_email();
  caller_app_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
begin
  if auth.role() <> 'authenticated'
     or caller_app_role <> 'client'
     or caller_email = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to > p_from + 62 then
    raise exception 'DATE_RANGE_INVALID' using errcode = '22023';
  end if;
  return query
  select
    day::date,
    count(slot.id)::int,
    7,
    greatest(0, 7 - count(slot.id)::int)
  from generate_series(p_from, p_to, interval '1 day') day
  left join public.client_outreach_slots slot
    on slot.scheduled_date = day::date and slot.slot_status = 'scheduled'
  group by day
  order by day;
end;
$$;

create or replace function public.manage_client_outreach_slot_v1(
  p_action text,
  p_slot_id bigint default null,
  p_mentor_id text default null,
  p_target_date date default null
)
returns public.client_outreach_slots
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_email text := public.current_client_portal_email();
  caller_app_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  action_name text := lower(btrim(coalesce(p_action, '')));
  snapshot_payload jsonb;
  anketa jsonb;
  slot_row public.client_outreach_slots;
  old_date date;
  ordered_count int := 0;
  done_count int := 0;
  work_count int := 0;
  max_slots int := 0;
  current_slots int := 0;
  used_on_target int := 0;
  msg text;
begin
  if auth.role() <> 'authenticated'
     or caller_app_role <> 'client'
     or caller_email = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if action_name not in ('add', 'move', 'cancel') then
    raise exception 'ACTION_REQUIRED' using errcode = '22023';
  end if;

  if action_name in ('add', 'move') then
    if p_target_date is null
       or p_target_date < current_date
       or p_target_date > current_date + 180 then
      raise exception 'DATE_OUT_OF_RANGE' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext('outreach:' || p_target_date::text));
  end if;

  select payload into snapshot_payload
  from public.client_snapshots
  where lower(email) = caller_email;
  if snapshot_payload is null then
    raise exception 'SNAPSHOT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if action_name = 'add' then
    if coalesce(btrim(p_mentor_id), '') = '' then
      raise exception 'ANKETA_REQUIRED' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext(
      'outreach-client:' || caller_email || ':' || p_mentor_id
    ));
    select item into anketa
    from jsonb_array_elements(coalesce(snapshot_payload -> 'anketas', '[]'::jsonb)) item
    where item ->> 'mentorId' = p_mentor_id
    limit 1;
    if anketa is null then
      raise exception 'ANKETA_NOT_FOUND' using errcode = '42501';
    end if;

    ordered_count := greatest(0, coalesce((anketa ->> 'ordered')::int, 0));
    done_count := greatest(0, coalesce((anketa ->> 'done')::int, 0));
    select count(*)::int into work_count
    from jsonb_array_elements(coalesce(anketa -> 'statuses', '[]'::jsonb)) status_item
    where status_item ->> 'status' not in ('📋 Запланировано', '🎯 Готов');
    max_slots := greatest(0, ordered_count - done_count - work_count);

    select count(*)::int into current_slots
    from public.client_outreach_slots
    where lower(client_email) = caller_email
      and mentor_id = p_mentor_id
      and slot_status = 'scheduled';
    if current_slots >= max_slots then
      raise exception 'NO_AVAILABLE_OUTREACH' using errcode = 'P0001';
    end if;

    select count(*)::int into used_on_target
    from public.client_outreach_slots
    where scheduled_date = p_target_date and slot_status = 'scheduled';
    if used_on_target >= 7 then
      raise exception 'DAY_FULL' using errcode = 'P0001';
    end if;

    insert into public.client_outreach_slots (
      client_email, mentor_id, anketa_code, anketa_name, scheduled_date,
      slot_status, source, changed_by
    ) values (
      caller_email, p_mentor_id, anketa ->> 'code', anketa ->> 'name', p_target_date,
      'scheduled', 'client', caller_email
    ) returning * into slot_row;
    msg := '📅 Клиент запланировал отклик' || E'\n'
        || '👤 ' || coalesce(slot_row.anketa_code, '—') || ' · '
        || coalesce(slot_row.anketa_name, caller_email) || E'\n'
        || 'Дата: ' || to_char(slot_row.scheduled_date, 'DD.MM.YYYY');
  else
    select * into slot_row
    from public.client_outreach_slots
    where id = p_slot_id
      and lower(client_email) = caller_email
      and slot_status = 'scheduled'
    for update;
    if slot_row.id is null then
      raise exception 'SLOT_NOT_FOUND' using errcode = 'P0002';
    end if;
    old_date := slot_row.scheduled_date;

    if action_name = 'move' then
      if p_target_date = old_date then return slot_row; end if;
      select count(*)::int into used_on_target
      from public.client_outreach_slots
      where scheduled_date = p_target_date
        and slot_status = 'scheduled'
        and id <> slot_row.id;
      if used_on_target >= 7 then
        raise exception 'DAY_FULL' using errcode = 'P0001';
      end if;
      update public.client_outreach_slots
      set scheduled_date = p_target_date,
          updated_at = now(),
          changed_by = caller_email
      where id = slot_row.id
      returning * into slot_row;
      msg := '🔄 Клиент перенёс отклик' || E'\n'
          || '👤 ' || coalesce(slot_row.anketa_code, '—') || ' · '
          || coalesce(slot_row.anketa_name, caller_email) || E'\n'
          || to_char(old_date, 'DD.MM.YYYY') || ' → '
          || to_char(slot_row.scheduled_date, 'DD.MM.YYYY');
    else
      update public.client_outreach_slots
      set slot_status = 'cancelled',
          cancelled_at = now(),
          updated_at = now(),
          changed_by = caller_email
      where id = slot_row.id
      returning * into slot_row;
      msg := '❌ Клиент отменил запланированный отклик' || E'\n'
          || '👤 ' || coalesce(slot_row.anketa_code, '—') || ' · '
          || coalesce(slot_row.anketa_name, caller_email) || E'\n'
          || 'Был запланирован: ' || to_char(old_date, 'DD.MM.YYYY');
    end if;
  end if;

  insert into public.notification_outbox (
    telegram_chat_id, kind, message, status, mentor_id, client_email
  ) values (
    6876234451, 'client_outreach_schedule', msg, 'pending',
    slot_row.mentor_id, caller_email
  );
  return slot_row;
end;
$$;

create or replace function public.request_client_publication_date(
  p_status_id text,
  p_requested_date date
)
returns public.client_publication_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_email text := public.current_client_portal_email();
  snapshot_payload jsonb;
  anketa jsonb;
  status_row jsonb;
  existing_row public.client_publication_requests;
  result_row public.client_publication_requests;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or caller_email = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_status_id is null or btrim(p_status_id) = '' then
    raise exception 'STATUS_REQUIRED' using errcode = '22023';
  end if;
  if p_requested_date is null
     or p_requested_date < current_date
     or p_requested_date > current_date + 180 then
    raise exception 'DATE_OUT_OF_RANGE' using errcode = '22023';
  end if;

  select payload into snapshot_payload
  from public.client_snapshots
  where lower(email) = caller_email;
  if snapshot_payload is null then
    raise exception 'SNAPSHOT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.item, s.item into anketa, status_row
  from jsonb_array_elements(coalesce(snapshot_payload -> 'anketas', '[]'::jsonb)) a(item)
  cross join lateral jsonb_array_elements(coalesce(a.item -> 'statuses', '[]'::jsonb)) s(item)
  where s.item ->> 'id' = p_status_id
    and s.item ->> 'status' = '🏆 Выбран'
  limit 1;
  if status_row is null then
    raise exception 'STATUS_NOT_AVAILABLE' using errcode = '42501';
  end if;

  select * into existing_row
  from public.client_publication_requests
  where lower(client_email) = caller_email and status_id = p_status_id;
  if existing_row.id is not null
     and existing_row.request_status = 'accepted'
     and existing_row.status_date = (status_row ->> 'date')::date then
    raise exception 'DATE_ALREADY_ACCEPTED' using errcode = '23505';
  end if;

  insert into public.client_publication_requests (
    client_email, status_id, mentor_id, profile_id, status_date,
    anketa_code, anketa_name, account_name, requested_date,
    request_status, created_at, updated_at, resolved_at, resolved_by
  ) values (
    caller_email,
    p_status_id,
    status_row ->> 'mentorId',
    status_row ->> 'profileId',
    (status_row ->> 'date')::date,
    anketa ->> 'code',
    anketa ->> 'name',
    status_row ->> 'profileName',
    p_requested_date,
    'pending', now(), now(), null, null
  )
  on conflict (client_email, status_id) do update set
    mentor_id = excluded.mentor_id,
    profile_id = excluded.profile_id,
    status_date = excluded.status_date,
    anketa_code = excluded.anketa_code,
    anketa_name = excluded.anketa_name,
    account_name = excluded.account_name,
    requested_date = excluded.requested_date,
    request_status = 'pending',
    updated_at = now(),
    resolved_at = null,
    resolved_by = null
  returning * into result_row;
  return result_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Telegram team for one shared client portal
-- ---------------------------------------------------------------------------

create table if not exists public.client_telegram_members (
  id bigint generated by default as identity primary key,
  portal_email text not null,
  telegram_user_id bigint not null unique,
  telegram_chat_id bigint not null,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  contact_label text,
  is_active boolean not null default true,
  is_text_approver boolean not null default false,
  status_notifications boolean not null default true,
  schedule_notifications boolean not null default true,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (telegram_user_id > 0),
  check (telegram_chat_id > 0),
  check (length(coalesce(contact_label, '')) <= 100)
);

create index if not exists client_telegram_members_portal_idx
  on public.client_telegram_members (portal_email, is_active, id);
create unique index if not exists client_telegram_one_text_approver_idx
  on public.client_telegram_members (portal_email)
  where is_active and is_text_approver;

create table if not exists public.client_telegram_invites (
  id bigint generated by default as identity primary key,
  portal_email text not null,
  token_hash text not null unique,
  contact_label text,
  is_text_approver boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_telegram_user_id bigint,
  revoked_at timestamptz,
  check (length(token_hash) = 64),
  check (length(coalesce(contact_label, '')) <= 100)
);

create index if not exists client_telegram_invites_portal_idx
  on public.client_telegram_invites (portal_email, created_at desc);
create index if not exists client_telegram_invites_pending_idx
  on public.client_telegram_invites (expires_at)
  where used_at is null and revoked_at is null;

create table if not exists public.client_telegram_audit (
  id bigint generated by default as identity primary key,
  portal_email text not null,
  member_id bigint,
  event_name text not null,
  actor text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists client_telegram_audit_portal_idx
  on public.client_telegram_audit (portal_email, created_at desc);

alter table public.client_telegram_members enable row level security;
alter table public.client_telegram_invites enable row level security;
alter table public.client_telegram_audit enable row level security;

drop policy if exists client_telegram_members_staff_select on public.client_telegram_members;
create policy client_telegram_members_staff_select
  on public.client_telegram_members for select to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('owner', 'team'));

drop policy if exists client_telegram_audit_staff_select on public.client_telegram_audit;
create policy client_telegram_audit_staff_select
  on public.client_telegram_audit for select to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('owner', 'team'));

revoke all on public.client_telegram_members from anon, authenticated;
revoke all on public.client_telegram_invites from anon, authenticated;
revoke all on public.client_telegram_audit from anon, authenticated;
grant select on public.client_telegram_members, public.client_telegram_audit to authenticated;
grant all on public.client_telegram_members, public.client_telegram_invites,
  public.client_telegram_audit to service_role;
grant usage, select on sequence public.client_telegram_members_id_seq,
  public.client_telegram_invites_id_seq, public.client_telegram_audit_id_seq
  to service_role;

-- Preserve the one legacy manual Telegram connection, if one exists.
with portals as (
  select portal
  from public.crm_state state
  cross join lateral jsonb_array_elements(
    coalesce(state.data -> 'clientPortals', '[]'::jsonb)
  ) portal
  where state.id = 'main'
)
insert into public.client_telegram_members (
  portal_email, telegram_user_id, telegram_chat_id, telegram_username,
  contact_label, is_active, is_text_approver,
  status_notifications, schedule_notifications, linked_at, updated_at, last_seen_at
)
select
  lower(portal ->> 'email'),
  (portal ->> 'telegramChatId')::bigint,
  (portal ->> 'telegramChatId')::bigint,
  nullif(lower(regexp_replace(coalesce(portal ->> 'telegramUsername', ''), '^@', '')), ''),
  nullif(portal ->> 'name', ''),
  true, true, true, true, now(), now(), now()
from portals
where coalesce(portal ->> 'email', '') <> ''
  and coalesce(portal ->> 'telegramChatId', '') ~ '^[1-9][0-9]*$'
on conflict (telegram_user_id) do nothing;

create or replace function public.list_my_client_telegram_members()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_result jsonb;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', member.id,
    'username', member.telegram_username,
    'first_name', member.telegram_first_name,
    'last_name', member.telegram_last_name,
    'contact_label', member.contact_label,
    'is_text_approver', member.is_text_approver,
    'status_notifications', member.status_notifications,
    'schedule_notifications', member.schedule_notifications,
    'linked_at', member.linked_at
  ) order by member.is_text_approver desc, member.linked_at, member.id), '[]'::jsonb)
  into v_result
  from public.client_telegram_members member
  where lower(member.portal_email) = v_portal and member.is_active;
  return v_result;
end;
$$;

revoke all on function public.list_my_client_telegram_members() from public, anon;
grant execute on function public.list_my_client_telegram_members() to authenticated;

create or replace function public.list_client_telegram_members_for_owner(
  p_portal_email text default null
)
returns table (
  id bigint,
  portal_email text,
  telegram_username text,
  contact_label text,
  is_text_approver boolean,
  status_notifications boolean,
  schedule_notifications boolean,
  linked_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'owner' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  return query
  select member.id, member.portal_email, member.telegram_username,
         member.contact_label, member.is_text_approver,
         member.status_notifications, member.schedule_notifications,
         member.linked_at
  from public.client_telegram_members member
  where member.is_active
    and (coalesce(btrim(p_portal_email), '') = ''
      or lower(member.portal_email) = lower(btrim(p_portal_email)))
  order by member.portal_email, member.is_text_approver desc, member.linked_at;
end;
$$;

revoke all on function public.list_client_telegram_members_for_owner(text)
  from public, anon;
grant execute on function public.list_client_telegram_members_for_owner(text)
  to authenticated;

create or replace function public.create_client_telegram_invite(
  p_contact_label text default null,
  p_is_text_approver boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_token text;
  v_expires timestamptz := now() + interval '10 minutes';
  v_active_count int;
  v_invite_id bigint;
  v_make_approver boolean;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if length(coalesce(p_contact_label, '')) > 100 then
    raise exception 'CONTACT_LABEL_TOO_LONG' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('client-telegram:' || v_portal));
  select count(*)::int into v_active_count
  from public.client_telegram_members
  where lower(portal_email) = v_portal and is_active;
  if v_active_count >= 6 then
    raise exception 'MEMBER_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  select coalesce(p_is_text_approver, false) or not exists (
    select 1 from public.client_telegram_members
    where lower(portal_email) = v_portal and is_active and is_text_approver
  ) into v_make_approver;

  update public.client_telegram_invites
  set revoked_at = now()
  where lower(portal_email) = v_portal
    and used_at is null and revoked_at is null and expires_at < now();

  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.client_telegram_invites (
    portal_email, token_hash, contact_label, is_text_approver,
    created_by, expires_at
  ) values (
    v_portal,
    encode(digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
    nullif(btrim(p_contact_label), ''),
    v_make_approver,
    auth.uid(),
    v_expires
  ) returning id into v_invite_id;

  insert into public.client_telegram_audit (
    portal_email, event_name, actor, details
  ) values (
    v_portal, 'invite_created', auth.uid()::text,
    jsonb_build_object('invite_id', v_invite_id, 'text_approver', v_make_approver)
  );

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expires_at', v_expires,
    'bot_username', 'MentoriTG_bot'
  );
end;
$$;

revoke all on function public.create_client_telegram_invite(text, boolean)
  from public, anon;
grant execute on function public.create_client_telegram_invite(text, boolean)
  to authenticated;

create or replace function public.link_client_telegram_member(
  p_token text,
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint,
  p_username text default null,
  p_first_name text default null,
  p_last_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_invite public.client_telegram_invites;
  v_member public.client_telegram_members;
  v_active_count int;
  v_portal_name text;
  v_make_approver boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_token), '') = ''
     or p_telegram_user_id is null or p_telegram_user_id <= 0
     or p_telegram_chat_id is null or p_telegram_chat_id <= 0
     or p_telegram_user_id <> p_telegram_chat_id then
    raise exception 'INVALID_TELEGRAM_IDENTITY' using errcode = '22023';
  end if;

  v_hash := encode(digest(convert_to(btrim(p_token), 'UTF8'), 'sha256'), 'hex');
  select * into v_invite
  from public.client_telegram_invites
  where token_hash = v_hash
  for update;
  if v_invite.id is null then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_invite.used_at is not null then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;
  if v_invite.revoked_at is not null or v_invite.expires_at < now() then
    raise exception 'INVITE_EXPIRED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('client-telegram:' || lower(v_invite.portal_email)));
  select * into v_member
  from public.client_telegram_members
  where telegram_user_id = p_telegram_user_id
  for update;
  if v_member.id is not null and v_member.is_active
     and lower(v_member.portal_email) <> lower(v_invite.portal_email) then
    raise exception 'TELEGRAM_ALREADY_LINKED' using errcode = '23505';
  end if;

  select count(*)::int into v_active_count
  from public.client_telegram_members
  where lower(portal_email) = lower(v_invite.portal_email)
    and is_active
    and (v_member.id is null or id <> v_member.id);
  if v_active_count >= 6 then
    raise exception 'MEMBER_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  select v_invite.is_text_approver
      or coalesce(v_member.is_text_approver, false)
      or not exists (
        select 1 from public.client_telegram_members member
        where lower(member.portal_email) = lower(v_invite.portal_email)
          and member.is_active and member.is_text_approver
          and (v_member.id is null or member.id <> v_member.id)
      )
  into v_make_approver;

  if v_make_approver then
    update public.client_telegram_members
    set is_text_approver = false, updated_at = now()
    where lower(portal_email) = lower(v_invite.portal_email)
      and is_active and is_text_approver;
  end if;

  if v_member.id is null then
    insert into public.client_telegram_members (
      portal_email, telegram_user_id, telegram_chat_id,
      telegram_username, telegram_first_name, telegram_last_name,
      contact_label, is_active, is_text_approver,
      status_notifications, schedule_notifications,
      linked_at, updated_at, last_seen_at, revoked_at
    ) values (
      lower(v_invite.portal_email), p_telegram_user_id, p_telegram_chat_id,
      nullif(lower(regexp_replace(coalesce(p_username, ''), '^@', '')), ''),
      nullif(btrim(p_first_name), ''), nullif(btrim(p_last_name), ''),
      coalesce(nullif(btrim(v_invite.contact_label), ''), nullif(btrim(p_first_name), ''),
               nullif(lower(regexp_replace(coalesce(p_username, ''), '^@', '')), ''),
               'Контакт'),
      true, v_make_approver, true, true,
      now(), now(), now(), null
    ) returning * into v_member;
  else
    update public.client_telegram_members
    set portal_email = lower(v_invite.portal_email),
        telegram_chat_id = p_telegram_chat_id,
        telegram_username = nullif(lower(regexp_replace(coalesce(p_username, ''), '^@', '')), ''),
        telegram_first_name = nullif(btrim(p_first_name), ''),
        telegram_last_name = nullif(btrim(p_last_name), ''),
        contact_label = coalesce(nullif(btrim(v_invite.contact_label), ''), contact_label,
          nullif(btrim(p_first_name), ''), 'Контакт'),
        is_active = true,
        is_text_approver = v_make_approver,
        status_notifications = true,
        schedule_notifications = true,
        linked_at = now(),
        updated_at = now(),
        last_seen_at = now(),
        revoked_at = null
    where id = v_member.id
    returning * into v_member;
  end if;

  update public.client_telegram_invites
  set used_at = now(), used_by_telegram_user_id = p_telegram_user_id
  where id = v_invite.id;

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    lower(v_invite.portal_email), v_member.id, 'member_linked',
    'telegram:' || p_telegram_user_id::text,
    jsonb_build_object('invite_id', v_invite.id, 'text_approver', v_member.is_text_approver)
  );

  select payload ->> 'name' into v_portal_name
  from public.client_snapshots
  where lower(email) = lower(v_invite.portal_email);

  return jsonb_build_object(
    'ok', true,
    'portal_email', lower(v_invite.portal_email),
    'portal_name', coalesce(v_portal_name, ''),
    'member_id', v_member.id,
    'contact_label', v_member.contact_label,
    'is_text_approver', v_member.is_text_approver
  );
end;
$$;

revoke all on function public.link_client_telegram_member(text, bigint, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.link_client_telegram_member(text, bigint, bigint, text, text, text)
  to service_role;

create or replace function public.update_my_client_telegram_member(
  p_member_id bigint,
  p_contact_label text,
  p_is_text_approver boolean,
  p_status_notifications boolean,
  p_schedule_notifications boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_member public.client_telegram_members;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if length(coalesce(p_contact_label, '')) > 100 then
    raise exception 'CONTACT_LABEL_TOO_LONG' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('client-telegram:' || v_portal));
  select * into v_member
  from public.client_telegram_members
  where id = p_member_id and lower(portal_email) = v_portal and is_active
  for update;
  if v_member.id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_member.is_text_approver and not coalesce(p_is_text_approver, false) then
    raise exception 'TEXT_APPROVER_REQUIRED' using errcode = 'P0001';
  end if;

  if coalesce(p_is_text_approver, false) then
    update public.client_telegram_members
    set is_text_approver = false, updated_at = now()
    where lower(portal_email) = v_portal and is_active and id <> v_member.id;
  end if;

  update public.client_telegram_members
  set contact_label = coalesce(nullif(btrim(p_contact_label), ''), contact_label, 'Контакт'),
      is_text_approver = coalesce(p_is_text_approver, false),
      status_notifications = coalesce(p_status_notifications, true),
      schedule_notifications = coalesce(p_schedule_notifications, true),
      updated_at = now()
  where id = v_member.id
  returning * into v_member;

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_portal, v_member.id, 'member_updated', auth.uid()::text,
    jsonb_build_object(
      'text_approver', v_member.is_text_approver,
      'status_notifications', v_member.status_notifications,
      'schedule_notifications', v_member.schedule_notifications
    )
  );

  return jsonb_build_object('ok', true, 'member_id', v_member.id);
end;
$$;

revoke all on function public.update_my_client_telegram_member(bigint, text, boolean, boolean, boolean)
  from public, anon;
grant execute on function public.update_my_client_telegram_member(bigint, text, boolean, boolean, boolean)
  to authenticated;

create or replace function public.revoke_my_client_telegram_member(p_member_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_member public.client_telegram_members;
  v_successor_id bigint;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('client-telegram:' || v_portal));
  select * into v_member
  from public.client_telegram_members
  where id = p_member_id and lower(portal_email) = v_portal and is_active
  for update;
  if v_member.id is null then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.client_telegram_members
  set is_active = false,
      is_text_approver = false,
      revoked_at = now(),
      updated_at = now()
  where id = v_member.id;

  if v_member.is_text_approver then
    update public.client_telegram_members
    set is_text_approver = true, updated_at = now()
    where id = (
      select id from public.client_telegram_members
      where lower(portal_email) = v_portal and is_active
      order by linked_at, id
      limit 1
    )
    returning id into v_successor_id;
  end if;
  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_portal, v_member.id, 'member_revoked', auth.uid()::text,
    jsonb_build_object('new_text_approver_member_id', v_successor_id)
  );
  return jsonb_build_object('ok', true, 'member_id', v_member.id);
end;
$$;

revoke all on function public.revoke_my_client_telegram_member(bigint)
  from public, anon;
grant execute on function public.revoke_my_client_telegram_member(bigint)
  to authenticated;

create or replace function public.resolve_client_telegram_context(
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.client_telegram_members;
  v_portal_name text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into v_member
  from public.client_telegram_members
  where telegram_user_id = p_telegram_user_id
    and telegram_chat_id = p_telegram_chat_id
    and is_active;
  if v_member.id is null then return null; end if;
  update public.client_telegram_members
  set last_seen_at = now(), updated_at = now()
  where id = v_member.id;
  select payload ->> 'name' into v_portal_name
  from public.client_snapshots
  where lower(email) = lower(v_member.portal_email);
  return jsonb_build_object(
    'member_id', v_member.id,
    'portal_email', lower(v_member.portal_email),
    'portal_name', coalesce(v_portal_name, ''),
    'contact_label', v_member.contact_label,
    'is_text_approver', v_member.is_text_approver,
    'status_notifications', v_member.status_notifications,
    'schedule_notifications', v_member.schedule_notifications
  );
end;
$$;

revoke all on function public.resolve_client_telegram_context(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.resolve_client_telegram_context(bigint, bigint)
  to service_role;

create or replace function public.get_client_telegram_recipients(
  p_portal_email text default null,
  p_kind text default 'status'
)
returns table (
  portal_email text,
  telegram_user_id bigint,
  telegram_chat_id bigint,
  telegram_username text,
  contact_label text,
  is_text_approver boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  return query
  select member.portal_email, member.telegram_user_id, member.telegram_chat_id,
         member.telegram_username, member.contact_label, member.is_text_approver
  from public.client_telegram_members member
  where member.is_active
    and (coalesce(btrim(p_portal_email), '') = ''
      or lower(member.portal_email) = lower(btrim(p_portal_email)))
    and case lower(coalesce(p_kind, 'status'))
      when 'text_approval' then member.is_text_approver
      when 'schedule' then member.schedule_notifications
      when 'status' then member.status_notifications
      when 'broadcast' then member.status_notifications
      else false
    end
  order by member.portal_email, member.is_text_approver desc, member.id;
end;
$$;

revoke all on function public.get_client_telegram_recipients(text, text)
  from public, anon, authenticated;
grant execute on function public.get_client_telegram_recipients(text, text)
  to service_role;

create or replace function public.queue_client_telegram_notification(
  p_portal_email text,
  p_kind text,
  p_message text,
  p_mentor_id text default null,
  p_profile_id text default null,
  p_new_status text default null,
  p_old_status text default null,
  p_created_by text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_count int;
begin
  if auth.role() <> 'authenticated' or v_role not in ('owner', 'team') then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_portal_email), '') = '' or coalesce(btrim(p_message), '') = '' then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;
  insert into public.notification_outbox (
    client_email, telegram_chat_id, telegram_username,
    kind, message, mentor_id, profile_id, new_status, old_status,
    status
  )
  select
    lower(btrim(p_portal_email)), member.telegram_chat_id, member.telegram_username,
    coalesce(nullif(btrim(p_kind), ''), 'status_change'), p_message,
    p_mentor_id, p_profile_id, p_new_status, p_old_status,
    'pending'
  from public.client_telegram_members member
  where lower(member.portal_email) = lower(btrim(p_portal_email))
    and member.is_active and member.status_notifications;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.queue_client_telegram_notification(
  text, text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.queue_client_telegram_notification(
  text, text, text, text, text, text, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
