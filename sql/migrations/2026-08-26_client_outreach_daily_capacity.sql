-- One shared outreach capacity policy for the client cabinet, Telegram Mini App
-- and staff CRM calendar. Existing rows are intentionally left untouched.
-- Sunday 2026-08-30 remains allowed; the Sunday day off starts on 2026-09-06.

begin;

create or replace function public.client_outreach_capacity(p_date date)
returns int
language sql
immutable
set search_path = public
as $$
  select case
    when p_date is null then 0
    when p_date >= date '2026-09-06'
         and extract(isodow from p_date) = 7 then 0
    when extract(isodow from p_date) = 6 then 3
    else 7
  end
$$;

revoke all on function public.client_outreach_capacity(date)
  from public, anon, authenticated;

create or replace function public.enforce_client_outreach_day_off()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_capacity int;
  v_used int;
begin
  if new.slot_status <> 'scheduled' then
    return new;
  end if;

  v_capacity := public.client_outreach_capacity(new.scheduled_date);
  if v_capacity = 0 then
    raise exception 'OUTREACH_DAY_OFF' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('client-outreach-capacity:' || new.scheduled_date::text, 0)
  );

  if tg_op = 'UPDATE' then
    select count(*)::int into v_used
    from public.client_outreach_slots slot
    where slot.scheduled_date = new.scheduled_date
      and slot.slot_status = 'scheduled'
      and slot.id <> old.id;
  else
    select count(*)::int into v_used
    from public.client_outreach_slots slot
    where slot.scheduled_date = new.scheduled_date
      and slot.slot_status = 'scheduled';
  end if;

  if v_used >= v_capacity then
    if extract(isodow from new.scheduled_date) = 6 then
      raise exception 'OUTREACH_SATURDAY_FULL' using errcode = 'P0001';
    end if;
    raise exception 'DAY_FULL' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_client_outreach_day_off()
  from public, anon, authenticated;

drop trigger if exists client_outreach_slots_day_off_trg
  on public.client_outreach_slots;
create trigger client_outreach_slots_day_off_trg
before insert or update of scheduled_date, slot_status
on public.client_outreach_slots
for each row execute function public.enforce_client_outreach_day_off();

create or replace function public.get_client_outreach_calendar(
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
begin
  perform public.expire_past_client_outreach_slots();
  return query
  select
    calendar.schedule_date,
    calendar.used_count,
    public.client_outreach_capacity(calendar.schedule_date) as capacity,
    greatest(
      0,
      public.client_outreach_capacity(calendar.schedule_date) - calendar.used_count
    ) as available_count
  from public.get_client_outreach_calendar_v1(p_from, p_to) calendar;
end;
$$;

revoke all on function public.get_client_outreach_calendar(date, date)
  from public, anon;
grant execute on function public.get_client_outreach_calendar(date, date)
  to authenticated;

do $$
begin
  if to_regprocedure('public.get_client_telegram_calendar_v1(text,date,date)') is null then
    if to_regprocedure('public.get_client_telegram_calendar(text,date,date)') is null then
      raise exception 'get_client_telegram_calendar is missing';
    end if;
    alter function public.get_client_telegram_calendar(text, date, date)
      rename to get_client_telegram_calendar_v1;
  end if;
end;
$$;

revoke all on function public.get_client_telegram_calendar_v1(text, date, date)
  from public, anon, authenticated;

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
  v_payload jsonb;
  v_calendar jsonb;
begin
  v_payload := public.get_client_telegram_calendar_v1(p_token, p_from, p_to);

  select coalesce(jsonb_agg(
    item || jsonb_build_object(
      'capacity', public.client_outreach_capacity((item ->> 'date')::date),
      'available_count', greatest(
        0,
        public.client_outreach_capacity((item ->> 'date')::date)
          - coalesce((item ->> 'used_count')::int, 0)
      )
    ) order by item ->> 'date'
  ), '[]'::jsonb)
  into v_calendar
  from jsonb_array_elements(coalesce(v_payload -> 'calendar', '[]'::jsonb)) item;

  return jsonb_set(v_payload, '{calendar}', v_calendar, true);
end;
$$;

revoke all on function public.get_client_telegram_calendar(text, date, date)
  from public;
grant execute on function public.get_client_telegram_calendar(text, date, date)
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
