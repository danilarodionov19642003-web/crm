-- Passwordless full client-cabinet login from a linked Telegram contact and
-- per-contact notification controls exposed by the bot. The bot never reads,
-- stores or sends a client password.

begin;

create or replace function public.prepare_client_telegram_passwordless_login(
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_member public.client_telegram_members;
  v_auth_user auth.users;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_telegram_user_id is null or p_telegram_chat_id is null
     or p_telegram_user_id <= 0 or p_telegram_chat_id <= 0 then
    raise exception 'INVALID_TELEGRAM_ID' using errcode = '22023';
  end if;

  select * into v_member
  from public.client_telegram_members member
  where member.telegram_user_id = p_telegram_user_id
    and member.telegram_chat_id = p_telegram_chat_id
    and member.is_active
  order by member.id
  limit 1;

  if v_member.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CONTACT_NOT_FOUND');
  end if;
  if not v_member.channel_subscription_active then
    return jsonb_build_object('ok', false, 'reason', 'CHANNEL_SUBSCRIPTION_REQUIRED');
  end if;

  select user_row.* into v_auth_user
  from auth.users user_row
  where coalesce(user_row.raw_app_meta_data ->> 'role', '') = 'client'
    and lower(coalesce(
      nullif(btrim(user_row.raw_app_meta_data ->> 'portal_email'), ''),
      btrim(user_row.email)
    )) = lower(btrim(v_member.portal_email))
    and coalesce(btrim(user_row.email), '') <> ''
  order by user_row.last_sign_in_at desc nulls last,
           user_row.updated_at desc nulls last,
           user_row.created_at desc
  limit 1;

  if v_auth_user.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CLIENT_ACCOUNT_NOT_FOUND');
  end if;

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    lower(v_member.portal_email), v_member.id,
    'telegram_passwordless_login_prepared',
    'telegram:' || p_telegram_user_id::text,
    jsonb_build_object('telegram_chat_id', p_telegram_chat_id)
  );

  return jsonb_build_object(
    'ok', true,
    'member_id', v_member.id,
    'portal_email', lower(v_member.portal_email),
    'auth_user_id', v_auth_user.id,
    'login_email', lower(v_auth_user.email)
  );
end;
$$;

revoke all on function public.prepare_client_telegram_passwordless_login(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.prepare_client_telegram_passwordless_login(bigint, bigint)
  to service_role;

create or replace function public.get_client_telegram_bot_settings(
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
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member
  from public.client_telegram_members member
  where member.telegram_user_id = p_telegram_user_id
    and member.telegram_chat_id = p_telegram_chat_id
    and member.is_active
  order by member.id
  limit 1;

  if v_member.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CONTACT_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'ok', true,
    'member_id', v_member.id,
    'status_notifications', v_member.status_notifications,
    'schedule_notifications', v_member.schedule_notifications,
    'low_reviews_notifications', v_member.low_reviews_notifications,
    'order_completed_notifications', v_member.order_completed_notifications
  );
end;
$$;

revoke all on function public.get_client_telegram_bot_settings(bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.get_client_telegram_bot_settings(bigint, bigint)
  to service_role;

create or replace function public.update_client_telegram_bot_notification_setting(
  p_telegram_user_id bigint,
  p_telegram_chat_id bigint,
  p_setting text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.client_telegram_members;
  v_setting text := lower(btrim(coalesce(p_setting, '')));
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_setting not in ('status', 'schedule', 'low_reviews', 'order_completed')
     or p_enabled is null then
    raise exception 'INVALID_NOTIFICATION_SETTING' using errcode = '22023';
  end if;

  select * into v_member
  from public.client_telegram_members member
  where member.telegram_user_id = p_telegram_user_id
    and member.telegram_chat_id = p_telegram_chat_id
    and member.is_active
  order by member.id
  limit 1
  for update;

  if v_member.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CONTACT_NOT_FOUND');
  end if;

  update public.client_telegram_members
  set status_notifications = case
        when v_setting = 'status' then p_enabled else status_notifications end,
      schedule_notifications = case
        when v_setting = 'schedule' then p_enabled else schedule_notifications end,
      low_reviews_notifications = case
        when v_setting = 'low_reviews' then p_enabled else low_reviews_notifications end,
      order_completed_notifications = case
        when v_setting = 'order_completed' then p_enabled else order_completed_notifications end,
      updated_at = now()
  where id = v_member.id
  returning * into v_member;

  insert into public.client_telegram_audit (
    portal_email, member_id, event_name, actor, details
  ) values (
    lower(v_member.portal_email), v_member.id,
    'member_bot_notifications_updated',
    'telegram:' || p_telegram_user_id::text,
    jsonb_build_object('setting', v_setting, 'enabled', p_enabled)
  );

  return jsonb_build_object(
    'ok', true,
    'member_id', v_member.id,
    'status_notifications', v_member.status_notifications,
    'schedule_notifications', v_member.schedule_notifications,
    'low_reviews_notifications', v_member.low_reviews_notifications,
    'order_completed_notifications', v_member.order_completed_notifications
  );
end;
$$;

revoke all on function public.update_client_telegram_bot_notification_setting(
  bigint, bigint, text, boolean
) from public, anon, authenticated;
grant execute on function public.update_client_telegram_bot_notification_setting(
  bigint, bigint, text, boolean
) to service_role;

notify pgrst, 'reload schema';

commit;
