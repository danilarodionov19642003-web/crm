-- Persistent per-chat Telegram menu button for the client Mini App.
-- Ordinary message links remain short-lived. Menu tokens are long-lived,
-- revocable bearer credentials stored only as SHA-256 digests. They stop
-- working immediately when the linked Telegram member is deactivated.

begin;

alter table public.client_telegram_webapp_tokens
  add column if not exists token_kind text not null default 'session';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_telegram_webapp_tokens'::regclass
      and conname = 'client_telegram_webapp_tokens_kind_check'
  ) then
    alter table public.client_telegram_webapp_tokens
      add constraint client_telegram_webapp_tokens_kind_check
      check (token_kind in ('session', 'menu'));
  end if;
end
$$;

create index if not exists client_telegram_webapp_tokens_menu_idx
  on public.client_telegram_webapp_tokens (member_id, expires_at desc)
  where token_kind = 'menu' and revoked_at is null;

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

notify pgrst, 'reload schema';

commit;
