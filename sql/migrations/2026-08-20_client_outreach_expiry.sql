-- Expire unused outreach plans after their date and keep all client writes
-- behind the existing concurrency and package-limit checks.

begin;

create or replace function public.expire_past_client_outreach_slots()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_count int;
begin
  update public.client_outreach_slots
  set slot_status = 'cancelled',
      cancelled_at = coalesce(cancelled_at, now()),
      updated_at = now(),
      changed_by = 'system-expired-outreach'
  where slot_status = 'scheduled'
    and scheduled_date < current_date;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.expire_past_client_outreach_slots()
  from public, anon, authenticated;

-- Preserve the already audited implementations as private delegates. The
-- public wrappers expire stale rows first, then run the original locks,
-- ownership checks, package limit and seven-per-day capacity checks.
do $$
begin
  if to_regprocedure('public.manage_client_outreach_slot_v1(text,bigint,text,date)') is null then
    if to_regprocedure('public.manage_client_outreach_slot(text,bigint,text,date)') is null then
      raise exception 'manage_client_outreach_slot is missing';
    end if;
    alter function public.manage_client_outreach_slot(text, bigint, text, date)
      rename to manage_client_outreach_slot_v1;
  end if;

  if to_regprocedure('public.get_client_outreach_calendar_v1(date,date)') is null then
    if to_regprocedure('public.get_client_outreach_calendar(date,date)') is null then
      raise exception 'get_client_outreach_calendar is missing';
    end if;
    alter function public.get_client_outreach_calendar(date, date)
      rename to get_client_outreach_calendar_v1;
  end if;
end;
$$;

revoke all on function public.manage_client_outreach_slot_v1(text, bigint, text, date)
  from public, anon, authenticated;
revoke all on function public.get_client_outreach_calendar_v1(date, date)
  from public, anon, authenticated;

create or replace function public.manage_client_outreach_slot(
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
  slot_row public.client_outreach_slots;
begin
  perform public.expire_past_client_outreach_slots();
  select * into slot_row
  from public.manage_client_outreach_slot_v1(
    p_action, p_slot_id, p_mentor_id, p_target_date
  );
  return slot_row;
end;
$$;

revoke all on function public.manage_client_outreach_slot(text, bigint, text, date)
  from public, anon;
grant execute on function public.manage_client_outreach_slot(text, bigint, text, date)
  to authenticated;

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
  select *
  from public.get_client_outreach_calendar_v1(p_from, p_to);
end;
$$;

revoke all on function public.get_client_outreach_calendar(date, date)
  from public, anon;
grant execute on function public.get_client_outreach_calendar(date, date)
  to authenticated;

select public.expire_past_client_outreach_slots();

notify pgrst, 'reload schema';

commit;
