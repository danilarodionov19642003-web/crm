-- A paid referral rewards both sides: the invitee receives the existing
-- zero-price order and the referrer receives one review in their bonus balance.

begin;

alter table public.client_referrals
  add column if not exists referrer_bonus_qty integer not null default 0,
  add column if not exists referrer_bonus_used_qty integer not null default 0,
  add column if not exists referrer_bonus_awarded_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_referrals'::regclass
      and conname = 'client_referrals_referrer_bonus_qty_check'
  ) then
    alter table public.client_referrals
      add constraint client_referrals_referrer_bonus_qty_check
      check (referrer_bonus_qty >= 0 and referrer_bonus_used_qty >= 0
        and referrer_bonus_used_qty <= referrer_bonus_qty);
  end if;
end;
$$;

-- Referrals completed before this migration are entitled to the same reward.
update public.client_referrals
set referrer_bonus_qty = greatest(referrer_bonus_qty, 1),
    referrer_bonus_awarded_at = coalesce(referrer_bonus_awarded_at, bonus_applied_at, now()),
    updated_at = now()
where status = 'applied';

create or replace function public.get_my_client_referral_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_portal text := public.current_client_portal_email();
  v_code text;
  v_name text := '';
  v_referrals jsonb := '[]'::jsonb;
  v_bonus_earned integer := 0;
  v_bonus_used integer := 0;
begin
  if auth.role() <> 'authenticated'
     or coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'client'
     or v_portal = '' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('client-referral-code:' || v_portal));
  select referral_code into v_code
  from public.client_referral_codes
  where portal_email = v_portal;

  if v_code is null then
    v_code := encode(gen_random_bytes(18), 'hex');
    insert into public.client_referral_codes (portal_email, referral_code)
    values (v_portal, v_code)
    on conflict (portal_email) do update set updated_at = now()
    returning referral_code into v_code;
  end if;

  select coalesce(snapshot.payload ->> 'name', '') into v_name
  from public.client_snapshots snapshot
  where lower(snapshot.email) = v_portal;

  select
    coalesce(sum(referral.referrer_bonus_qty), 0)::integer,
    coalesce(sum(referral.referrer_bonus_used_qty), 0)::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'id', referral.id,
      'username', referral.telegram_username,
      'first_name', referral.telegram_first_name,
      'last_name', referral.telegram_last_name,
      'joined_at', referral.joined_at,
      'linked_at', referral.linked_at,
      'status', referral.status,
      'bonus_applied_at', referral.bonus_applied_at,
      'referrer_bonus_qty', referral.referrer_bonus_qty,
      'referrer_bonus_used_qty', referral.referrer_bonus_used_qty,
      'referrer_bonus_awarded_at', referral.referrer_bonus_awarded_at
    ) order by referral.joined_at desc, referral.id desc), '[]'::jsonb)
  into v_bonus_earned, v_bonus_used, v_referrals
  from public.client_referrals referral
  where referral.referrer_portal_email = v_portal;

  return jsonb_build_object(
    'referral_code', v_code,
    'bot_username', 'MentoriTG_bot',
    'cabinet_name', coalesce(v_name, ''),
    'bonus_earned', v_bonus_earned,
    'bonus_used', v_bonus_used,
    'bonus_available', greatest(0, v_bonus_earned - v_bonus_used),
    'referrals', v_referrals
  );
end;
$$;

revoke all on function public.get_my_client_referral_dashboard() from public, anon;
grant execute on function public.get_my_client_referral_dashboard() to authenticated;

create or replace function public.complete_client_referral_bonus(
  p_order_id bigint,
  p_anketa_code text,
  p_anketa_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.client_orders;
  v_referral public.client_referrals;
  v_bonus_id bigint;
  v_referrer_available integer;
begin
  if not public.referral_bonus_actor_allowed() then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(btrim(p_anketa_code), '') = '' then
    raise exception 'ANKETA_REQUIRED' using errcode = '22023';
  end if;

  select * into v_order from public.client_orders
  where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_referral
  from public.client_referrals
  where bonus_order_id = p_order_id and status in ('reserved', 'applied')
  for update;
  if v_referral.id is null then
    return jsonb_build_object('ok', false, 'reason', 'BONUS_NOT_RESERVED');
  end if;

  insert into public.client_orders (
    parent_order_id, parent_item_id, client_email, client_name,
    anketa_code, anketa_name, is_new_anketa,
    tariff_name, tariff_price, qty, amount, pay_full, prepay_amount,
    remainder_status, order_type, comment,
    offer_agreed, offer_text, offer_version,
    personal_data_agreed, personal_data_consent_text,
    personal_data_consent_version, consent_user_agent,
    status, confirmed_at, created_by, payment_method, discount_amount,
    payment_provider, payment_id, payment_status,
    payment_environment, payment_created_at, payment_paid_at
  ) values (
    v_order.id, 'referral-bonus', v_order.client_email, v_order.client_name,
    btrim(p_anketa_code), coalesce(nullif(btrim(p_anketa_name), ''), btrim(p_anketa_code)), false,
    'Реферальный бонус', 0, 1, 0, true, 0,
    null, 'referral_bonus', '1 отзыв в подарок за первый заказ по рекомендации',
    v_order.offer_agreed, v_order.offer_text, v_order.offer_version,
    v_order.personal_data_agreed, v_order.personal_data_consent_text,
    v_order.personal_data_consent_version, v_order.consent_user_agent,
    'confirmed', coalesce(v_order.confirmed_at, now()), 'referral-program',
    coalesce(v_order.payment_method, 'online'), 0,
    v_order.payment_provider, v_order.payment_id, coalesce(v_order.payment_status, 'paid'),
    v_order.payment_environment, v_order.payment_created_at, coalesce(v_order.payment_paid_at, now())
  )
  on conflict (parent_order_id, parent_item_id)
    where parent_order_id is not null do update
  set anketa_code = excluded.anketa_code,
      anketa_name = excluded.anketa_name,
      confirmed_at = excluded.confirmed_at
  returning id into v_bonus_id;

  update public.client_referrals
  set status = 'applied',
      bonus_applied_at = coalesce(bonus_applied_at, now()),
      referrer_bonus_qty = greatest(referrer_bonus_qty, 1),
      referrer_bonus_awarded_at = coalesce(referrer_bonus_awarded_at, now()),
      updated_at = now()
  where id = v_referral.id;

  select coalesce(sum(referrer_bonus_qty - referrer_bonus_used_qty), 0)::integer
  into v_referrer_available
  from public.client_referrals
  where referrer_portal_email = v_referral.referrer_portal_email;

  return jsonb_build_object(
    'ok', true,
    'referral_id', v_referral.id,
    'bonus_order_id', v_bonus_id,
    'bonus_qty', 1,
    'referrer_bonus_qty', 1,
    'referrer_bonus_available', greatest(0, v_referrer_available)
  );
end;
$$;

revoke all on function public.complete_client_referral_bonus(bigint, text, text)
  from public, anon;
grant execute on function public.complete_client_referral_bonus(bigint, text, text)
  to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mentori_payments') then
    execute 'grant execute on function public.complete_client_referral_bonus(bigint, text, text) to mentori_payments';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
