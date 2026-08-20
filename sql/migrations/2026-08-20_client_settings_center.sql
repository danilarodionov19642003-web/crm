-- Separate client settings from the shared CRM blob and add per-contact
-- Telegram preferences for package progress notifications.

begin;

create table if not exists public.client_portal_profiles (
  portal_email text primary key,
  contact_name text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (portal_email = lower(btrim(portal_email))),
  check (length(contact_name) <= 100),
  check (length(phone) <= 32)
);

alter table public.client_portal_profiles enable row level security;

drop policy if exists client_portal_profiles_staff_select on public.client_portal_profiles;
create policy client_portal_profiles_staff_select
  on public.client_portal_profiles for select to authenticated
  using (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('owner', 'team'));

revoke all on public.client_portal_profiles from anon, authenticated;
grant select on public.client_portal_profiles to authenticated;
grant all on public.client_portal_profiles to service_role;

create or replace function public.get_my_client_portal_profile()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_contact_name text := '';
  v_phone text := '';
  v_cabinet_name text := '';
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select profile.contact_name, profile.phone
  into v_contact_name, v_phone
  from public.client_portal_profiles profile
  where profile.portal_email = v_portal;

  select coalesce(snapshot.payload ->> 'name', '')
  into v_cabinet_name
  from public.client_snapshots snapshot
  where lower(snapshot.email) = v_portal;

  return jsonb_build_object(
    'portal_email', v_portal,
    'cabinet_name', coalesce(v_cabinet_name, ''),
    'contact_name', coalesce(v_contact_name, ''),
    'phone', coalesce(v_phone, '')
  );
end;
$$;

revoke all on function public.get_my_client_portal_profile() from public, anon;
grant execute on function public.get_my_client_portal_profile() to authenticated;

create or replace function public.update_my_client_portal_profile(
  p_contact_name text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_contact_name text := btrim(coalesce(p_contact_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_profile public.client_portal_profiles;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if length(v_contact_name) > 100 then
    raise exception 'CONTACT_NAME_TOO_LONG' using errcode = '22023';
  end if;
  if length(v_phone) > 32 then
    raise exception 'PHONE_TOO_LONG' using errcode = '22023';
  end if;
  if v_phone ~ '[[:cntrl:]]' then
    raise exception 'PHONE_INVALID' using errcode = '22023';
  end if;

  insert into public.client_portal_profiles (
    portal_email, contact_name, phone, created_at, updated_at
  ) values (
    v_portal, v_contact_name, v_phone, now(), now()
  )
  on conflict (portal_email) do update
  set contact_name = excluded.contact_name,
      phone = excluded.phone,
      updated_at = now()
  returning * into v_profile;

  return jsonb_build_object(
    'portal_email', v_profile.portal_email,
    'contact_name', v_profile.contact_name,
    'phone', v_profile.phone,
    'updated_at', v_profile.updated_at
  );
end;
$$;

revoke all on function public.update_my_client_portal_profile(text, text) from public, anon;
grant execute on function public.update_my_client_portal_profile(text, text) to authenticated;

alter table public.client_telegram_members
  add column if not exists low_reviews_notifications boolean not null default true,
  add column if not exists order_completed_notifications boolean not null default true;

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
    'low_reviews_notifications', member.low_reviews_notifications,
    'order_completed_notifications', member.order_completed_notifications,
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

create or replace function public.update_my_client_telegram_settings(
  p_member_id bigint,
  p_contact_label text,
  p_is_text_approver boolean,
  p_status_notifications boolean,
  p_schedule_notifications boolean,
  p_low_reviews_notifications boolean,
  p_order_completed_notifications boolean
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
      low_reviews_notifications = coalesce(p_low_reviews_notifications, true),
      order_completed_notifications = coalesce(p_order_completed_notifications, true),
      updated_at = now()
  where id = v_member.id
  returning * into v_member;

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    v_portal, v_member.id, 'member_settings_updated', auth.uid()::text,
    jsonb_build_object(
      'text_approver', v_member.is_text_approver,
      'status_notifications', v_member.status_notifications,
      'schedule_notifications', v_member.schedule_notifications,
      'low_reviews_notifications', v_member.low_reviews_notifications,
      'order_completed_notifications', v_member.order_completed_notifications
    )
  );

  return jsonb_build_object('ok', true, 'member_id', v_member.id);
end;
$$;

revoke all on function public.update_my_client_telegram_settings(
  bigint, text, boolean, boolean, boolean, boolean, boolean
) from public, anon;
grant execute on function public.update_my_client_telegram_settings(
  bigint, text, boolean, boolean, boolean, boolean, boolean
) to authenticated;

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
      when 'low_reviews' then member.low_reviews_notifications
      when 'order_completed' then member.order_completed_notifications
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
  v_kind text := lower(coalesce(nullif(btrim(p_kind), ''), 'status_change'));
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
    v_kind, p_message, p_mentor_id, p_profile_id, p_new_status, p_old_status,
    'pending'
  from public.client_telegram_members member
  where lower(member.portal_email) = lower(btrim(p_portal_email))
    and member.is_active
    and case v_kind
      when 'schedule' then member.schedule_notifications
      when 'low_reviews' then member.low_reviews_notifications
      when 'order_completed' then member.order_completed_notifications
      else member.status_notifications
    end;
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

create unique index if not exists notification_outbox_client_progress_unique_idx
  on public.notification_outbox (kind, action_ref, telegram_chat_id)
  where kind in ('low_reviews', 'order_completed')
    and action_ref is not null and telegram_chat_id is not null;

create or replace function public.queue_client_progress_notification(
  p_portal_email text,
  p_kind text,
  p_message text,
  p_mentor_id text,
  p_profile_id text,
  p_action_ref text,
  p_created_by text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '');
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_count int;
begin
  if auth.role() <> 'authenticated' or v_role not in ('owner', 'team') then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_kind not in ('low_reviews', 'order_completed')
     or coalesce(btrim(p_portal_email), '') = ''
     or coalesce(btrim(p_message), '') = ''
     or coalesce(btrim(p_action_ref), '') = '' then
    raise exception 'INVALID_ARGUMENTS' using errcode = '22023';
  end if;

  insert into public.notification_outbox (
    client_email, telegram_chat_id, telegram_username,
    kind, message, mentor_id, profile_id, action_ref, status
  )
  select
    lower(btrim(p_portal_email)), member.telegram_chat_id, member.telegram_username,
    v_kind, p_message, p_mentor_id, p_profile_id, btrim(p_action_ref), 'pending'
  from public.client_telegram_members member
  where lower(member.portal_email) = lower(btrim(p_portal_email))
    and member.is_active
    and case v_kind
      when 'low_reviews' then member.low_reviews_notifications
      when 'order_completed' then member.order_completed_notifications
      else false
    end
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.queue_client_progress_notification(
  text, text, text, text, text, text, text
) from public, anon;
grant execute on function public.queue_client_progress_notification(
  text, text, text, text, text, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
