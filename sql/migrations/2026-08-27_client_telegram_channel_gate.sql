-- Mandatory @Mento_ri membership for the Telegram client Mini App.
-- The bot stores the last live Telegram check. All Mini App bearer tokens are
-- denied centrally when the linked contact is not subscribed, so an old URL
-- cannot bypass the gate.

begin;

alter table public.client_telegram_members
  add column if not exists channel_subscription_active boolean not null default false,
  add column if not exists channel_subscription_verified_at timestamptz;

create index if not exists client_telegram_members_channel_gate_idx
  on public.client_telegram_members (is_active, channel_subscription_active, id);

create or replace function public.set_client_telegram_channel_subscription(
  p_telegram_chat_id bigint,
  p_is_subscribed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.client_telegram_members;
  v_previous boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member
  from public.client_telegram_members
  where telegram_chat_id = p_telegram_chat_id and is_active
  order by id
  limit 1
  for update;

  if v_member.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CONTACT_NOT_FOUND');
  end if;

  v_previous := v_member.channel_subscription_active;
  update public.client_telegram_members
  set channel_subscription_active = coalesce(p_is_subscribed, false),
      channel_subscription_verified_at = now(),
      updated_at = now()
  where id = v_member.id;

  if not coalesce(p_is_subscribed, false) then
    update public.client_telegram_webapp_tokens
    set revoked_at = coalesce(revoked_at, now())
    where member_id = v_member.id and revoked_at is null;
  end if;

  if v_previous is distinct from coalesce(p_is_subscribed, false) then
    insert into public.client_telegram_audit (
      portal_email, member_id, event_name, actor, details
    ) values (
      lower(v_member.portal_email), v_member.id,
      case when coalesce(p_is_subscribed, false)
        then 'channel_subscription_verified'
        else 'channel_subscription_revoked'
      end,
      'telegram-membership',
      jsonb_build_object(
        'previous', coalesce(v_previous, false),
        'current', coalesce(p_is_subscribed, false)
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'member_id', v_member.id,
    'portal_email', lower(v_member.portal_email),
    'channel_subscription_active', coalesce(p_is_subscribed, false)
  );
end;
$$;

revoke all on function public.set_client_telegram_channel_subscription(bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.set_client_telegram_channel_subscription(bigint, boolean)
  to service_role;

create or replace function public.list_client_telegram_channel_members()
returns table (
  member_id bigint,
  portal_email text,
  telegram_user_id bigint,
  telegram_chat_id bigint,
  channel_subscription_active boolean,
  channel_subscription_verified_at timestamptz
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
  select member.id, lower(member.portal_email), member.telegram_user_id,
         member.telegram_chat_id, member.channel_subscription_active,
         member.channel_subscription_verified_at
  from public.client_telegram_members member
  where member.is_active
  order by member.id;
end;
$$;

revoke all on function public.list_client_telegram_channel_members()
  from public, anon, authenticated;
grant execute on function public.list_client_telegram_channel_members()
  to service_role;

create or replace function public.issue_client_telegram_webapp_token(
  p_telegram_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.client_telegram_members;
  v_token text;
  v_expires_at timestamptz := now() + interval '30 minutes';
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member
  from public.client_telegram_members
  where telegram_chat_id = p_telegram_chat_id and is_active
  order by id
  limit 1;
  if v_member.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CONTACT_NOT_FOUND');
  end if;
  if not v_member.channel_subscription_active then
    return jsonb_build_object('ok', false, 'reason', 'CHANNEL_SUBSCRIPTION_REQUIRED');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.client_telegram_webapp_tokens (
    token_hash, portal_email, member_id, telegram_chat_id, expires_at, token_kind
  ) values (
    digest(v_token, 'sha256'), lower(v_member.portal_email),
    v_member.id, v_member.telegram_chat_id, v_expires_at, 'session'
  );

  delete from public.client_telegram_webapp_tokens
  where expires_at < now() - interval '1 day';

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.issue_client_telegram_webapp_token(bigint)
  from public, anon, authenticated;
grant execute on function public.issue_client_telegram_webapp_token(bigint)
  to service_role;

create or replace function public.issue_client_telegram_menu_token(
  p_telegram_chat_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.client_telegram_members;
  v_token text;
  v_expires_at timestamptz := now() + interval '10 years';
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_member
  from public.client_telegram_members
  where telegram_chat_id = p_telegram_chat_id and is_active
  order by id
  limit 1;
  if v_member.id is null then
    return jsonb_build_object('ok', false, 'reason', 'CONTACT_NOT_FOUND');
  end if;
  if not v_member.channel_subscription_active then
    return jsonb_build_object('ok', false, 'reason', 'CHANNEL_SUBSCRIPTION_REQUIRED');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.client_telegram_webapp_tokens (
    token_hash, portal_email, member_id, telegram_chat_id, expires_at, token_kind
  ) values (
    digest(v_token, 'sha256'), lower(v_member.portal_email), v_member.id,
    v_member.telegram_chat_id, v_expires_at, 'menu'
  );

  delete from public.client_telegram_webapp_tokens
  where expires_at < now() - interval '1 day';

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.issue_client_telegram_menu_token(bigint)
  from public, anon, authenticated;
grant execute on function public.issue_client_telegram_menu_token(bigint)
  to service_role;

create or replace function public.activate_client_telegram_menu_token(
  p_telegram_chat_id bigint,
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_id bigint;
  v_member_id bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select token.id, token.member_id
  into v_token_id, v_member_id
  from public.client_telegram_webapp_tokens token
  join public.client_telegram_members member on member.id = token.member_id
  where token.token_hash = digest(btrim(coalesce(p_token, '')), 'sha256')
    and token.telegram_chat_id = p_telegram_chat_id
    and token.token_kind = 'menu'
    and token.revoked_at is null
    and token.expires_at > now()
    and member.is_active
    and member.channel_subscription_active
  limit 1;

  if v_token_id is null then
    return false;
  end if;

  update public.client_telegram_webapp_tokens
  set revoked_at = now()
  where member_id = v_member_id
    and token_kind = 'menu'
    and id <> v_token_id
    and revoked_at is null;

  return true;
end;
$$;

revoke all on function public.activate_client_telegram_menu_token(bigint, text)
  from public, anon, authenticated;
grant execute on function public.activate_client_telegram_menu_token(bigint, text)
  to service_role;

create or replace function public.client_telegram_webapp_context(p_token text)
returns table(portal_email text, member_id bigint, telegram_chat_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_id bigint;
  v_portal_email text;
  v_member_id bigint;
  v_telegram_chat_id bigint;
  v_revoked_at timestamptz;
  v_is_subscribed boolean;
begin
  select token.id, token.portal_email, token.member_id,
         token.telegram_chat_id, token.revoked_at,
         member.channel_subscription_active
  into v_token_id, v_portal_email, v_member_id,
       v_telegram_chat_id, v_revoked_at, v_is_subscribed
  from public.client_telegram_webapp_tokens token
  join public.client_telegram_members member on member.id = token.member_id
  where token.token_hash = digest(btrim(coalesce(p_token, '')), 'sha256')
    and token.expires_at > now()
    and member.is_active
  limit 1;

  if v_token_id is null then
    return;
  end if;
  if not coalesce(v_is_subscribed, false) then
    raise exception 'CHANNEL_SUBSCRIPTION_REQUIRED' using errcode = '42501';
  end if;
  if v_revoked_at is not null then
    return;
  end if;

  portal_email := v_portal_email;
  member_id := v_member_id;
  telegram_chat_id := v_telegram_chat_id;
  return next;
end;
$$;

revoke all on function public.client_telegram_webapp_context(text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
