\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if value is not true then
    raise exception 'VERIFY_FAILED: %', message;
  end if;
end;
$$;

select
  'referrer-' || replace(gen_random_uuid()::text, '-', '') || '@example.test' as referrer_email,
  'referred-' || replace(gen_random_uuid()::text, '-', '') || '@example.test' as referred_email,
  gen_random_uuid()::text as referrer_uid,
  (920000000000 + floor(random() * 70000000))::bigint as telegram_id,
  'referred-late-' || replace(gen_random_uuid()::text, '-', '') || '@example.test' as referred_email_late,
  (990000000000 + floor(random() * 7000000))::bigint as telegram_id_late,
  (select md5(data::text) from public.crm_state where id = 'main') as crm_hash,
  (select count(*) from public.client_snapshots) as snapshot_count
\gset referral_

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', :'referral_referrer_uid',
    'email', :'referral_referrer_email',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'role', 'client',
      'portal_email', :'referral_referrer_email'
    )
  )::text,
  true
);
set local role authenticated;

select public.get_my_client_referral_dashboard() ->> 'referral_code' as code
\gset referral_

reset role;
select pg_temp.assert_true(
  :'referral_code' ~ '^[a-f0-9]{36}$',
  'client referral code was not created'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

insert into public.client_telegram_members (
  portal_email, telegram_user_id, telegram_chat_id, telegram_username,
  contact_label, is_active, is_text_approver
) values (
  :'referral_referred_email', :'referral_telegram_id'::bigint,
  :'referral_telegram_id'::bigint, 'referral_verify',
  'Иван', true, false
);

select public.register_client_referral(
  :'referral_code', :'referral_telegram_id'::bigint, :'referral_telegram_id'::bigint,
  'referral_verify', 'Иван', 'Проверочный'
);

select public.register_client_referral(
  :'referral_code', :'referral_telegram_id_late'::bigint, :'referral_telegram_id_late'::bigint,
  'referral_verify_late', 'Анна', 'Поздняя'
);

insert into public.client_telegram_members (
  portal_email, telegram_user_id, telegram_chat_id, telegram_username,
  contact_label, is_active, is_text_approver
) values (
  :'referral_referred_email_late', :'referral_telegram_id_late'::bigint,
  :'referral_telegram_id_late'::bigint, 'referral_verify_late',
  'Анна', true, false
);

insert into public.client_orders (
  client_email, client_name, anketa_code, anketa_name,
  tariff_name, tariff_price, qty, amount, pay_full, prepay_amount,
  order_type, status, payment_method, discount_amount,
  offer_agreed, personal_data_agreed
) values (
  :'referral_referred_email', 'Проверочный клиент', 'a999', 'Проверочная анкета',
  'Поддержка', 8290, 6, 8290, false, 4145,
  'multi_order', 'new', 'online', 0, true, true
)
returning id as first_order_id
\gset referral_

reset role;

select pg_temp.assert_true(
  (select referred_portal_email = :'referral_referred_email' and status = 'pending'
   from public.client_referrals where telegram_user_id = :'referral_telegram_id'::bigint),
  'Telegram link did not attach the referral to the cabinet'
);

select pg_temp.assert_true(
  (select referred_portal_email = :'referral_referred_email_late' and status = 'pending'
   from public.client_referrals where telegram_user_id = :'referral_telegram_id_late'::bigint),
  'Referral did not attach when Telegram was linked after the bot click'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', gen_random_uuid()::text,
    'email', 'owner@verify.test',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'owner')
  )::text,
  true
);
set local role authenticated;

select (public.reserve_client_referral_bonus(:'referral_first_order_id'::bigint) ->> 'bonus_qty')::int
  as first_bonus_qty
\gset referral_

reset role;
select pg_temp.assert_true(
  :'referral_first_bonus_qty'::int = 1,
  'first paid order did not reserve one referral review'
);

set local role service_role;
update public.client_orders
set status = 'confirmed', confirmed_at = now(), payment_status = 'paid', payment_paid_at = now()
where id = :'referral_first_order_id'::bigint;
reset role;

set local role authenticated;
select public.complete_client_referral_bonus(
  :'referral_first_order_id'::bigint, 'a999', 'Проверочная анкета'
);
reset role;

select pg_temp.assert_true(
  (select count(*) = 1 from public.client_orders
   where parent_order_id = :'referral_first_order_id'::bigint
     and parent_item_id = 'referral-bonus'
     and order_type = 'referral_bonus'
     and tariff_name = 'Реферальный бонус'
     and qty = 1 and amount = 0 and prepay_amount = 0),
  'referral bonus order is missing or malformed'
);

select pg_temp.assert_true(
  (select status = 'applied' and bonus_applied_at is not null
   from public.client_referrals where telegram_user_id = :'referral_telegram_id'::bigint),
  'referral was not marked as applied'
);

set local role service_role;
insert into public.client_orders (
  client_email, client_name, anketa_code, anketa_name,
  tariff_name, tariff_price, qty, amount, pay_full, prepay_amount,
  order_type, status, payment_method, discount_amount,
  offer_agreed, personal_data_agreed
) values (
  :'referral_referred_email', 'Проверочный клиент', 'a999', 'Проверочная анкета',
  'Поддержка', 8290, 6, 8290, false, 4145,
  'multi_order', 'new', 'online', 0, true, true
)
returning id as second_order_id
\gset referral_
reset role;

set local role authenticated;
select (public.reserve_client_referral_bonus(:'referral_second_order_id'::bigint) ->> 'bonus_qty')::int
  as second_bonus_qty
\gset referral_
reset role;

select pg_temp.assert_true(
  :'referral_second_bonus_qty'::int = 0,
  'second order received another referral bonus'
);

select pg_temp.assert_true(
  (select md5(data::text) from public.crm_state where id = 'main') = :'referral_crm_hash',
  'referral metadata changed crm_state'
);

select pg_temp.assert_true(
  (select count(*) from public.client_snapshots) = :'referral_snapshot_count'::bigint,
  'referral metadata changed client snapshots'
);

rollback;

select 'CLIENT_REFERRALS_MIGRATION_VERIFY_OK' as result;
