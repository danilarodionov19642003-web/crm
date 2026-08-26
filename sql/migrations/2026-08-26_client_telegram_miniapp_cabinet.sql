-- Expand the token-gated Telegram Mini App from a calendar into a compact
-- client cabinet. Only fields already present in the client's own snapshot
-- are returned; the CRM blob and portal credentials remain inaccessible.

begin;

create or replace function public.get_client_telegram_calendar(
  p_token text,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_portal text;
  v_member_id bigint;
  v_snapshot jsonb;
  v_from date := greatest(coalesce(p_from, current_date + 1), current_date + 1);
  v_to date := least(coalesce(p_to, current_date + 45), current_date + 90);
  v_anketas jsonb;
  v_calendar jsonb;
begin
  select ctx.portal_email, ctx.member_id
  into v_portal, v_member_id
  from public.client_telegram_webapp_context(p_token) ctx;
  if v_portal is null then
    raise exception 'TOKEN_INVALID_OR_EXPIRED' using errcode = '42501';
  end if;
  if v_to < v_from or v_to - v_from > 90 then
    raise exception 'DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  select payload into v_snapshot
  from public.client_snapshots
  where lower(email) = lower(v_portal);
  if v_snapshot is null then
    raise exception 'PORTAL_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.client_telegram_webapp_tokens
  set last_used_at = now()
  where token_hash = digest(btrim(p_token), 'sha256');

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'mentor_id', anketa ->> 'mentorId',
      'code', anketa ->> 'code',
      'name', anketa ->> 'name',
      'avatar_url', anketa ->> 'avatarUrl',
      'profile_url', anketa ->> 'profileUrl',
      'platform', anketa ->> 'platform',
      'tariff', anketa ->> 'tariff',
      'deadline', anketa ->> 'deadline',
      'closed', coalesce((anketa ->> 'closed')::boolean, false),
      'ordered', greatest(0, coalesce(nullif(anketa ->> 'ordered', '')::int, 0)),
      'done', greatest(0, coalesce(nullif(anketa ->> 'done', '')::int, 0)),
      'paid', greatest(0, coalesce(nullif(anketa ->> 'paid', '')::numeric, 0)),
      'remain', greatest(0, coalesce(nullif(anketa ->> 'remain', '')::numeric, 0)),
      'total', greatest(0, coalesce(nullif(anketa ->> 'total', '')::numeric, 0)),
      'schedule_limit', greatest(0, coalesce(nullif(anketa ->> 'scheduleLimit', '')::int, 0)),
      'active_count', (
        select count(*)::int from public.client_outreach_slots slot
        where lower(slot.client_email) = lower(v_portal)
          and slot.mentor_id = anketa ->> 'mentorId'
          and slot.slot_status = 'scheduled'
          and slot.scheduled_date >= current_date
      ),
      'available_to_add', case
        when coalesce((anketa ->> 'closed')::boolean, false) then 0
        else greatest(0,
          coalesce(nullif(anketa ->> 'scheduleLimit', '')::int, 0) - (
            select count(*)::int from public.client_outreach_slots slot
            where lower(slot.client_email) = lower(v_portal)
              and slot.mentor_id = anketa ->> 'mentorId'
              and slot.slot_status = 'scheduled'
              and slot.scheduled_date >= current_date
          )
        )
      end,
      'slots', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', slot.id,
          'scheduled_date', slot.scheduled_date,
          'slot_status', slot.slot_status
        ) order by slot.scheduled_date, slot.id), '[]'::jsonb)
        from public.client_outreach_slots slot
        where lower(slot.client_email) = lower(v_portal)
          and slot.mentor_id = anketa ->> 'mentorId'
          and slot.slot_status = 'scheduled'
          and slot.scheduled_date >= current_date
      ),
      'statuses', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', recent.item ->> 'id',
          'profile_name', recent.item ->> 'profileName',
          'status', recent.item ->> 'status',
          'date', recent.item ->> 'date'
        ) order by recent.item ->> 'date' desc, recent.item ->> 'id'), '[]'::jsonb)
        from (
          select status_item as item
          from jsonb_array_elements(coalesce(anketa -> 'statuses', '[]'::jsonb)) status_item
          order by status_item ->> 'date' desc, status_item ->> 'id'
          limit 12
        ) recent
      ),
      'reviews', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', recent.item ->> 'id',
          'profile_name', recent.item ->> 'profileName',
          'text', recent.item ->> 'text',
          'date', recent.item ->> 'date'
        ) order by recent.item ->> 'date' desc, recent.item ->> 'id'), '[]'::jsonb)
        from (
          select review_item as item
          from jsonb_array_elements(coalesce(anketa -> 'reviews', '[]'::jsonb)) review_item
          order by review_item ->> 'date' desc, review_item ->> 'id'
          limit 4
        ) recent
      )
    ) order by coalesce((anketa ->> 'closed')::boolean, false), anketa ->> 'code'
  ), '[]'::jsonb)
  into v_anketas
  from jsonb_array_elements(coalesce(v_snapshot -> 'anketas', '[]'::jsonb)) anketa;

  select coalesce(jsonb_agg(jsonb_build_object(
    'date', day_value::date,
    'used_count', used_count,
    'capacity', 7,
    'available_count', greatest(0, 7 - used_count)
  ) order by day_value), '[]'::jsonb)
  into v_calendar
  from (
    select day_value, (
      select count(*)::int from public.client_outreach_slots slot
      where slot.scheduled_date = day_value::date
        and slot.slot_status = 'scheduled'
    ) as used_count
    from generate_series(v_from, v_to, interval '1 day') day_value
  ) days;

  return jsonb_build_object(
    'ok', true,
    'client_name', coalesce(v_snapshot ->> 'name', ''),
    'generated_at', v_snapshot ->> 'generatedAt',
    'totals', coalesce(v_snapshot -> 'totals', '{}'::jsonb),
    'minimum_date', (current_date + 1),
    'anketas', v_anketas,
    'calendar', v_calendar
  );
end;
$$;

revoke all on function public.get_client_telegram_calendar(text, date, date)
  from public;
grant execute on function public.get_client_telegram_calendar(text, date, date)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
