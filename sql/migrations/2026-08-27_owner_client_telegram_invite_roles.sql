-- Preserve the owner's explicit approver choice on each personal Telegram
-- invite. The redeem RPC still promotes the first connected contact when a
-- cabinet has no approver, so the one-approver invariant remains intact even
-- when several one-time links are created before anybody opens them.

begin;

create or replace function public.create_client_telegram_invite_for_owner(
  p_portal_email text,
  p_contact_label text default null,
  p_is_text_approver boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_portal text := lower(btrim(coalesce(p_portal_email, '')));
  v_portal_name text;
  v_token text;
  v_expires timestamptz := now() + interval '24 hours';
  v_active_count int;
  v_invite_id bigint;
  v_make_approver boolean := coalesce(p_is_text_approver, false);
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'owner' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_portal = '' then
    raise exception 'PORTAL_REQUIRED' using errcode = '22023';
  end if;
  if length(coalesce(p_contact_label, '')) > 100 then
    raise exception 'CONTACT_LABEL_TOO_LONG' using errcode = '22023';
  end if;

  select payload ->> 'name' into v_portal_name
  from public.client_snapshots
  where lower(email) = v_portal;
  if v_portal_name is null then
    raise exception 'PORTAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('client-telegram:' || v_portal));
  select count(*)::int into v_active_count
  from public.client_telegram_members
  where lower(portal_email) = v_portal and is_active;
  if v_active_count >= 6 then
    raise exception 'MEMBER_LIMIT_REACHED' using errcode = 'P0001';
  end if;

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
    v_portal, 'owner_invite_created', auth.uid()::text,
    jsonb_build_object('invite_id', v_invite_id, 'text_approver', v_make_approver)
  );

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expires_at', v_expires,
    'bot_username', 'MentoriTG_bot',
    'portal_email', v_portal,
    'portal_name', coalesce(v_portal_name, '')
  );
end;
$$;

revoke all on function public.create_client_telegram_invite_for_owner(text, text, boolean)
  from public, anon;
grant execute on function public.create_client_telegram_invite_for_owner(text, text, boolean)
  to authenticated;

notify pgrst, 'reload schema';

commit;
